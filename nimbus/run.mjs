// Forskningsdata: omvärldsindikatorer för prognosmodellen.
//  Sverige: Konjunkturinstitutets barometer per bransch (månadsvis sedan 1996), Riksbankens räntor.
//  USA:     FRED (amerikanska centralbanken i St. Louis): industri, bygg, räntor, kreditvillkor, hushåll, olja.
// Körs av arbetsflödet "Nimbus3000 backtest". Skriver nimbus/research/macro.json. Påverkar inte Flipradar-sidan.
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname), OUT = path.join(DIR, "research");
const KI = process.env.KI_URL || "https://statistik.konj.se/PxWeb/api/v1/sv/KonjBar/indikatorer/Indikatorm.px";
const FRED = process.env.FRED_URL || "https://fred.stlouisfed.org/graph/fredgraph.csv";
const RB = process.env.RB_URL || "https://api.riksbank.se/swea/v1/Observations";
const UA = "Mozilla/5.0 (Flipradar research; +https://github.com/Chrille97/flipradar)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Konjunkturinstitutet: konfidensindikatorer (säsongsrensade nettotal)
const KI_SERIES = ["KIFI", "BTOT", "BTVI", "BINVE", "BINTM", "BCONS", "B21000", "B24000", "B26000", "B28000", "B29000",
  "BBYG", "B41000", "B42000", "BHAN", "BDHAN", "BTJA", "B62000", "B64XXX", "B71120", "B71100", "B68YYY", "bhus"];
// FRED: id → beskrivning
const FRED_SERIES = {
  INDPRO: "USA industriproduktion", TTLCONS: "USA byggutgifter totalt", HOUST: "USA påbörjade bostäder", PERMIT: "USA bygglov",
  GACDFSA066MSFRBPHI: "Philadelphia Fed industriindex", CFNAI: "Chicago Fed aktivitetsindex", UMCSENT: "USA hushållens förtroende",
  ICSA: "USA nya arbetslösa", UNRATE: "USA arbetslöshet", DGS10: "USA 10-årsränta", DGS2: "USA 2-årsränta", T10Y2Y: "Räntekurva 10-2",
  FEDFUNDS: "USA styrränta", NFCI: "Finansiella villkor (Chicago Fed)", DCOILWTICO: "Olja WTI", DTWEXBGS: "Dollarindex",
  M2SL: "USA penningmängd M2", WALCL: "Fed balansräkning", RSAFS: "USA detaljhandel", PCOPPUSDM: "Kopparpris",
};
const RB_SERIES = { SECBREPOEFF: "Riksbankens styrränta", SEGVB10YC: "Svensk 10-årsränta", SEGVB2YC: "Svensk 2-årsränta", SEKUSDPMI: "USD/SEK" };

async function get(url, opt = {}) {
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch(url, { ...opt, headers: { "User-Agent": UA, ...(opt.headers || {}) } }); if (r.ok) return await r.text(); if (r.status === 404 || r.status === 400) return { err: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }; }
    catch (e) { if (a === 2) return { err: e.message }; }
    await sleep(2000 * (a + 1));
  }
  return { err: "misslyckades" };
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const out = { fetched: new Date().toISOString(), ki: {}, fred: {}, rb: {}, errors: {}, info: { fred: FRED_SERIES, rb: RB_SERIES } };
  // 1. Konjunkturinstitutet (PxWeb). Hämtar först tabellens beskrivning och bygger frågan utifrån den.
  const meta = await get(KI);
  if (typeof meta !== "string") out.errors.kiMeta = meta.err;
  else {
    let md; try { md = JSON.parse(meta); } catch { out.errors.kiMeta = "tolkning: " + meta.slice(0, 200); }
    if (md) {
      out.info.kiMeta = md.variables.map(v => ({ code: v.code, text: v.text, time: !!v.time, n: v.values.length, first: v.values.slice(0, 12), firstText: (v.valueTexts || []).slice(0, 12) }));
      const q = md.variables.map(v => {
        if (v.time) return { code: v.code, selection: { filter: "item", values: v.values } };
        if (/indikator/i.test(v.code)) { const want = v.values.filter(x => KI_SERIES.includes(x)); return { code: v.code, selection: { filter: "item", values: want.length ? want : v.values } }; }
        // andra variabler: välj säsongsrensad serie om det finns, annars första värdet
        const pick = v.values.includes("S") ? "S" : v.values[0];
        return { code: v.code, selection: { filter: "item", values: [pick] } };
      });
      const t = await get(KI, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q, response: { format: "json" } }) });
      if (typeof t !== "string") out.errors.ki = t.err + " · fråga: " + JSON.stringify(q).slice(0, 300);
      else {
        try {
          const j = JSON.parse(t), cols = j.columns.map(c => c.code);
          const iI = cols.findIndex(c => /indikator/i.test(c)), iP = cols.findIndex(c => md.variables.find(v => v.code === c && v.time));
          for (const row of j.data) { const id = row.key[iI], per = row.key[iP], raw = row.values[0], val = +raw; if (raw !== ".." && raw !== "" && !isNaN(val)) (out.ki[id] ||= []).push([per, val]); }
          for (const k in out.ki) out.ki[k].sort((a, b) => a[0] < b[0] ? -1 : 1);
          out.info.kiText = Object.fromEntries(md.variables.find(v => /indikator/i.test(v.code)).values.map((c, k) => [c, md.variables.find(v => /indikator/i.test(v.code)).valueTexts[k]]));
          console.log(`Konjunkturinstitutet: ${Object.keys(out.ki).length} serier`);
        } catch (e) { out.errors.ki = "tolkning: " + e.message + " · " + t.slice(0, 200); }
      }
    }
  }
  // 2. FRED (CSV utan nyckel)
  for (const id of Object.keys(FRED_SERIES).filter(id => !process.env.SKIP_FRED)) {
    const c = await get(`${FRED}?id=${id}&cosd=2005-01-01`);
    if (typeof c !== "string") { out.errors["fred:" + id] = c.err; continue; }
    const rows = c.trim().split("\n").slice(1).map(l => l.split(",")).filter(r => r[1] && r[1] !== "." && !isNaN(+r[1])).map(r => [r[0], +r[1]]);
    if (!rows.length) { out.errors["fred:" + id] = "tomt: " + c.slice(0, 120); continue; }
    out.fred[id] = rows; console.log(`FRED ${id}: ${rows.length} värden, ${rows[0][0]}–${rows[rows.length - 1][0]}`);
    await sleep(600);
  }
  // 3. Riksbanken
  for (const id of Object.keys(RB_SERIES)) {
    const c = await get(`${RB}/${id}/2005-01-01`, { headers: { Accept: "application/json" } });
    if (typeof c !== "string") { out.errors["rb:" + id] = c.err; continue; }
    try { const j = JSON.parse(c); out.rb[id] = (Array.isArray(j) ? j : j.observations || []).map(o => [o.date, +o.value]).filter(r => r[0] && !isNaN(r[1])); console.log(`Riksbanken ${id}: ${out.rb[id].length} värden`); }
    catch (e) { out.errors["rb:" + id] = "tolkning: " + c.slice(0, 120); }
    await sleep(1500);
  }
  fs.writeFileSync(path.join(OUT, "macro.json"), JSON.stringify(out));
  console.log("Fel:", JSON.stringify(out.errors));
}
main().catch(e => { console.error(e); process.exit(1); });
