// Forskningsdata: analytikernas höjningar och sänkningar (Yahoo Finance) för aktierna i index.html.
// Körs av arbetsflödet "Nimbus3000 backtest" (Actions → Run workflow). Skriver nimbus/research/analyst.json.
// Påverkar inte Flipradar-sidan.
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, "research");
const YAHOO2 = process.env.YAHOO2_URL || "https://query2.finance.yahoo.com";
const COOKIE_URL = process.env.COOKIE_URL || "https://fc.yahoo.com";
const DELAY = Number(process.env.DELAY_MS ?? 400);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function symbols() {
  const html = fs.readFileSync(path.join(DIR, "..", "index.html"), "utf8");
  const grab = name => { const i = html.indexOf(`const ${name} = [`); if (i < 0) return []; const j = html.indexOf("];", i); return new Function(`return ${html.slice(html.indexOf("[", i), j + 1)}`)(); };
  const y = (s, se) => s.replace(/\./g, "-") + (se ? ".ST" : "");
  return [...grab("STOCKS").filter(r => !r[3]).map(r => ({ sym: r[0], y: y(r[0], false) })),
          ...grab("SWEDEN").filter(r => !r[3]).map(r => ({ sym: r[0] + "@XSTO", y: y(r[0], true) }))];
}
async function auth() {
  try {
    const r = await fetch(COOKIE_URL, { headers: { "User-Agent": UA }, redirect: "manual" });
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
    const cookie = raw.map(c => c.split(";")[0]).filter(Boolean).join("; ");
    if (!cookie) return null;
    const c = await (await fetch(`${YAHOO2}/v1/test/getcrumb`, { headers: { "User-Agent": UA, Cookie: cookie } })).text();
    return c && c.length < 40 && !c.includes("<") ? { cookie, crumb: c } : null;
  } catch { return null; }
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const list = symbols(), a = await auth(), out = { fetched: new Date().toISOString(), auth: !!a, assets: {}, errors: {} };
  console.log(`${list.length} aktier. Åtkomst: ${a ? "ja" : "nej"}`);
  if (!a) { fs.writeFileSync(path.join(OUT, "analyst.json"), JSON.stringify(out)); return; }
  for (const s of list) {
    try {
      const url = `${YAHOO2}/v10/finance/quoteSummary/${encodeURIComponent(s.y)}?modules=upgradeDowngradeHistory,recommendationTrend,financialData&crumb=${encodeURIComponent(a.crumb)}`;
      let r;
      for (let k = 0; k < 3; k++) { r = await fetch(url, { headers: { "User-Agent": UA, Cookie: a.cookie } }); if (r.status !== 429 && r.status < 500) break; await sleep(3000 * (k + 1)); }
      if (!r.ok) { out.errors[s.sym] = `HTTP ${r.status}`; continue; }
      const m = (await r.json())?.quoteSummary?.result?.[0] || {};
      const h = (m.upgradeDowngradeHistory?.history || []).map(x => [x.epochGradeDate, x.firm || "", x.fromGrade || "", x.toGrade || "", x.action || "", x.priceTargetAction || "", x.currentPriceTarget ?? null, x.priorPriceTarget ?? null]);
      out.assets[s.sym] = { y: s.y, hist: h, trend: m.recommendationTrend?.trend || [], target: m.financialData?.targetMeanPrice?.raw ?? null, rec: m.financialData?.recommendationKey ?? null, nAnalysts: m.financialData?.numberOfAnalystOpinions?.raw ?? null };
      console.log(s.sym, h.length, "händelser");
    } catch (e) { out.errors[s.sym] = e.message; }
    await sleep(DELAY);
  }
  out.cols = ["tid", "firma", "fran", "till", "handling", "riktkursHandling", "riktkurs", "tidigareRiktkurs"];
  fs.writeFileSync(path.join(OUT, "analyst.json"), JSON.stringify(out));
  const n = Object.values(out.assets).reduce((x, v) => x + v.hist.length, 0);
  console.log(`Klart: ${Object.keys(out.assets).length} aktier, ${n} händelser, ${Object.keys(out.errors).length} fel.`);
}
main().catch(e => { console.error(e); process.exit(1); });
