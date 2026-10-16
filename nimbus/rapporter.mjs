// Svenska kvartalsrapporter: hämtar pressmeddelanden från Cision och låter AI (GitHub Models) läsa av dem.
// Körs av .github/workflows/rapporter.yml. Kan köras om: fortsätter där den slutade.
// Steg 1: hitta rapporterna i Cisions månadsförteckningar (sitemaps), 2016 och framåt.
// Steg 2: hämta texten i varje rapport.
// Steg 3: AI (Google Gemini, gratisnivån) svarar på några frågor per rapport, så långt dagens kvot räcker. Nästa körning tar resten.
// Påverkar inte Flipradar-sidan. Allt sparas i nimbus/reports/.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, "reports"), TXT = path.join(OUT, "text");
const CISION = process.env.CISION_URL || "https://news.cision.com";
// Googles OpenAI-kompatibla gränssnitt. Nyckeln läggs som hemlighet GEMINI_API_KEY i repot.
const MODELS = process.env.MODELS_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
let MODEL_LIST = (process.env.MODEL_LIST || "").split(",").filter(Boolean);
const TOKEN = process.env.GEMINI_API_KEY || "";
const FIRST = Number(process.env.FIRST_YEAR || 2016);
const BUDGET_MS = Number(process.env.BUDGET_MIN || 100) * 60000, T0 = Date.now();
const UA = "Mozilla/5.0 (compatible; Flipradar-research; +https://github.com/Chrille97/flipradar)";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeLeft = () => Date.now() - T0 < BUDGET_MS;
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const wr = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 1));

// Våra svenska bolag: Yahoo-symbol → mönster som ska finnas i Cisions bolagsnamn i adressen (utan å/ä/ö)
const COMPANIES = {
  "SWEC-B.ST": /^sweco/, "VOLV-B.ST": /^(ab-)?volvo(?!-car)/, "ATCO-A.ST": /^atlas-copco/, "SAND.ST": /^sandvik/,
  "SKF-B.ST": /^(ab-)?skf/, "ALFA.ST": /^alfa-laval/, "ASSA-B.ST": /^assa-abloy/, "HEXA-B.ST": /^hexagon/,
  "INVE-B.ST": /^investor(-ab)?$/, "EQT.ST": /^eqt(-ab)?$/, "SEB-A.ST": /^(seb|skandinaviska-enskilda)/, "SHB-A.ST": /^(svenska-)?handelsbanken(-ab)?$/,
  "SWED-A.ST": /^swedbank(-ab)?$/, "AZA.ST": /^avanza/, "SAVE.ST": /^nordnet/, "ERIC-B.ST": /ericsson/, "SINCH.ST": /^sinch/,
  "HM-B.ST": /^(h---m|h-m|hm-|hennes)/, "EVO.ST": /^evolution(-gaming)?(-group)?(-ab)?$/, "SAAB-B.ST": /^saab/, "NIBE-B.ST": /^nibe/,
  "BOL.ST": /^boliden/, "EPI-A.ST": /^epiroc/, "LIFCO-B.ST": /^lifco/, "ADDT-B.ST": /^addtech/, "LAGR-B.ST": /^lagercrantz/,
  "INDU-C.ST": /industrivarden/, "LATO-B.ST": /latour/, "KINV-B.ST": /^kinnevik/, "NDA-SE.ST": /^nordea/, "ESSITY-B.ST": /^essity/,
  "TELIA.ST": /^telia/, "TEL2-B.ST": /^tele2(-ab)?$/, "SSAB-B.ST": /^ssab/, "GETI-B.ST": /^getinge/, "SOBI.ST": /(swedish-orphan|^sobi)/,
  "CAMX.ST": /^camurus/, "SECT-B.ST": /^sectra/, "BONEX.ST": /^bonesupport/, "MYCR.ST": /^mycronic/, "HMS.ST": /^hms-networks/,
  "MILDEF.ST": /^mildef/, "TRUE-B.ST": /^truecaller/, "YUBICO.ST": /^yubico/, "ABB.ST": /^abb(-ltd)?$/, "AZN.ST": /^astrazeneca/,
};
const REPORT = /(delarsrapport|bokslutskommunike|kvartalsrapport|halvarsrapport|bokslutsrapport|arsbokslut)/;
// Inbjudningar och påminnelser om rapporter är inte rapporter
const NOT_REPORT = /(inbjudan|presenteras|presentation|webcast|webbsandning|telefonkonferens|kallelse|publicerar|publiceras|datum-for|andrat-datum|invitation)/;
const excluded = r => NOT_REPORT.test(r.slug) || !(COMPANIES[r.sym] && COMPANIES[r.sym].test(r.comp));

async function get(url, binary = false) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.ok) return binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
      if (r.status === 404) return null;
    } catch {}
    await sleep(2000 * (a + 1));
  }
  return null;
}

// ---------- Steg 1: hitta rapporterna ----------
async function discover(state) {
  const now = new Date();
  for (let y = FIRST; y <= now.getUTCFullYear(); y++) for (let m = 1; m <= 12; m++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    if (y === now.getUTCFullYear() && m > now.getUTCMonth() + 1) break;
    const current = y === now.getUTCFullYear() && m >= now.getUTCMonth(); // senaste månaderna läses om varje gång
    if (state.months[ym] && !current) continue;
    const gz = await get(`${CISION}/sitemaps/se/sitemap_r_${ym}.xml.gz`, true);
    let xml = "";
    if (gz) { try { xml = zlib.gunzipSync(gz).toString("utf8"); } catch { xml = gz.toString("utf8"); } }
    let n = 0;
    for (const mm of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = (mm[1].match(/<loc>([^<]+)<\/loc>/) || [])[1]; if (!loc) continue;
      const p = loc.match(/\/se\/([^/]+)\/r\/([^,]+),c(\d+)/); if (!p) continue;
      const [, comp, slug, id] = p;
      if (!REPORT.test(slug)) continue;
      const sym = Object.keys(COMPANIES).find(k => COMPANIES[k].test(comp));
      state.slugsSeen[comp] = (state.slugsSeen[comp] || 0) + 1;
      if (!sym) continue;
      if (/interim|year-end|quarterly|report-for/.test(slug)) continue;
      if (!state.reports[id]) { state.reports[id] = { sym, comp, slug, url: loc, month: ym, lastmod: (mm[1].match(/<lastmod>([^<]+)</) || [])[1] || null }; n++; }
    }
    state.months[ym] = { found: n, ok: !!xml };
    console.log(`${ym}: ${xml ? "läst" : "saknas"}, ${n} nya rapporter`);
    await sleep(800);
  }
}

// ---------- Steg 2: hämta texten ----------
function toText(html) {
  const pub = (html.match(/datetime="(\d{4}-\d\d-\d\dT[\d:]+[^"]*)"/) || html.match(/"datePublished"\s*:\s*"([^"]+)"/) || [])[1] || null;
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  const i = t.search(/(delårsrapport|bokslutskommuniké|kvartalsrapport|halvårsrapport)/i);
  if (i > 0) t = t.slice(i);
  return { pub, text: t.slice(0, 9000) };
}
async function fetchTexts(state) {
  fs.mkdirSync(TXT, { recursive: true });
  const todo = Object.entries(state.reports).filter(([id, r]) => !r.fetched);
  console.log(`Hämtar text för ${todo.length} rapporter`);
  for (const [id, r] of todo) {
    if (!timeLeft()) return;
    const html = await get(r.url);
    if (html) { const { pub, text } = toText(html); fs.writeFileSync(path.join(TXT, id + ".txt"), text); Object.assign(r, { fetched: true, pub, chars: text.length }); }
    else r.fetched = "fel";
    await sleep(1200);
  }
}

// ---------- Steg 3: AI läser rapporten ----------
const PROMPT = `Du läser ett pressmeddelande med en kvartalsrapport från ett svenskt börsbolag. Svara ENDAST med JSON enligt mallen.
Jämför med samma period föregående år när rapporten anger det. Gissa inte: skriv "oklart" om uppgiften saknas.
{
 "period": "t.ex. Q2 2026",
 "nettoomsattning": "upp" | "ned" | "oklart",
 "organisk_tillvaxt": "positiv" | "negativ" | "oklart",
 "orderingang": "upp" | "ned" | "oklart",
 "rorelsemarginal": "upp" | "ned" | "oklart",
 "resultat_per_aktie": "upp" | "ned" | "oklart",
 "prognos": "hojd" | "sankt" | "oforandrad" | "ingen",
 "utsikter_ton": -2 till 2 (heltal, hur positivt bolaget beskriver framtiden; 0 om inget sägs),
 "vd_ton": -2 till 2 (heltal, hur positiv vd:s kommentar är),
 "engangsposter": true | false (stora jämförelsestörande poster nämns),
 "sammanfattning": "högst 20 ord på svenska"
}`;
async function ask(model, text) {
  let r;
  try { r = await fetch(MODELS, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 8192, response_format: { type: "json_object" },
      messages: [{ role: "system", content: PROMPT }, { role: "user", content: text.slice(0, 7000) }] }),
  }); } catch (e) { return { error: "nätverksfel: " + [e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(" · ") }; }
  const body = await r.text();
  if (r.status === 429) return { quota: true, retry: Number(r.headers.get("retry-after") || 0) };
  if (r.status >= 500) return { busy: true, error: `HTTP ${r.status}: ${body.slice(0, 160)}` };
  if (r.status === 404) return { noModel: true, error: `modellen finns inte: ${body.slice(0, 150)}` };
  if (!r.ok) return { error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
  let j; try { j = JSON.parse(body); } catch { return { error: `oväntat svar (HTTP ${r.status}): ${body.slice(0, 120)}` }; }
  const c = j?.choices?.[0]?.message?.content || "";
  try { return { data: JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1)) }; } catch { return { error: "kunde inte tolka svaret: " + c.slice(0, 120) }; }
}
async function classify(state) {
  if (!TOKEN) { state.lastAiError = "Ingen GEMINI_API_KEY. Lägg in nyckeln som hemlighet i repot."; console.log(state.lastAiError); return; }
  // Fråga vilka modeller nyckeln får använda och välj snabba, billiga textmodeller (Flash) först.
  if (!MODEL_LIST.length) {
    try {
      const r = await fetch(MODELS.replace(/chat\/completions\/?$/, "models"), { headers: { Authorization: `Bearer ${TOKEN}` } });
      const j = await r.json();
      const ids = (j.data || j.models || []).map(m => String(m.id || m.name || "").replace(/^models\//, "")).filter(Boolean);
      state.availableModels = ids;
      const ok = ids.filter(id => /gemini/.test(id) && /flash/.test(id) && !/(image|tts|audio|live|embed|thinking|exp|preview|vision)/.test(id));
      const ver = id => parseFloat((id.match(/gemini-(\d+(\.\d+)?)/) || [])[1] || 0);
      ok.sort((a, b) => ver(b) - ver(a) || (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0));
      MODEL_LIST = ok.length ? ok : ids.filter(id => /gemma/.test(id));
      console.log("Tillgängliga modeller:", ids.join(", "));
    } catch (e) { state.lastAiError = "kunde inte lista modeller: " + e.message; }
    if (!MODEL_LIST.length) { state.lastAiError ||= "Ingen lämplig modell hittades. Se availableModels i state.json."; console.log(state.lastAiError); return; }
  }
  console.log("Använder i tur och ordning:", MODEL_LIST.join(", "));
  state.modelsUsed = MODEL_LIST;
  const todo = Object.entries(state.reports).filter(([id, r]) => r.fetched === true && !r.ai && !excluded(r) && (r.aiErr || 0) < 3);
  console.log(`AI läser ${todo.length} rapporter`);
  let mi = state.modelIdx || 0, n = 0, quotaHits = 0, errRow = 0, busyRow = 0;
  for (const [id, r] of todo) {
    if (!timeLeft() || mi >= MODEL_LIST.length) break;
    if (n === 0 && errRow === 0 && mi > 0) console.log("Byter till", MODEL_LIST[mi]);
    const text = fs.readFileSync(path.join(TXT, id + ".txt"), "utf8");
    if (text.length < 300) { r.ai = { skip: "för lite text" }; continue; }
    const res = await ask(MODEL_LIST[mi], text);
    if (res.quota) {
      if (res.retry && res.retry < 120) { await sleep(res.retry * 1000); continue; }
      console.log(`Kvoten slut för ${MODEL_LIST[mi]}`); mi++; quotaHits++; continue;
    }
    if (res.busy) {
      // Modellen är tillfälligt överbelastad: vänta, och byt modell om det håller i sig
      state.lastAiError = `${MODEL_LIST[mi]}: ${res.error}`;
      if (++busyRow >= 3) { console.log(`${MODEL_LIST[mi]} är överbelastad, byter modell`); mi++; busyRow = 0; }
      else await sleep(20000);
      continue;
    }
    busyRow = 0;
    if (res.noModel) { console.log(res.error); state.lastAiError = res.error; mi++; continue; }
    if (res.error) {
      state.lastAiError = res.error; console.log(id, res.error); await sleep(4000);
      if (++errRow >= 10) { console.log("Tio fel i rad, avbryter AI-steget. Se lastAiError i summary.json."); break; }
      if (!/nätverksfel|HTTP 5/.test(res.error)) r.aiErr = (r.aiErr || 0) + 1;
      continue;
    }
    errRow = 0;
    r.ai = { ...res.data, model: MODEL_LIST[mi] }; n++; state.lastAiError = null;
    if (n % 20 === 0) { wr(path.join(OUT, "state.json"), state); console.log(`  ${n} klara`); }
    await sleep(7000); // under 10 anrop per minut (gratisnivån)
  }
  state.modelIdx = 0; // ny dag, ny kvot
  console.log(`AI klar med ${n} rapporter den här körningen.`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sf = path.join(OUT, "state.json");
  const state = rd(sf, { months: {}, reports: {}, slugsSeen: {} });
  try { await discover(state); } finally { wr(sf, state); }
  try { await fetchTexts(state); } finally { wr(sf, state); }
  try { await classify(state); } catch (e) { state.lastAiError = "krasch: " + e.message; console.log(e); } finally { wr(sf, state); }
  const R = Object.values(state.reports).filter(r => !excluded(r)), bySym = {};
  for (const r of R) { const b = bySym[r.sym] ||= { rapporter: 0, text: 0, ai: 0 }; b.rapporter++; if (r.fetched === true) b.text++; if (r.ai && !r.ai.skip) b.ai++; }
  const missing = Object.keys(COMPANIES).filter(k => !bySym[k]);
  const topSlugs = Object.entries(state.slugsSeen).sort((a, b) => b[1] - a[1]).slice(0, 400).map(([k, v]) => `${k}:${v}`);
  wr(path.join(OUT, "summary.json"), { updated: new Date().toISOString(), lastAiError: state.lastAiError || null, modelsUsed: state.modelsUsed || null, availableModels: state.availableModels || null, totals: { rapporter: R.length, text: R.filter(r => r.fetched === true).length, ai: R.filter(r => r.ai && !r.ai.skip).length }, bySym, saknasHeltPaCision: missing, cisionBolagMedRapporter: topSlugs });
  console.log(`Totalt ${R.length} rapporter, ${R.filter(r => r.fetched === true).length} med text, ${R.filter(r => r.ai && !r.ai.skip).length} lästa av AI. Saknas: ${missing.join(", ") || "inga"}`);
}
main().catch(e => { console.error(e); process.exit(1); });
