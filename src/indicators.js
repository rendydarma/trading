// Pure indicator math. Candle = {time, open, high, low, close, volume}, oldest first, closed candles only.
// Every series is aligned to the input and holds null until it has enough history.

export const round = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toPrecision(6)));
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => sum(a) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
// null-safe arithmetic/comparison: JS coerces null to 0, which would fake values during warmup
const sub = (a, b) => (a == null || b == null ? null : a - b);
const div = (a, b) => (a == null || b == null || b === 0 ? null : a / b);
const gt = (a, b) => a != null && b != null && a > b;
const lt = (a, b) => a != null && b != null && a < b;

// run fn on the non-null tail of a series and re-pad the leading nulls
const onValid = (s, fn) => {
  const st = s.findIndex((v) => v != null);
  return st < 0 ? s.map(() => null) : [...new Array(st).fill(null), ...fn(s.slice(st))];
};

export const sma = (values, n) =>
  onValid(values, (v) => v.map((_, i) => (i < n - 1 ? null : mean(v.slice(i - n + 1, i + 1)))));

// seeded with the SMA of the first n values
export const ema = (values, n) =>
  onValid(values, (v) => {
    const out = new Array(v.length).fill(null);
    if (v.length < n) return out;
    const k = 2 / (n + 1);
    out[n - 1] = mean(v.slice(0, n));
    for (let i = n; i < v.length; i++) out[i] = v[i] * k + out[i - 1] * (1 - k);
    return out;
  });

// Wilder smoothing (RSI, ATR): seed with SMA of first n, then (prev*(n-1)+x)/n
const wilder = (values, n) =>
  onValid(values, (v) => {
    const out = new Array(v.length).fill(null);
    if (v.length < n) return out;
    out[n - 1] = mean(v.slice(0, n));
    for (let i = n; i < v.length; i++) out[i] = (out[i - 1] * (n - 1) + v[i]) / n;
    return out;
  });

const hh = (c, i, n) => Math.max(...c.slice(i - n + 1, i + 1).map((x) => x.high));
const ll = (c, i, n) => Math.min(...c.slice(i - n + 1, i + 1).map((x) => x.low));

export function rsi(closes, n = 14) {
  const gain = [], loss = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain.push(Math.max(d, 0));
    loss.push(Math.max(-d, 0));
  }
  const g = wilder(gain, n), l = wilder(loss, n);
  return [null, ...g.map((ag, i) => (ag == null ? null : l[i] === 0 ? 100 : 100 - 100 / (1 + ag / l[i])))];
}

const trueRange = (c) =>
  c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));

export const atr = (c, n = 14) => wilder(trueRange(c), n);

export function macd(closes, fast = 12, slow = 26, sig = 9) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => sub(f[i], s[i]));
  const signal = ema(line, sig);
  return { line, signal, hist: line.map((v, i) => sub(v, signal[i])) };
}

export function bollinger(closes, n = 20, mult = 2) {
  const mid = sma(closes, n);
  const sd = closes.map((_, i) => (i < n - 1 ? null : std(closes.slice(i - n + 1, i + 1))));
  return {
    mid,
    upper: mid.map((m, i) => (m == null ? null : m + mult * sd[i])),
    lower: mid.map((m, i) => (m == null ? null : m - mult * sd[i])),
  };
}

export function keltner(c, n = 20, atrN = 10, mult = 1.5) {
  const mid = ema(c.map((x) => x.close), n), a = atr(c, atrN);
  return { mid, upper: mid.map((m, i) => (m == null || a[i] == null ? null : m + mult * a[i])), lower: mid.map((m, i) => (m == null || a[i] == null ? null : m - mult * a[i])) };
}

// ADX with +DI/-DI, Wilder method. Series aligned to c; index 0 is null.
export function adx(c, n = 14) {
  const pdm = [], mdm = [], tr = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  }
  const smooth = (a) => {
    const out = new Array(a.length).fill(null);
    if (a.length < n) return out;
    let s = sum(a.slice(0, n));
    out[n - 1] = s;
    for (let j = n; j < a.length; j++) out[j] = s = s - s / n + a[j];
    return out;
  };
  const sp = smooth(pdm), sm = smooth(mdm), st = smooth(tr);
  const pdi = sp.map((v, j) => (v == null ? null : st[j] === 0 ? 0 : (100 * v) / st[j]));
  const mdi = sm.map((v, j) => (v == null ? null : st[j] === 0 ? 0 : (100 * v) / st[j]));
  const dx = pdi.map((p, j) => (p == null ? null : p + mdi[j] === 0 ? 0 : (100 * Math.abs(p - mdi[j])) / (p + mdi[j])));
  const pad = (s) => [null, ...s];
  return { adx: pad(wilder(dx, n)), plusDI: pad(pdi), minusDI: pad(mdi) };
}

// Supertrend. Initial direction is set from the first valid candle, so early flips can be noise.
export function supertrend(c, n = 10, mult = 3) {
  const a = atr(c, n);
  const dir = new Array(c.length).fill(null), val = new Array(c.length).fill(null);
  let fu = null, fl = null, d = 0;
  for (let i = 0; i < c.length; i++) {
    if (a[i] == null) continue;
    const mid = (c[i].high + c[i].low) / 2, bu = mid + mult * a[i], bl = mid - mult * a[i];
    if (fu == null) {
      fu = bu; fl = bl; d = c[i].close > mid ? 1 : -1;
    } else {
      const pc = c[i - 1].close;
      fu = bu < fu || pc > fu ? bu : fu;
      fl = bl > fl || pc < fl ? bl : fl;
      if (d === -1 && c[i].close > fu) d = 1;
      else if (d === 1 && c[i].close < fl) d = -1;
    }
    dir[i] = d;
    val[i] = d === 1 ? fl : fu;
  }
  return { dir, val };
}

// Needs 78 candles (52 lookback + 26 displacement). Cloud shown is the one plotted at the last candle.
export function ichimoku(c) {
  const len = c.length;
  if (len < 78) return null;
  const mid = (i, n) => (hh(c, i, n) + ll(c, i, n)) / 2;
  const i = len - 1, j = i - 26, close = c[i].close;
  const tenkan = mid(i, 9), kijun = mid(i, 26);
  const a = (mid(j, 9) + mid(j, 26)) / 2, b = mid(j, 52);
  const top = Math.max(a, b), bottom = Math.min(a, b);
  return {
    tenkan, kijun, cloudTop: top, cloudBottom: bottom,
    priceVsCloud: close > top ? 'above' : close < bottom ? 'below' : 'inside',
    tenkanAboveKijun: tenkan > kijun,
    futureCloud: (tenkan + kijun) / 2 > mid(i, 52) ? 'bullish' : 'bearish',
  };
}

export function stoch(c, n = 14, k = 3, d = 3) {
  const raw = c.map((x, i) => {
    if (i < n - 1) return null;
    const h = hh(c, i, n), l = ll(c, i, n);
    return h === l ? 50 : (100 * (x.close - l)) / (h - l);
  });
  const K = sma(raw, k);
  return { k: K, d: sma(K, d) };
}

export function stochRsi(closes, rsiN = 14, n = 14, k = 3, d = 3) {
  const r = rsi(closes, rsiN);
  const raw = r.map((v, i) => {
    if (i < n - 1) return null;
    const w = r.slice(i - n + 1, i + 1);
    if (w.some((x) => x == null)) return null;
    const lo = Math.min(...w), hi = Math.max(...w);
    return hi === lo ? 50 : (100 * (v - lo)) / (hi - lo);
  });
  const K = sma(raw, k);
  return { k: K, d: sma(K, d) };
}

export function cci(c, n = 20) {
  if (c.length < n) return null;
  const tp = c.slice(-n).map((x) => (x.high + x.low + x.close) / 3);
  const m = mean(tp), md = mean(tp.map((v) => Math.abs(v - m)));
  return md === 0 ? 0 : (tp.at(-1) - m) / (0.015 * md);
}

export const roc = (closes, n = 10) => (closes.length > n ? (closes.at(-1) / closes.at(-1 - n) - 1) * 100 : null);

export function williamsR(c, n = 14) {
  if (c.length < n) return null;
  const h = hh(c, c.length - 1, n), l = ll(c, c.length - 1, n);
  return h === l ? -50 : (-100 * (h - c.at(-1).close)) / (h - l);
}

export function mfi(c, n = 14) {
  if (c.length < n + 1) return null;
  let pos = 0, neg = 0;
  for (let i = c.length - n; i < c.length; i++) {
    const tp = (c[i].high + c[i].low + c[i].close) / 3, prev = (c[i - 1].high + c[i - 1].low + c[i - 1].close) / 3;
    if (tp > prev) pos += tp * c[i].volume;
    else if (tp < prev) neg += tp * c[i].volume;
  }
  return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
}

export function obv(c) {
  const out = [0];
  for (let i = 1; i < c.length; i++) out.push(out[i - 1] + Math.sign(c[i].close - c[i - 1].close) * c[i].volume);
  return out;
}

export function chaikinAD(c) {
  let ad = 0;
  return c.map((x) => {
    const r = x.high - x.low;
    ad += r === 0 ? 0 : (((x.close - x.low) - (x.high - x.close)) / r) * x.volume;
    return ad;
  });
}

// session = UTC day; only meaningful for intraday candles
export function vwap(c, ms) {
  if (!ms || ms >= 86400000) return null;
  const day = Math.floor(c.at(-1).time / 86400000);
  const s = c.filter((x) => Math.floor(x.time / 86400000) === day);
  const v = sum(s.map((x) => x.volume));
  return v === 0 ? null : sum(s.map((x) => ((x.high + x.low + x.close) / 3) * x.volume)) / v;
}

// VWAP anchored at the start of the UTC day / ISO week (Mon) / UTC month of the last candle, or at c[0] for 'period'. Bands = ±1 volume-weighted sd of typical price.
export function anchoredVwap(c, anchor = 'period') {
  if (!c.length) return null;
  const t = c.at(-1).time, d = new Date(t), day = Math.floor(t / 86400000) * 86400000;
  const start = anchor === 'day' ? day
    : anchor === 'week' ? day - ((d.getUTCDay() + 6) % 7) * 86400000
    : anchor === 'month' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    : c[0].time;
  const s = c.filter((x) => x.time >= start), v = sum(s.map((x) => x.volume));
  if (v === 0) return null;
  const tp = s.map((x) => (x.high + x.low + x.close) / 3);
  const value = sum(tp.map((p, i) => p * s[i].volume)) / v;
  const sd = Math.sqrt(sum(tp.map((p, i) => (p - value) ** 2 * s[i].volume)) / v);
  return { value: round(value), upper: round(value + sd), lower: round(value - sd), devPct: round((c.at(-1).close / value - 1) * 100), anchorStart: new Date(start).toISOString(), candles: s.length };
}

// Confirmed swing highs/lows: extreme within k candles each side. i = absolute index in c.
export function swings(c, k = 3, lookback = 200) {
  const off = Math.max(0, c.length - lookback), w = c.slice(off), highs = [], lows = [];
  for (let i = k; i < w.length - k; i++) {
    const a = w.slice(i - k, i + k + 1);
    if (w[i].high === Math.max(...a.map((x) => x.high))) highs.push({ i: off + i, price: w[i].high });
    if (w[i].low === Math.min(...a.map((x) => x.low))) lows.push({ i: off + i, price: w[i].low });
  }
  return { highs, lows };
}

// prices already sorted nearest-first; merge those within tol of an existing cluster
function cluster(prices, tol) {
  const out = [];
  for (const p of prices) {
    const g = out.find((x) => Math.abs(x.price - p) <= tol);
    if (g) { g.sum += p; g.touches++; g.price = g.sum / g.touches; }
    else out.push({ price: p, sum: p, touches: 1 });
  }
  return out.map(({ price, touches }) => ({ price: round(price), touches }));
}

export function levels(c, price, { k = 3, lookback = 200, tol = 0, top = 3 } = {}) {
  const { highs, lows } = swings(c, k, lookback);
  const sup = lows.map((x) => x.price).filter((p) => p < price).sort((a, b) => b - a);
  const res = highs.map((x) => x.price).filter((p) => p > price).sort((a, b) => a - b);
  return { supports: cluster(sup, tol).slice(0, top), resistances: cluster(res, tol).slice(0, top) };
}

export function dailyPivots(d) {
  const p = (d.high + d.low + d.close) / 3, r = d.high - d.low;
  return { P: p, R1: 2 * p - d.low, R2: p + r, R3: d.high + 2 * (p - d.low), S1: 2 * p - d.high, S2: p - r, S3: d.low - 2 * (d.high - p) };
}

export function fibonacci(c, lookback = 100) {
  if (c.length < 10) return null;
  const off = Math.max(0, c.length - lookback);
  let hi = -Infinity, lo = Infinity, hiI = 0, loI = 0;
  for (let i = off; i < c.length; i++) {
    if (c[i].high > hi) { hi = c[i].high; hiI = i; }
    if (c[i].low < lo) { lo = c[i].low; loI = i; }
  }
  if (!(hi > lo)) return null;
  const up = loI < hiI; // low came first: upswing, retracements measured down from the high
  const lv = Object.fromEntries([0.236, 0.382, 0.5, 0.618, 0.786].map((r) => [r, up ? hi - r * (hi - lo) : lo + r * (hi - lo)]));
  const close = c.at(-1).close;
  const [ratio, price] = Object.entries(lv).reduce((b, e) => (Math.abs(e[1] - close) < Math.abs(b[1] - close) ? e : b));
  return { swing: up ? 'up' : 'down', high: hi, low: lo, levels: lv, nearest: { ratio: Number(ratio), price } };
}

export function structure(c) {
  const { highs, lows } = swings(c, 3, 200);
  if (highs.length < 2 || lows.length < 2) return null;
  const [h1, h2] = highs.slice(-2), [l1, l2] = lows.slice(-2);
  if (h2.price > h1.price && l2.price > l1.price) return 'uptrend';
  if (h2.price < h1.price && l2.price < l1.price) return 'downtrend';
  return 'range';
}

// price makes a lower low / higher high but RSI does not; second pivot must be within the last 30 candles
export function divergence(c, rsiSeries) {
  const { highs, lows } = swings(c, 3, 100), recent = c.length - 30;
  const at = (i) => rsiSeries[i];
  const [l1, l2] = lows.slice(-2), [h1, h2] = highs.slice(-2);
  return {
    bullish: !!(l1 && l2 && l2.i >= recent && l2.price < l1.price && gt(at(l2.i), at(l1.i))),
    bearish: !!(h1 && h2 && h2.i >= recent && h2.price > h1.price && lt(at(h2.i), at(h1.i))),
  };
}

export function patterns(c) {
  const out = [];
  for (let ago = 0; ago < 3; ago++) {
    const i = c.length - 1 - ago;
    if (i < 1) break;
    const x = c[i], p = c[i - 1];
    const range = x.high - x.low, body = Math.abs(x.close - x.open);
    const upper = x.high - Math.max(x.open, x.close), lower = Math.min(x.open, x.close) - x.low;
    const add = (name, cond) => cond && out.push({ ago, name });
    if (range > 0) {
      add('doji', body / range < 0.1);
      add('hammer', lower >= 2 * body && lower >= 0.6 * range && upper <= 0.15 * range);
      add('shootingStar', upper >= 2 * body && upper >= 0.6 * range && lower <= 0.15 * range);
      add('pinBar', body / range <= 0.25 && Math.max(upper, lower) >= (2 / 3) * range && !out.some((p) => p.ago === ago && (p.name === 'hammer' || p.name === 'shootingStar')));
      add('insideBar', x.high < p.high && x.low > p.low);
    }
    add('bullishEngulfing', p.close < p.open && x.close > x.open && x.open <= p.close && x.close >= p.open);
    add('bearishEngulfing', p.close > p.open && x.close < x.open && x.open >= p.close && x.close <= p.open);
  }
  return out;
}

const donchian = (c, n) => {
  if (c.length < n + 1) return null;
  const w = c.slice(-n - 1, -1); // the n candles before the last one
  return { high: Math.max(...w.map((x) => x.high)), low: Math.min(...w.map((x) => x.low)) };
};

// price broke the n-candle channel within the last 5 candles and the last candle came back to test it
function retest(c, n, a) {
  const len = c.length, x = c.at(-1);
  let up = false, down = false;
  if (a == null) return { up, down };
  for (let j = Math.max(n, len - 6); j <= len - 2; j++) {
    const w = c.slice(j - n, j), hi = Math.max(...w.map((v) => v.high)), lo = Math.min(...w.map((v) => v.low));
    if (c[j].close > hi && x.low <= hi + 0.5 * a && x.close > hi) up = true;
    if (c[j].close < lo && x.high >= lo - 0.5 * a && x.close < lo) down = true;
  }
  return { up, down };
}

// Everything for the last closed candle. opts.prevDaily = last closed 1d candle (for classic pivots).
export function compute(c, { ms, prevDaily, donchianN = 20, volumeConfirm = 1.5 } = {}) {
  const len = c.length, last = c.at(-1), close = last.close;
  ms ??= len > 1 ? last.time - c.at(-2).time : null;
  const closes = c.map((x) => x.close), vols = c.map((x) => x.volume);

  const E = Object.fromEntries([9, 21, 50, 200].map((n) => [n, ema(closes, n)]));
  const S = Object.fromEntries([20, 50, 200].map((n) => [n, sma(closes, n)]));
  const e = (n) => E[n].at(-1);
  const r = rsi(closes), m = macd(closes), at = atr(c), a = at.at(-1);
  const ad = adx(c), st = supertrend(c), bb = bollinger(closes), kc = keltner(c);
  const sr = stochRsi(closes), so = stoch(c);

  const bw = bb.upper.map((u, i) => (u == null ? null : (u - bb.lower[i]) / bb.mid[i])).filter((v) => v != null).slice(-100);
  const bwNow = bw.at(-1);
  const rets = closes.slice(-101).map((v, i, s) => (i ? Math.log(v / s[i - 1]) : null)).slice(1);
  const periodsPerYear = ms ? (365 * 86400000) / ms : null;

  const avg20 = len > 20 ? mean(vols.slice(-21, -1)) : null;
  const w50 = vols.slice(-51, -1);
  const volRatio = div(last.volume, avg20);
  const o = obv(c), oe = ema(o, 21), adl = chaikinAD(c);
  const avg50 = w50.length >= 20 ? mean(w50) : null;

  const lv = levels(c, close, { tol: a == null ? 0 : 0.3 * a });
  const sup = lv.supports[0]?.price ?? null, res = lv.resistances[0]?.price ?? null;
  const d20 = donchian(c, donchianN), d55 = donchian(c, 55);
  const rt = retest(c, donchianN, a);
  const atr50 = atr(c, 50).at(-1), atrRatio = div(a, atr50);
  const pHigh = Math.max(...c.map((x) => x.high)), pLow = Math.min(...c.map((x) => x.low));

  const f9 = e(9), f21 = e(21), f50 = e(50), f200 = e(200);
  const crossed = [E[9].at(-2), E[21].at(-2), f9, f21].every((v) => v != null) && Math.sign(E[9].at(-2) - E[21].at(-2)) !== Math.sign(f9 - f21);
  const slope21 = div(sub(f21, E[21].at(-6)), E[21].at(-6));
  const bull = gt(f9, f21) && gt(f21, f50), bear = lt(f9, f21) && lt(f21, f50);
  const votes = (bull ? 1 : bear ? -1 : 0) + (f200 == null ? 0 : close > f200 ? 1 : -1) + (st.dir.at(-1) ?? 0);
  const adxNow = ad.adx.at(-1);
  const stNow = st.dir.at(-1);

  return {
    candle: new Date(last.time).toISOString(),
    close,
    trend: {
      state: votes >= 2 ? 'bull' : votes <= -2 ? 'bear' : 'mixed',
      ema: Object.fromEntries([9, 21, 50, 200].map((n) => [n, round(e(n))])),
      sma: Object.fromEntries([20, 50, 200].map((n) => [n, round(S[n].at(-1))])),
      priceAboveEma: Object.fromEntries([9, 21, 50, 200].map((n) => [n, e(n) == null ? null : close > e(n)])),
      ema9vs21: f9 == null || f21 == null ? null : { state: f9 > f21 ? 'bullish' : 'bearish', crossedOnLastCandle: crossed },
      ema21SlopePctPerCandle: round(slope21 == null ? null : slope21 * 20), // 5-candle change / 5, in %
      distFromEma200Pct: round(f200 == null ? null : (close / f200 - 1) * 100),
      adx: { adx: round(adxNow), plusDI: round(ad.plusDI.at(-1)), minusDI: round(ad.minusDI.at(-1)), strong: gt(adxNow, 25) },
      supertrend: stNow == null ? null : { dir: stNow === 1 ? 'up' : 'down', value: round(st.val.at(-1)), flippedOnLastCandle: st.dir.at(-2) != null && st.dir.at(-2) !== stNow },
      ichimoku: (() => { const k = ichimoku(c); return k && Object.fromEntries(Object.entries(k).map(([key, v]) => [key, typeof v === 'number' ? round(v) : v])); })(),
    },
    momentum: {
      rsi14: round(r.at(-1)),
      stochRsi: { k: round(sr.k.at(-1)), d: round(sr.d.at(-1)) },
      stoch: { k: round(so.k.at(-1)), d: round(so.d.at(-1)) },
      macd: { line: round(m.line.at(-1)), signal: round(m.signal.at(-1)), hist: round(m.hist.at(-1)) },
      cci20: round(cci(c)),
      roc10: round(roc(closes)),
      williamsR14: round(williamsR(c)),
      mfi14: round(mfi(c)),
      divergence: divergence(c, r),
    },
    volatility: {
      atr14: round(a),
      atrPct: round(a == null ? null : (a / close) * 100),
      bollinger: {
        upper: round(bb.upper.at(-1)), mid: round(bb.mid.at(-1)), lower: round(bb.lower.at(-1)),
        pctB: round(div(sub(close, bb.lower.at(-1)), sub(bb.upper.at(-1), bb.lower.at(-1)))),
        bandwidth: round(bwNow),
        bandwidthPercentile: bw.length >= 50 ? round((100 * bw.filter((v) => v <= bwNow).length) / bw.length) : null,
      },
      keltner: { upper: round(kc.upper.at(-1)), mid: round(kc.mid.at(-1)), lower: round(kc.lower.at(-1)) },
      squeeze: kc.upper.at(-1) == null || bb.upper.at(-1) == null ? null : bb.upper.at(-1) < kc.upper.at(-1) && bb.lower.at(-1) > kc.lower.at(-1),
      histVolPct: rets.length >= 20 && periodsPerYear ? round(std(rets) * Math.sqrt(periodsPerYear) * 100) : null,
      compression: { atr14to50: round(atrRatio), compressed: atrRatio != null && atrRatio < 0.7 },
    },
    volume: {
      last: round(last.volume), avg20: round(avg20), ratio: round(volRatio),
      zScore50: w50.length >= 20 && std(w50) > 0 ? round((last.volume - mean(w50)) / std(w50)) : null,
      obv: { value: round(o.at(-1)), aboveEma21: gt(o.at(-1), oe.at(-1)), slope5: round(div(sub(oe.at(-1), oe.at(-6)), avg50)) },
      chaikinAdSlope5: round(len > 5 ? div(adl.at(-1) - adl.at(-6), avg50) : null),
      vwap: round(vwap(c, ms)),
    },
    levels: {
      support: sup, resistance: res,
      supports: lv.supports, resistances: lv.resistances,
      distToSupportAtr: round(sup == null || !a ? null : (close - sup) / a),
      distToResistanceAtr: round(res == null || !a ? null : (res - close) / a),
      pivotPoints: prevDaily ? Object.fromEntries(Object.entries(dailyPivots(prevDaily)).map(([k, v]) => [k, round(v)])) : null,
      fibonacci: (() => { const f = fibonacci(c); return f && { ...f, high: round(f.high), low: round(f.low), levels: Object.fromEntries(Object.entries(f.levels).map(([k, v]) => [k, round(v)])), nearest: { ratio: f.nearest.ratio, price: round(f.nearest.price) } }; })(),
      periodHigh: round(pHigh), periodLow: round(pLow), candlesInPeriod: len,
      distFromPeriodHighPct: round((close / pHigh - 1) * 100), distFromPeriodLowPct: round((close / pLow - 1) * 100),
      structure: structure(c),
    },
    breakout: {
      donchian20: d20 && { high: round(d20.high), low: round(d20.low) },
      donchian55: d55 && { high: round(d55.high), low: round(d55.low) },
      up: d20 ? close > d20.high : null,
      down: d20 ? close < d20.low : null,
      up55: d55 ? close > d55.high : null,
      down55: d55 ? close < d55.low : null,
      volumeConfirmed: volRatio != null && volRatio >= volumeConfirm,
      falseBreakUp: d20 ? last.high > d20.high && close <= d20.high : null,
      falseBreakDown: d20 ? last.low < d20.low && close >= d20.low : null,
      retestUp: rt.up, retestDown: rt.down,
    },
    patterns: patterns(c),
    meta: {
      candlesUsed: len,
      dataAgeSec: ms ? Math.round((Date.now() - (last.time + ms)) / 1000) : null,
      warmupOk: { ema200: len >= 200, ichimoku: len >= 78, adx: len >= 28, bandwidthPercentile: len >= 119, fibonacci: len >= 100, atr50: len >= 51 },
    },
  };
}

// Flat rows of the key series for backtest input / CSV export
export function seriesTable(c) {
  const closes = c.map((x) => x.close);
  const E = Object.fromEntries([9, 21, 50, 200].map((n) => [n, ema(closes, n)]));
  const r = rsi(closes), m = macd(closes), at = atr(c), ad = adx(c), st = supertrend(c);
  return c.map((x, i) => ({
    time: new Date(x.time).toISOString(), open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume,
    ema9: round(E[9][i]), ema21: round(E[21][i]), ema50: round(E[50][i]), ema200: round(E[200][i]),
    rsi14: round(r[i]), macd: round(m.line[i]), macdSignal: round(m.signal[i]), macdHist: round(m.hist[i]),
    atr14: round(at[i]), adx14: round(ad.adx[i]), plusDI: round(ad.plusDI[i]), minusDI: round(ad.minusDI[i]), supertrendDir: st.dir[i],
  }));
}
