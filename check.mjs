// Flipradar – schemalagd kontroll (körs av GitHub Actions, se .github/workflows/flipradar.yml)
//
// 1. Hämtar dagliga och veckovisa kurser för alla aktier i index.html (även svenska) från
//    Yahoo Finance och sparar dem i data/stocks.json, som webbversionen av Flipradar läser.
// 2. Skickar notiser via ntfy:
//    - när börsläget slår om (trendlinjen på veckografen för S&P 500 eller Bitcoin, stängd vecka)
//    - en gång i veckan (fredag kväll): Veckans plan med köp, sälj och behåll i Köp dippen för Raketen-aktier
//    - när en bevakad aktie (watchlist.json) får köpläge eller säljläge i Köp dippen, eller Sälj studsen
//    Flippar per tillgång ger inte längre notis: i testet sa de inget om fortsättningen.
//
// Tillgångslistorna och trendmotorn läses direkt ur index.html, så sidan och notiserna
// räknar alltid exakt likadant.
//
// Miljövariabler:
//   NTFY_TOPIC      ditt hemliga ntfy-ämne (krävs för notiser)
//   NTFY_SERVER     standard https://ntfy.sh
//   SITE_URL        adressen till din Flipradar-sida (öppnas när du trycker på notisen)
//   PUBLISH_STOCKS  "0" för att inte skriva data/stocks.json
//   DELAY_MS        paus mellan anrop till Yahoo (standard 400)
//   BINANCE_URL, KRAKEN_URL, YAHOO_URL  bas-adresser (för test)

import fs from "node:fs/promises";

const env = process.env;
const BINANCE = env.BINANCE_URL || "https://data-api.binance.vision";
const KRAKEN = env.KRAKEN_URL || "https://api.kraken.com";
const YAHOO = env.YAHOO_URL || "https://query1.finance.yahoo.com";
const NTFY = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
const DELAY = env.DELAY_MS ? Number(env.DELAY_MS) : 400;
const DAY = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- Läs listor och motor ur index.html ----------
const html = await fs.readFile("index.html", "utf8");
const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
function grab(name) {
  const start = js.indexOf("function " + name + "(");
  if (start < 0) throw new Error("Hittar inte " + name + " i index.html");
  let i = js.indexOf("{", start), depth = 0;
  for (; i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) break;
  }
  return js.slice(start, i + 1);
}
const listCode = js.slice(js.indexOf("const CRYPTO = ["), js.indexOf("const DEFAULTS"));
const { ASSETS } = new Function(listCode + "; return { ASSETS };")();
const defLine = js.slice(js.indexOf("const DEFAULTS = "), js.indexOf(";", js.indexOf("const DEFAULTS = ")));
const DEFAULTS = new Function("return " + defLine.replace("const DEFAULTS = ", ""))();
const settings = { atrLen: DEFAULTS.atrLen, mult: DEFAULTS.mult };
const pbwLine = js.slice(js.indexOf("const PBW = "), js.indexOf(";", js.indexOf("const PBW = ")) + 1);
const E = new Function("settings", "DAY",
  "const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;\n" + pbwLine + "\n" +
  ["atrRma", "trendLine", "barClosed", "toWeekly", "rsiSeries", "pullbackWeekOf"].map(grab).join("\n") + "; return { trendLine, barClosed, toWeekly, pullbackWeekOf, PBW };"
)(settings, DAY);
const BY_KEY = Object.fromEntries(ASSETS.map(a => [a.key, a]));

// ---------- Hämtning ----------
async function getJSON(url, opts = {}) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Flipradar)" }, ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status} för ${url}`);
  return r.json();
}

function yahooSymbol(a) {
  const base = a.sym.replace(/\./g, "-");
  return a.ysym || (a.se ? base + ".ST" : base);
}
const dayStart = sec => Math.floor(sec * 1000 / DAY) * DAY;
const monday = t => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;

async function yahooBars(a, interval, range) {
  const j = await getJSON(`${YAHOO}/v8/finance/chart/${encodeURIComponent(yahooSymbol(a))}?interval=${interval}&range=${range}`);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error("Inga kurser från Yahoo");
  const q = res.indicators.quote[0];
  const out = [];
  res.timestamp.forEach((ts, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].some(v => v == null || !isFinite(v))) return;
    let t = dayStart(ts);
    if (interval === "1wk") t = monday(t);
    const prev = out[out.length - 1];
    if (prev && prev.t === t) { prev.h = Math.max(prev.h, h); prev.l = Math.min(prev.l, l); prev.c = c; }
    else out.push({ t, o, h, l, c });
  });
  return out;
}

async function cryptoBars(a) {
  try {
    const k = async iv => (await getJSON(`${BINANCE}/api/v3/klines?symbol=${a.pair}&interval=${iv}&limit=${iv === "1w" ? 300 : 400}`))
      .map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
    return { w: await k("1w"), d: await k("1d") };
  } catch (e) {
    // Reserv: Kraken (dagsdata, veckor byggs från måndag som hos Binance)
    const ks = { BTC: "XBT", DOGE: "XDG" }[a.sym] || a.sym;
    const j = await getJSON(`${KRAKEN}/0/public/OHLC?pair=${ks}USD&interval=1440`);
    if (j.error && j.error.length) throw new Error(j.error.join(", "));
    const key = Object.keys(j.result).find(x => x !== "last");
    const d = j.result[key].map(x => ({ t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
    return { d: d.slice(-400), w: E.toWeekly(d) };
  }
}

// ---------- Trend på stängd stapel (samma som "bekräftad" i Flipradar) ----------
function closedTrend(bars, tf, a) {
  if (!bars || bars.length < settings.atrLen + 2) return null;
  const { line, dirs } = E.trendLine(bars, settings.atrLen, settings.mult);
  const L = bars.length - 1;
  const ci = E.barClosed(bars[L].t, tf, a, Date.now()) ? L : L - 1;
  if (dirs[ci] == null) return null;
  return { dir: dirs[ci], line: line[L], close: bars[L].c };
}

const fmt = v => new Intl.NumberFormat("sv-SE", v >= 1000 ? { maximumFractionDigits: 0 } : v >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 }).format(v);

async function notify(title, message, dir, priority = 4) {
  if (!env.NTFY_TOPIC) { log("  (ingen NTFY_TOPIC satt, hoppar över notis)"); return; }
  const body = { topic: env.NTFY_TOPIC, title, message, tags: [dir === 1 ? "chart_with_upwards_trend" : "chart_with_downwards_trend"], priority };
  if (env.SITE_URL) body.click = env.SITE_URL;
  const r = await fetch(NTFY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) log("  ntfy svarade", r.status);
}

// ---------- Kör ----------
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } };
const watchlist = (await readJSON("watchlist.json", [])).filter(k => {
  if (!BY_KEY[k]) { log(`Okänd tillgång i watchlist.json: ${k} (hoppar över)`); return false; }
  return true;
});
const state = await readJSON("state.json", {});
const stockData = {};
const pack = bars => bars.map(b => [Math.round(b.t / 1000), +b.o.toPrecision(6), +b.h.toPrecision(6), +b.l.toPrecision(6), +b.c.toPrecision(6)]);

// 1. Aktier
const publish = env.PUBLISH_STOCKS !== "0";
const stocks = ASSETS.filter(a => a.type === "aktie" && (publish || watchlist.includes(a.key)));
log(`Hämtar ${stocks.length} aktier från Yahoo Finance…`);
let okStocks = 0;
for (const a of stocks) {
  try {
    const d = await yahooBars(a, "1d", "2y");
    await sleep(DELAY);
    const w = await yahooBars(a, "1wk", "10y");
    stockData[a.key] = { d, w };
    okStocks++;
  } catch (e) {
    log(`  ${a.sym}: ${e.message}`);
  }
  await sleep(DELAY);
}
log(`  ${okStocks} av ${stocks.length} aktier hämtade.`);
// Nästa rapportdatum. Yahoo kräver kaka och "crumb" för kalenderdata. Misslyckas det hoppar vi över rapportdatumen.
async function yahooAuth() {
  try {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
    const r = await fetch(env.COOKIE_URL || "https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual" });
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
    const cookie = raw.map(c => c.split(";")[0]).filter(Boolean).join("; ");
    if (!cookie) return null;
    const cr = await fetch(`${YAHOO2}/v1/test/getcrumb`, { headers: { "User-Agent": UA, Cookie: cookie } });
    const crumb = cr.ok ? await cr.text() : "";
    return crumb && crumb.length < 40 && !crumb.includes("<") ? { cookie, crumb, UA } : null;
  } catch { return null; }
}
const YAHOO2 = env.YAHOO2_URL || "https://query2.finance.yahoo.com";
if (publish && okStocks) {
  const auth = await yahooAuth();
  let nEr = 0;
  if (auth) {
    for (const a of stocks) {
      if (!stockData[a.key] || a.etf) continue;
      try {
        const r = await fetch(`${YAHOO2}/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol(a))}?modules=calendarEvents&crumb=${encodeURIComponent(auth.crumb)}`, { headers: { "User-Agent": auth.UA, Cookie: auth.cookie } });
        if (r.ok) {
          const m = (await r.json())?.quoteSummary?.result?.[0];
          const ds = (m?.calendarEvents?.earnings?.earningsDate || []).map(x => x.raw).filter(x => x && x * 1000 > Date.now() - DAY);
          if (ds.length) { stockData[a.key].er = Math.min(...ds); nEr++; }
        }
      } catch {}
      await sleep(Math.min(DELAY, 200));
    }
  }
  log(auth ? `  Rapportdatum för ${nEr} aktier.` : "  Kunde inte hämta rapportdatum (ingen åtkomst).");
  const out = { updated: new Date().toISOString(), source: "Yahoo Finance", assets: {} };
  for (const [k, v] of Object.entries(stockData)) { out.assets[k] = { d: pack(v.d.slice(-400)), w: pack(v.w) }; if (v.er) out.assets[k].er = v.er; }
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/stocks.json", JSON.stringify(out));
  log("Skrev data/stocks.json");
}

// 2. Notiser
// Gammalt format (flipp-läge per tillgång) byts mot { idx: {...}, rekyl: {...} }.
for (const k of Object.keys(state)) if (!["idx", "rekyl", "studs", "weekly"].includes(k)) delete state[k];
state.idx = state.idx || {}; state.rekyl = state.rekyl || {};
let sent = 0;
const firstRun = !Object.keys(state.rekyl).length;

// 2a. Börsläge
const IDX = [["SPY", "S&P 500"], ["c:BTC", "Bitcoin"]]; // OMXS30 borttaget: börsläget skyddade inte i testet
for (const [key, nm] of IDX) {
  const a = BY_KEY[key];
  if (!a) continue;
  let bars;
  try { bars = a.type === "krypto" ? await cryptoBars(a) : stockData[key]; } catch (e) { log(`  ${nm}: ${e.message}`); continue; }
  const tr = bars && closedTrend(bars.w, "w", a);
  if (!tr) { log(`  ${nm}: ingen data`); continue; }
  const prev = state.idx[key];
  if (prev != null && prev !== tr.dir) {
    const title = `Börsläge ${nm}: ${tr.dir === 1 ? "risk på" : "risk av"}`;
    const msg = tr.dir === 1 ? `Trendlinjen på veckografen vände upp (${fmt(tr.close)}). Slår om igen under ${fmt(tr.line)}.`
      : `Trendlinjen på veckografen vände ner (${fmt(tr.close)}). Överväg att minska risken. Slår om igen över ${fmt(tr.line)}.`;
    log("  " + title + " – " + msg); await notify(title, msg, tr.dir, 5); sent++;
  }
  state.idx[key] = tr.dir;
}

// 2b. Raketen-rang (52 till 4 veckor sedan, inom USA respektive Sverige), som på sidan. off = antal veckor bakåt.
function rankAt(off) {
  const out = {};
  for (const g of [true, false]) {
    const L = [];
    for (const a of ASSETS) {
      if (a.type !== "aktie" || a.etf || !!a.se !== g || !stockData[a.key] || !stockData[a.key].w || stockData[a.key].w.length < 60) continue;
      const b = stockData[a.key].w, n = b.length, last = (E.barClosed(b[n - 1].t, "w", a, Date.now()) ? n - 1 : n - 2) - off;
      if (last - 52 < 0) continue;
      const m = b[last - 4].c / b[last - 52].c - 1;
      if (isFinite(m)) L.push([a.key, m]);
    }
    if (L.length < 10) continue;
    L.sort((x, y) => x[1] - y[1]);
    L.forEach(([k], i) => { out[k] = { top: i / (L.length - 1) >= 0.8, pct: i / (L.length - 1) }; });
  }
  return out;
}
const RK = [0, 1, 2, 3, 4, 5].map(rankAt);
const rk = Object.fromEntries(Object.entries(RK[0]).map(([k, v]) => [k, v.top]));
const raketAt = (key, off) => { const r = RK[Math.min(5, Math.max(0, off))][key]; return !!r && r.top; };

// 2c. Köp dippen (månadsrekyl): veckans plan för Raketen-aktier, och notiser för bevakade aktier
const PLAN = { SE: { signal: [], open: [], exit: [], none: [] }, US: { signal: [], open: [], exit: [], none: [] } };
log(`Kontrollerar månadsrekyl för ${Object.keys(stockData).length} aktier (${watchlist.length} bevakade)…`);
for (const a of ASSETS) {
  if (a.type !== "aktie" || a.etf || !stockData[a.key] || !stockData[a.key].w || stockData[a.key].w.length < 60) continue;
  const p = E.pullbackWeekOf(stockData[a.key].w, a);
  if (!p) continue;
  {
    const off = p.state === "signal" ? 0 : p.state === "open" ? p.held : p.state === "exit" ? Math.round((p.closedT - p.entryT) / (7 * DAY)) + 1 : null;
    if (off != null && raketAt(a.key, off)) PLAN[a.se ? "SE" : "US"][p.state].push({ a, p, pct: (RK[0][a.key] || {}).pct || 0 });
  }
  const sig = p.state === "signal" ? "s" + p.closedT : p.state === "exit" ? "x" + p.entryT : "";
  const prev = state.rekyl[a.key];
  state.rekyl[a.key] = sig;
  const watched = watchlist.includes(a.key), raket = !!rk[a.key];
  // Sälj studsen (bevakade aktier): under 40-veckorsmedlet och vecko-RSI(2) över 90 på stängd vecka
  state.studs = state.studs || {};
  const studs = p.closeW < p.sma && p.rsi > 90 ? "s" + p.closedT : "";
  const prevS = state.studs[a.key];
  state.studs[a.key] = studs;
  if (watched && !firstRun && prevS !== undefined && studs && prevS !== studs) {
    const title = `${a.sym}: sälj studsen`;
    const msg = `${a.name} ligger under sitt 40-veckorsmedel men steg kraftigt förra veckan (${fmt(p.closeW)}). Äger du aktien är det ett bra tillfälle att sälja och flytta pengarna till indexfonden.`;
    log("  " + title + " – " + msg); await notify(title, msg, -1); sent++;
  }
  if (firstRun || prev === undefined || prev === sig || !sig) continue;
  // Köp dippen i Raketen-aktier kommer i veckans plan (nedan). Här: svag dipp och sälj för bevakade aktier utanför den.
  if (p.state === "signal" && watched && !raket) {
    const title = `${a.sym}: svag dipp (inte i Raketen)`;
    const msg = `${a.name}. Köp ca ${fmt(p.entry)} när börsen öppnar, stop loss ${fmt(p.stop)}, sälj efter ${E.PBW.hold} veckor.`;
    log("  " + title + " – " + msg); await notify(title, msg, 1); sent++;
  } else if (p.state === "exit" && watched && !raketAt(a.key, Math.round((p.closedT - p.entryT) / (7 * DAY)) + 1)) {
    const title = `${a.sym}: sälj dippköpet`;
    const msg = `${a.name}. ${p.why === "stop" ? "Stop loss gick." : `${E.PBW.hold} veckor har gått, sälj när börsen öppnar.`} Resultat enligt regeln ${(p.result * 100).toFixed(1).replace(".", ",")} %.`;
    log("  " + title + " – " + msg); await notify(title, msg, -1); sent++;
  }
}
// 2d. Veckans plan: en notis när en ny vecka har stängt (fredag kväll), så att ordrarna kan läggas i helgen
{
  const spy = stockData["SPY"] && stockData["SPY"].w, A = BY_KEY["SPY"];
  if (spy && spy.length > 2) {
    const n = spy.length, wt = E.barClosed(spy[n - 1].t, "w", A, Date.now()) ? spy[n - 1].t : spy[n - 2].t;
    if (state.weekly !== wt && !firstRun) {
      const nm = x => `${x.a.name} (${x.a.sym})`;
      const lines = [];
      for (const [m, rubrik, open] of [["SE", "Sverige", "när Stockholmsbörsen öppnar 09.00"], ["US", "USA", "när New York öppnar 15.30 svensk tid"]]) {
        const P = PLAN[m], buys = P.signal.sort((x, y) => y.pct - x.pct);
        if (!buys.length && !P.exit.length && !P.open.length) continue;
        lines.push(`${rubrik}:`);
        buys.forEach(x => lines.push(`KÖP måndag ${open}: ${nm(x)} ca ${fmt(x.p.entry)}, lägg stop loss ${fmt(x.p.stop)} direkt.`));
        P.exit.forEach(x => lines.push(`SÄLJ måndag om du köpte: ${nm(x)}, ${x.p.why === "stop" ? "stop loss har gått" : `${E.PBW.hold} veckor har gått`} (${(x.p.result * 100).toFixed(1).replace(".", ",")} %).`));
        P.open.forEach(x => lines.push(`Behåll om du köpte: ${nm(x)}, vecka ${x.p.held} av ${E.PBW.hold}, stop loss ${fmt(x.p.stop)}.`));
      }
      const idx = IDX.map(([k, n2]) => state.idx[k] == null ? null : `${n2} ${state.idx[k] === 1 ? "risk på" : "risk av"}`).filter(Boolean).join(", ");
      const msg = (lines.length ? lines.join("\n") + "\nBelopp per köp: en lika stor del av lekkassan, se Kontoplanen. Har du redan max antal affärer står du över de sista köpen." : "Inga köp eller sälj i Köp dippen den här veckan. Allt ligger kvar i indexfonden.") + (idx ? `\nBörsläge: ${idx}.` : "");
      log("  Veckans plan –\n" + msg);
      await notify("Veckans plan: Köp dippen", msg, 1, PLAN.SE.signal.length + PLAN.US.signal.length + PLAN.SE.exit.length + PLAN.US.exit.length ? 4 : 2); sent++;
    }
    state.weekly = wt;
  }
}
await fs.writeFile("state.json", JSON.stringify(state, null, 2) + "\n");
log(`Klart. ${sent} notiser.`);
