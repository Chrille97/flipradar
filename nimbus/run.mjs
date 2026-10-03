// Forskningsdata till Flipradar: tio års dagskurser med volym och rapportdatum för alla aktier i index.html.
// Körs av arbetsflödet "Nimbus3000 backtest" (Actions → Run workflow). Skriver nimbus/research/.
// Påverkar inte Flipradar-sidan.
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, "research");
const YAHOO = process.env.YAHOO_URL || "https://query1.finance.yahoo.com";
const YAHOO2 = process.env.YAHOO2_URL || "https://query2.finance.yahoo.com";
const COOKIE_URL = process.env.COOKIE_URL || "https://fc.yahoo.com";
const DELAY = Number(process.env.DELAY_MS ?? 250);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Aktielistan läses ur index.html så att den alltid stämmer med sidan
function symbols() {
  const html = fs.readFileSync(path.join(DIR, "..", "index.html"), "utf8");
  const grab = name => { const i = html.indexOf(`const ${name} = [`); if (i < 0) return []; const j = html.indexOf("];", i); return new Function(`return ${html.slice(html.indexOf("[", i), j + 1)}`)(); };
  const y = (s, se) => s.replace(/\./g, "-") + (se ? ".ST" : "");
  return [...grab("STOCKS").map(r => ({ sym: r[0], y: y(r[0], false) })), ...grab("SWEDEN").map(r => ({ sym: r[0] + "@XSTO", y: y(r[0], true) }))];
}
async function get(url, headers = {}) {
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
      if (r.ok) return r;
      last = new Error("HTTP " + r.status);
      if (r.status === 404 || r.status === 400 || r.status === 401) break;
    } catch (e) { last = e; }
    await sleep(1200 * (a + 1));
  }
  throw last;
}
// Yahoo kräver kaka + "crumb" för kalenderdata. Misslyckas det fortsätter vi utan.
async function crumb() {
  try {
    const r = await fetch(COOKIE_URL, { headers: { "User-Agent": UA }, redirect: "manual" });
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
    const cookie = raw.map(c => c.split(";")[0]).filter(Boolean).join("; ");
    if (!cookie) return null;
    const c = await (await get(`${YAHOO2}/v1/test/getcrumb`, { Cookie: cookie })).text();
    return c && c.length < 40 && !c.includes("<") ? { cookie, crumb: c } : null;
  } catch { return null; }
}
const r4 = x => x == null ? null : +x.toPrecision(7);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const list = symbols(), auth = await crumb(), summary = { fetched: new Date().toISOString(), crumb: !!auth, assets: {} };
  console.log(`${list.length} aktier. Kalenderåtkomst: ${auth ? "ja" : "nej"}`);
  for (const a of list) {
    const s = summary.assets[a.sym] = {};
    try {
      const j = await (await get(`${YAHOO}/v8/finance/chart/${encodeURIComponent(a.y)}?interval=1d&range=10y&events=${encodeURIComponent("div|split|earn")}`)).json();
      const r = j?.chart?.result?.[0]; if (!r || !r.timestamp) throw new Error("tomt svar");
      const q = r.indicators.quote[0], rows = [];
      r.timestamp.forEach((t, i) => { if (q.close[i] != null && q.open[i] != null) rows.push([t, r4(q.open[i]), r4(q.high[i]), r4(q.low[i]), r4(q.close[i]), q.volume[i] || 0]); });
      const ev = r.events || {};
      const earn = Object.values(ev.earnings || {}).map(e => e.date).filter(Boolean).sort((x, y) => x - y);
      const out = { sym: a.sym, y: a.y, tz: r.meta.exchangeTimezoneName, bars: rows, earn, eventKeys: Object.keys(ev), earnSample: Object.values(ev.earnings || {})[0] || null };
      Object.assign(s, { bars: rows.length, earnChart: earn.length });
      if (auth) {
        try {
          const qs = await (await get(`${YAHOO2}/v10/finance/quoteSummary/${encodeURIComponent(a.y)}?modules=calendarEvents,earningsHistory,earnings&crumb=${encodeURIComponent(auth.crumb)}`, { Cookie: auth.cookie })).json();
          const m = qs?.quoteSummary?.result?.[0] || {};
          out.next = (m.calendarEvents?.earnings?.earningsDate || []).map(d => d.raw).filter(Boolean);
          out.hist = (m.earningsHistory?.history || []).map(h => ({ q: h.quarter?.raw, surprise: h.surprisePercent?.raw })).filter(h => h.q);
          Object.assign(s, { next: out.next.length, hist: out.hist.length });
        } catch (e) { s.qsErr = e.message; }
      }
      fs.writeFileSync(path.join(OUT, a.y.replace(/[^A-Za-z0-9.-]/g, "_") + ".json"), JSON.stringify(out));
    } catch (e) { s.err = e.message; }
    console.log(a.sym, JSON.stringify(s));
    await sleep(DELAY);
  }
  const A = Object.values(summary.assets);
  summary.totals = { ok: A.filter(x => x.bars).length, failed: A.filter(x => x.err).length, withChartEarnings: A.filter(x => x.earnChart > 0).length, withNext: A.filter(x => x.next > 0).length, withHist: A.filter(x => x.hist > 0).length };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary.totals));
}
main().catch(e => { console.error(e); process.exit(1); });
