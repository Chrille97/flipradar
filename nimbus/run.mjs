// Forskningsdata: dagliga kurser för kryptovalutorna i index.html, så långt bakåt Yahoo har (oftast 2017–).
// Körs av arbetsflödet "Nimbus3000 backtest". Skriver nimbus/research/crypto.json. Påverkar inte Flipradar-sidan.
import fs from "node:fs";
import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, "research");
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Yahoo använder andra namn för några mynt
const ALIAS = { TON: "TON11419", SUI: "SUI20947", APT: "APT21794", ARB: "ARB11841", OP: "OP", POL: "POL28321", RENDER: "RENDER", TIA: "TIA22861", SEI: "SEI", STX: "STX4847", IMX: "IMX10603", PEPE: "PEPE24478", UNI: "UNI7083", ICP: "ICP", INJ: "INJ" };
function symbols() {
  const html = fs.readFileSync(path.join(DIR, "..", "index.html"), "utf8");
  const i = html.indexOf("const CRYPTO = ["), j = html.indexOf("];", i);
  return new Function(`return ${html.slice(html.indexOf("[", i), j + 1)}`)().map(r => r[0]);
}
async function get(y) {
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${y}-USD?range=10y&interval=1d&includePrePost=false`, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) { console.log(`  ${y}: HTTP ${r.status} (${host})`); continue; }
      const j = await r.json(), res = j.chart && j.chart.result && j.chart.result[0];
      if (!res || !res.timestamp) continue;
      const q = res.indicators.quote[0], bars = [];
      res.timestamp.forEach((t, k) => { if (q.close[k] != null && q.open[k] != null) bars.push([t, q.open[k], q.high[k], q.low[k], q.close[k], q.volume[k] || 0]); });
      return bars;
    } catch (e) { console.log(`  ${y}: ${e.message}`); }
    await sleep(800);
  }
  return null;
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const out = {}, syms = symbols();
  console.log(`${syms.length} kryptovalutor`);
  for (const s of syms) {
    let bars = await get(ALIAS[s] || s);
    if ((!bars || bars.length < 100) && ALIAS[s]) bars = await get(s);
    if (bars && bars.length >= 100) { out[s] = bars; console.log(`${s}: ${bars.length} dagar från ${new Date(bars[0][0] * 1000).toISOString().slice(0, 10)}`); }
    else console.log(`${s}: ingen data`);
    await sleep(700);
  }
  fs.writeFileSync(path.join(OUT, "crypto.json"), JSON.stringify({ fetched: new Date().toISOString(), cols: ["t", "o", "h", "l", "c", "v"], assets: out }));
  console.log(`Klart: ${Object.keys(out).length} mynt.`);
}
main().catch(e => { console.error(e); process.exit(1); });
