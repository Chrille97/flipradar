// Nimbus3000 – hämtar ett års timdata, kör backtesten och skriver nimbus/results/.
// Krypto: Binance publika data (samma priser som Kraken inom några promille; avgifter räknas som Kraken).
// Aktier: Yahoo Finance timstaplar (ordinarie handelstid).
// Körs av .github/workflows/nimbus.yml. Lokalt: node nimbus/run.mjs  (--offline = använd sparad data)
import fs from "node:fs";
import path from "node:path";
import { backtest } from "./engine.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const DATA = path.join(DIR, "data"), OUT = path.join(DIR, "results");
const BINANCE = process.env.BINANCE_URL || "https://data-api.binance.vision";
const YAHOO = process.env.YAHOO_URL || "https://query1.finance.yahoo.com";
const OFFLINE = process.argv.includes("--offline");
const NOW = process.env.NOW ? Number(process.env.NOW) : Math.floor(Date.now() / 1000);
const YEAR = 365 * 86400, START = NOW - YEAR;

export const CRYPTO = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LINK", "AVAX", "DOT", "LTC"];
export const STOCKS = [
  ["NVDA", "NVDA"], ["TSLA", "TSLA"], ["AAPL", "AAPL"], ["AMD", "AMD"], ["META", "META"],
  ["PLTR", "PLTR"], ["COIN", "COIN"], ["MSTR", "MSTR"], ["VOLV B", "VOLV-B.ST"], ["SAAB B", "SAAB-B.ST"],
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (nimbus3000 backtest)" } });
      if (r.ok) return await r.json();
      if (r.status === 404 || r.status === 400) throw new Error(`HTTP ${r.status}`);
    } catch (e) { if (a === 3) throw e; }
    await sleep(1500 * (a + 1));
  }
  throw new Error("misslyckades: " + url);
}
async function fetchCrypto(sym) {
  const out = []; let t = (START - 120 * 86400) * 1000; // 120 dagars uppvärmning för dagstrenden
  while (t < NOW * 1000) {
    const k = await getJson(`${BINANCE}/api/v3/klines?symbol=${sym}USDT&interval=1h&startTime=${t}&limit=1000`);
    if (!Array.isArray(k) || !k.length) break;
    for (const r of k) out.push([Math.floor(r[0] / 1000), +r[1], +r[2], +r[3], +r[4], +r[5]]);
    const nt = k[k.length - 1][0] + 3600e3; if (nt <= t) break; t = nt;
    await sleep(150);
  }
  // Ta bort stapeln som pågår just nu
  while (out.length && out[out.length - 1][0] + 3600 > NOW) out.pop();
  return { type: "crypto", tz: "UTC", bars: out };
}
async function fetchStock(ysym) {
  const p1 = NOW - 725 * 86400;
  const j = await getJson(`${YAHOO}/v8/finance/chart/${encodeURIComponent(ysym)}?interval=1h&period1=${p1}&period2=${NOW}&includePrePost=false`);
  const r = j?.chart?.result?.[0]; if (!r) throw new Error("tomt svar för " + ysym);
  const q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((t, i) => { if (q.close[i] != null && q.open[i] != null) out.push([t, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] || 0]); });
  // Sista stapeln kan vara ofullständig om börsen är öppen
  return { type: "stock", tz: r.meta.exchangeTimezoneName, bars: out };
}

async function load() {
  fs.mkdirSync(DATA, { recursive: true });
  const assets = [];
  const jobs = [...CRYPTO.map(s => ({ name: s, file: s, type: "crypto", f: () => fetchCrypto(s) })),
    ...STOCKS.map(([n, y]) => ({ name: n, file: y, type: "stock", f: () => fetchStock(y) }))];
  for (const j of jobs) {
    const fp = path.join(DATA, j.file.replace(/[^A-Za-z0-9.-]/g, "_") + ".json");
    let d = null;
    if (OFFLINE && fs.existsSync(fp)) d = JSON.parse(fs.readFileSync(fp, "utf8"));
    else {
      try { d = await j.f(); fs.writeFileSync(fp, JSON.stringify(d)); console.log(`${j.name}: ${d.bars.length} timstaplar`); }
      catch (e) { console.log(`${j.name}: FEL ${e.message}`); if (fs.existsSync(fp)) d = JSON.parse(fs.readFileSync(fp, "utf8")); }
    }
    if (d && d.bars.length > 500) assets.push({ ...j, ...d, bars: d.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })) });
  }
  return assets;
}

// Avgifter per sida. Kraken spot: 0,40 % taker på lägsta nivån (0,25 % maker). Aktier: courtage + spread ≈ 0,05 %.
const FEES = { crypto: { fee: 0.004, slip: 0.0005 }, stock: { fee: 0.0005, slip: 0.0005 } };
const VARIANTS = [
  { id: "bas", label: "Nimbus3000 (Kraken taker 0,40 %)", opt: t => FEES[t] },
  { id: "maker", label: "Med limitorder (Kraken maker 0,25 %)", opt: t => t === "crypto" ? { fee: 0.0025, slip: 0 } : { fee: 0.0005, slip: 0.0002 } },
  { id: "noll", label: "Utan avgifter (ren signalkvalitet)", opt: () => ({ fee: 0, slip: 0 }) },
  { id: "lang", label: "Bara köp, ingen blankning", opt: t => ({ ...FEES[t], allowShort: false }) },
  { id: "A", label: "Bara modul A (utbrott)", opt: t => ({ ...FEES[t], modules: "A" }) },
  { id: "B", label: "Bara modul B (rekyl)", opt: t => ({ ...FEES[t], modules: "B" }) },
];

const pct = x => (x == null || !isFinite(x)) ? "–" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + " %";
const pp = x => (x * 100).toFixed(0) + " %";
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

async function main() {
  const assets = await load();
  const res = {};
  for (const v of VARIANTS) res[v.id] = assets.map(a => ({ name: a.name, type: a.type, ...backtest(a.bars, a.type, a.tz, START, v.opt(a.type)) }));
  fs.mkdirSync(OUT, { recursive: true });
  const d = t => new Date(t * 1000).toISOString().slice(0, 10);
  let md = `# Nimbus3000 – backtest ${d(START)} → ${d(NOW)}\n\nTimstaplar. Start 1,0 per tillgång, 1 % risk per affär, ingen hävstång.\n\n`;
  md += `## Sammanfattning per variant\n\n| Variant | Grupp | Medelavkastning | Median | Slår köp & behåll | Positiva | Medel max-nedgång | Affärer/tillgång | Vinst-% | PF |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const v of VARIANTS) for (const g of ["crypto", "stock"]) {
    const R = res[v.id].filter(r => r.type === g); if (!R.length) continue;
    const rets = R.map(r => r.ret).sort((a, b) => a - b), all = R.flatMap(r => r.trades);
    const gp = all.filter(t => t.pnl > 0).reduce((x, t) => x + t.pnl, 0), gl = -all.filter(t => t.pnl <= 0).reduce((x, t) => x + t.pnl, 0);
    md += `| ${v.label} | ${g === "crypto" ? "Krypto" : "Aktier"} | ${pct(avg(rets))} | ${pct(rets[rets.length >> 1])} | ${R.filter(r => r.ret > r.bh).length}/${R.length} | ${R.filter(r => r.ret > 0).length}/${R.length} | ${pp(avg(R.map(r => r.mdd)))} | ${avg(R.map(r => r.all.n)).toFixed(0)} | ${pp(all.filter(t => t.pnl > 0).length / (all.length || 1))} | ${(gl ? gp / gl : 0).toFixed(2)} |\n`;
  }
  md += `\n## Per tillgång (basvarianten)\n\n| Tillgång | Nimbus | Max-nedgång | Köp & behåll | B&H nedgång | Affärer | Vinst-% | PF | Snitt-R | Avgifter | Tid i marknaden |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of res.bas) md += `| ${r.name} | ${pct(r.ret)} | ${pp(r.mdd)} | ${pct(r.bh)} | ${pp(r.bhDd)} | ${r.all.n} | ${pp(r.all.win)} | ${r.all.pf.toFixed(2)} | ${r.all.avgR.toFixed(2)} | ${pp(r.fees)} | ${pp(r.exposure)} |\n`;
  fs.writeFileSync(path.join(OUT, "report.md"), md);
  const slim = Object.fromEntries(Object.entries(res).map(([k, R]) => [k, R.map(({ trades, ...r }) => r)]));
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ start: START, end: NOW, results: slim }, null, 1));
  const csv = ["tillgang,modul,sida,in,ut,inpris,utpris,R,pnl,orsak"].concat(res.bas.flatMap(r => r.trades.map(t =>
    [r.name, t.mod, t.side === 1 ? "kop" : "blank", new Date(t.t * 1000).toISOString(), new Date(t.tx * 1000).toISOString(), t.entry.toPrecision(6), t.exit.toPrecision(6), t.r.toFixed(2), t.pnl.toFixed(5), t.why].join(","))));
  fs.writeFileSync(path.join(OUT, "trades.csv"), csv.join("\n"));
  console.log(md);
}
main().catch(e => { console.error(e); process.exit(1); });
