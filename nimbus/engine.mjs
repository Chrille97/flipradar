// Nimbus3000 – intradagsmotor (timstaplar). Samma logik som Pine-strategin nimbus3000.pine.
//
// Idéerna bakom:
//  * Regimfilter (Ed Seykota, "the trend is your friend"): Trendlinjen på dagsgrafen, senaste STÄNGDA dagen.
//    Bara köp i bull-regim, bara blankning i bear-regim.
//  * Modul A – volatilitetsutbrott (Toby Crabel, Larry Williams): priset stänger mer än k × dagligt ATR
//    från dagens öppning, över/under VWAP och med förhöjd volym.
//  * Modul B – rekyl i trend (Linda Raschke, Larry Connors): RSI(2) extremt översåld i upptrend
//    (EMA20 > EMA50, pris > EMA50), ut när priset tar sig tillbaka över EMA20.
//  * Risk (Van Tharp, Paul Tudor Jones): 1 % risk per affär, stopp i ATR, flytt till break-even vid +1R,
//    släpande stopp, max 3 affärer och max −2 % per dag. Aktier stängs alltid före börsens stängning.
export const DEFAULTS = {
  riskPct: 1, maxTradesDay: 3, dayLossPct: 2,
  bkK: 0.5, volMult: 1.2, bkStopAtr: 2, bkBeR: 1, bkTrailAtr: 2.5,
  pbRsi: 10, pbStopAtr: 2, pbMaxBars: 12,
  cryptoMaxBars: 24, allowShort: true,
  fee: 0.004, slip: 0.0005,
  trendAtr: 10, trendMult: 3.2,
  modules: "AB",
};

function rmaArr(src, len) {
  const out = new Array(src.length).fill(null); let s = 0, n = 0, v = null;
  for (let i = 0; i < src.length; i++) {
    const x = src[i]; if (x == null) continue;
    if (v == null) { s += x; n++; if (n === len) { v = s / len; out[i] = v; } continue; }
    v = (v * (len - 1) + x) / len; out[i] = v;
  }
  return out;
}
function emaArr(src, len) {
  const out = new Array(src.length).fill(null), k = 2 / (len + 1); let v = null, s = 0;
  for (let i = 0; i < src.length; i++) {
    if (i < len - 1) { s += src[i]; continue; }
    if (i === len - 1) { s += src[i]; v = s / len; } else v = src[i] * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}
function smaArr(src, len) {
  const out = new Array(src.length).fill(null); let s = 0;
  for (let i = 0; i < src.length; i++) { s += src[i]; if (i >= len) s -= src[i - len]; if (i >= len - 1) out[i] = s / len; }
  return out;
}
function trArr(b) { return b.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c))); }
function rsiArr(c, len) {
  const out = new Array(c.length).fill(null); let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i < len) { ag += g; al += l; continue; }
    if (i === len) { ag = (ag + g) / len; al = (al + l) / len; } else { ag = (ag * (len - 1) + g) / len; al = (al * (len - 1) + l) / len; }
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
// Trendlinjen – exakt samma som Flipradar/Pine (hl2, ATR(RMA) × mult, spärrhake).
export function trendDirs(bars, atrLen, mult) {
  const atr = rmaArr(trArr(bars), atrLen), dirs = new Array(bars.length).fill(null);
  let upT = null, dnT = null, dir = 1;
  for (let i = 0; i < bars.length; i++) {
    if (atr[i] == null) continue;
    const b = bars[i], src = (b.h + b.l) / 2, up = src - mult * atr[i], dn = src + mult * atr[i];
    const upPrev = upT == null ? up : upT, dnPrev = dnT == null ? dn : dnT, pc = i > 0 ? bars[i - 1].c : NaN;
    upT = pc > upPrev ? Math.max(up, upPrev) : up;
    dnT = pc < dnPrev ? Math.min(dn, dnPrev) : dn;
    if (dir === -1 && b.c > dnPrev) dir = 1; else if (dir === 1 && b.c < upPrev) dir = -1;
    dirs[i] = dir;
  }
  return dirs;
}

// Dagnyckel: krypto = UTC-dygn, aktier = börsens lokala datum.
function dayKeys(bars, type, tz) {
  if (type === "crypto" || !tz) return bars.map(b => Math.floor(b.t / 86400));
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return bars.map(b => f.format(new Date(b.t * 1000)));
}

export function prepare(bars, type, tz, o = DEFAULTS) {
  const n = bars.length, c = bars.map(b => b.c);
  const key = dayKeys(bars, type, tz);
  const dIdx = new Array(n), daily = [], first = new Array(n), last = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0 || key[i] !== key[i - 1]) daily.push({ t: bars[i].t, o: bars[i].o, h: bars[i].h, l: bars[i].l, c: bars[i].c });
    else { const d = daily[daily.length - 1]; d.h = Math.max(d.h, bars[i].h); d.l = Math.min(d.l, bars[i].l); d.c = bars[i].c; }
    dIdx[i] = daily.length - 1;
    first[i] = i === 0 || key[i] !== key[i - 1];
  }
  for (let i = 0; i < n; i++) last[i] = i === n - 1 ? false : key[i + 1] !== key[i];
  const dDir = trendDirs(daily, o.trendAtr, o.trendMult), dAtr = rmaArr(trArr(daily), 14);
  const sessOpen = new Array(n), vwap = new Array(n);
  let so = 0, pv = 0, vv = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (first[i]) { so = b.o; pv = 0; vv = 0; }
    const tp = (b.h + b.l + b.c) / 3, v = b.v || 0;
    pv += tp * v; vv += v; sessOpen[i] = so; vwap[i] = vv > 0 ? pv / vv : tp;
  }
  return {
    key, dIdx, first, last, daily, dDir, dAtr, sessOpen, vwap,
    ema20: emaArr(c, 20), ema50: emaArr(c, 50), atr: rmaArr(trArr(bars), 14),
    rsi2: rsiArr(c, 2), volSma: smaArr(bars.map(b => b.v || 0), 20),
  };
}

// Backtest. Signal på stängd stapel i, fyllning på öppningen av stapel i+1. Stopp kontrolleras inom stapeln;
// om stoppet redan är passerat vid öppning fylls det på öppningspriset (gap). Konservativ ordning: stopp först.
export function backtest(bars, type, tz, startT, opt = {}) {
  const o = { ...DEFAULTS, ...opt }, P = prepare(bars, type, tz, o), n = bars.length;
  const isStock = type !== "crypto", slip = o.slip, fee = o.fee;
  let eq = 1, peak = 1, mdd = 0, pos = null, pend = null, barsIn = 0, barsWin = 0, feesPaid = 0;
  const trades = [], day = {}; let s0 = -1;
  const dayState = k => (day[k] ||= { n: 0, pnl: 0, start: eq, bk: { 1: false, "-1": false } });
  const close = (i, px, why) => {
    const exit = px * (1 - slip * pos.side), f = fee * pos.qty * exit;
    const pnl = pos.qty * (exit - pos.entry) * pos.side - f - pos.fee;
    eq += pos.qty * (exit - pos.entry) * pos.side - f; feesPaid += f;
    trades.push({ t: bars[pos.i].t, tx: bars[i].t, side: pos.side, mod: pos.mod, entry: pos.entry, exit, pnl, r: pnl / pos.risk, why, bars: i - pos.i + 1 });
    dayState(P.key[i]).pnl += pnl; pos = null;
  };
  for (let i = 1; i < n; i++) {
    const b = bars[i];
    if (b.t < startT) continue;
    if (s0 < 0) s0 = i;
    // 1. Fyll väntande order på öppningen
    if (pend && !pos) {
      const entry = b.o * (1 + slip * pend.side), dist = pend.dist;
      const risk = eq * o.riskPct / 100;
      const qty = Math.min(risk / dist, eq / entry);
      const f = fee * qty * entry; eq -= f; feesPaid += f;
      pos = { side: pend.side, mod: pend.mod, entry, qty, i, stop: entry - pend.side * dist, R: dist, risk: qty * dist, fee: f, ext: entry, be: false };
      dayState(P.key[i]).n++;
      pend = null;
    }
    pend = null;
    // 2. Hantera öppen position
    if (pos) {
      const s = pos.side;
      const hitStop = s === 1 ? b.l <= pos.stop : b.h >= pos.stop;
      if (hitStop) close(i, s === 1 ? Math.min(b.o, pos.stop) : Math.max(b.o, pos.stop), pos.be ? "släpande stopp" : "stopp");
      else {
        const held = i - pos.i + 1;
        if (pos.mod === "B" && (s === 1 ? b.c > P.ema20[i] : b.c < P.ema20[i])) close(i, b.c, "mål EMA20");
        else if (isStock && P.last[i]) close(i, b.c, "dagens slut");
        else if (pos.mod === "B" && held >= o.pbMaxBars) close(i, b.c, "tid");
        else if (!isStock && held >= o.cryptoMaxBars) close(i, b.c, "tid");
        else if (pos.mod === "A") {
          pos.ext = s === 1 ? Math.max(pos.ext, b.h) : Math.min(pos.ext, b.l);
          if (!pos.be && (pos.ext - pos.entry) * s >= o.bkBeR * pos.R) { pos.be = true; pos.stop = s === 1 ? Math.max(pos.stop, pos.entry) : Math.min(pos.stop, pos.entry); }
          if (pos.be) { const tr = pos.ext - s * o.bkTrailAtr * P.atr[i]; pos.stop = s === 1 ? Math.max(pos.stop, tr) : Math.min(pos.stop, tr); }
        }
      }
    }
    // 3. Nya signaler (utförs på nästa stapels öppning)
    if (!pos && !(isStock && P.last[i]) && i < n - 1) {
      const d = P.dIdx[i], reg = d > 0 ? P.dDir[d - 1] : null, dAtr = d > 0 ? P.dAtr[d - 1] : null;
      const ds = dayState(P.key[i]);
      const ok = reg != null && dAtr != null && P.atr[i] != null && P.ema50[i] != null && P.rsi2[i] != null && P.volSma[i] != null
        && ds.n < o.maxTradesDay && ds.pnl > -ds.start * o.dayLossPct / 100;
      if (ok && (reg === 1 || o.allowShort)) {
        const s = reg, c = b.c, pc = bars[i - 1].c, thr = P.sessOpen[i] + s * o.bkK * dAtr;
        const volOk = !(P.volSma[i] > 0) || (b.v || 0) > o.volMult * P.volSma[i];
        const bk = o.modules.includes("A") && !ds.bk[s] && (c - thr) * s > 0 && (P.first[i] || (pc - thr) * s <= 0)
          && (c - P.vwap[i]) * s > 0 && volOk;
        const pb = o.modules.includes("B") && (c - P.ema50[i]) * s > 0 && (P.ema20[i] - P.ema50[i]) * s > 0
          && (s === 1 ? P.rsi2[i] < o.pbRsi : P.rsi2[i] > 100 - o.pbRsi);
        if (bk) { pend = { side: s, mod: "A", dist: o.bkStopAtr * P.atr[i] }; ds.bk[s] = true; }
        else if (pb) pend = { side: s, mod: "B", dist: o.pbStopAtr * P.atr[i] };
      }
    }
    const mark = pos ? eq + pos.qty * (b.c - pos.entry) * pos.side : eq;
    if (pos) barsIn++;
    peak = Math.max(peak, mark); mdd = Math.max(mdd, 1 - mark / peak);
  }
  if (pos) close(n - 1, bars[n - 1].c, "periodens slut");
  const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);
  const stat = ts => {
    const w = ts.filter(t => t.pnl > 0), gp = sum(w, t => t.pnl), gl = -sum(ts.filter(t => t.pnl <= 0), t => t.pnl);
    return { n: ts.length, win: ts.length ? w.length / ts.length : 0, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), avgR: ts.length ? sum(ts, t => t.r) / ts.length : 0 };
  };
  const bhS = s0 >= 0 ? bars[s0 - 1].c : NaN; let bhPk = 0, bhDd = 0;
  for (let i = Math.max(s0 - 1, 0); i < n; i++) { bhPk = Math.max(bhPk, bars[i].c); bhDd = Math.max(bhDd, 1 - bars[i].c / bhPk); }
  return {
    ret: eq - 1, mdd, fees: feesPaid, exposure: s0 >= 0 ? barsIn / (n - s0) : 0,
    all: stat(trades), A: stat(trades.filter(t => t.mod === "A")), B: stat(trades.filter(t => t.mod === "B")),
    long: stat(trades.filter(t => t.side === 1)), short: stat(trades.filter(t => t.side === -1)),
    bh: bars[n - 1].c / bhS - 1, bhDd, trades,
  };
}
