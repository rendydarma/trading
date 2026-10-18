// Tarik candle 15m Binance USDT-M 1 Jan - 18 Okt 2026 dan hitung indikator (15m, 1h, 4h). Belum ada training.
// Pakai: node collect.js
import ccxt from 'ccxt';
import { mkdirSync, writeFileSync } from 'node:fs';

const COINS = (process.env.COINS ?? 'BTC,ETH,HYPE').split(',');
const STEP = 15 * 60000, START = Date.parse('2026-01-01T00:00:00Z'), WARMUP = 60 * 86400000;
const TFS = { '15m': 15, '1h': 60, '4h': 240 };

// ---------- indikator (semua dihitung dari candle yang sudah tutup, tanpa look-ahead) ----------
const ema = (v, p) => { const k = 2 / (p + 1), o = [v[0]]; for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k)); return o; };
const sma = (v, p) => v.map((_, i) => (i < p - 1 ? NaN : v.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p));
const std = (v, p) => v.map((_, i) => { if (i < p - 1) return NaN; const w = v.slice(i - p + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / p; return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / p); });
// Wilder: seed = rata-rata p nilai pertama (mulai indeks `from`), lalu (prev*(p-1)+x)/p
const wilder = (v, p, from = 0) => { const o = new Array(v.length).fill(NaN); let a = 0; for (let i = from; i < v.length; i++) { if (i < from + p - 1) a += v[i] / p; else if (i === from + p - 1) { a += v[i] / p; o[i] = a; } else { a = (a * (p - 1) + v[i]) / p; o[i] = a; } } return o; };
const tr = (c) => c.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)) : x.h - x.l));

function rsi(close, p = 14) {
  const up = close.map((x, i) => (i ? Math.max(x - close[i - 1], 0) : 0)), dn = close.map((x, i) => (i ? Math.max(close[i - 1] - x, 0) : 0));
  const g = wilder(up, p, 1), l = wilder(dn, p, 1);
  return close.map((_, i) => (isNaN(g[i]) ? NaN : l[i] === 0 ? 100 : 100 - 100 / (1 + g[i] / l[i])));
}

function adx(c, p = 14) {
  const pdm = c.map((x, i) => (i && x.h - c[i - 1].h > c[i - 1].l - x.l ? Math.max(x.h - c[i - 1].h, 0) : 0));
  const mdm = c.map((x, i) => (i && c[i - 1].l - x.l > x.h - c[i - 1].h ? Math.max(c[i - 1].l - x.l, 0) : 0));
  const t = wilder(tr(c), p, 1), pd = wilder(pdm, p, 1), md = wilder(mdm, p, 1);
  const pdi = t.map((x, i) => 100 * pd[i] / x), mdi = t.map((x, i) => 100 * md[i] / x);
  const dx = pdi.map((x, i) => (isNaN(x) ? NaN : 100 * Math.abs(x - mdi[i]) / (x + mdi[i] || 1)));
  const first = dx.findIndex((x) => !isNaN(x));
  return { adx: wilder(dx.map((x) => (isNaN(x) ? 0 : x)), p, first), pdi, mdi };
}

// VWAP anchored per hari UTC, harga tipikal (h+l+c)/3
function vwap(c) {
  let pv = 0, vv = 0, day = -1;
  return c.map((x) => { const d = Math.floor(x.t / 86400000); if (d !== day) { day = d; pv = 0; vv = 0; } pv += (x.h + x.l + x.c) / 3 * x.v; vv += x.v; return pv / vv; });
}

// Donchian: high/low tertinggi/terendah n candle SEBELUMNYA (tanpa candle sekarang)
const prior = (c, n, f, pick) => c.map((_, i) => (i < n ? NaN : pick(...c.slice(i - n, i).map(f))));

function indicators(c, tfMin) {
  const close = c.map((x) => x.c), perDay = 1440 / tfMin;
  const e20 = ema(close, 20), e50 = ema(close, 50), e200 = ema(close, 200), e800 = tfMin <= 60 ? ema(close, 800) : null;
  const a = wilder(tr(c), 14, 1), m12 = ema(close, 12), m26 = ema(close, 26), macd = m12.map((x, i) => x - m26[i]), sig = ema(macd, 9);
  const bm = sma(close, 20), bs = std(close, 20), vs = sma(c.map((x) => x.v), 20), dm = adx(c);
  const cols = {
    ema20: e20, ema50: e50, ema200: e200, ...(e800 && { ema800: e800 }),
    rsi14: rsi(close), atr14: a, atr_pct: a.map((x, i) => 100 * x / close[i]),
    vwap: vwap(c), vol_sma20: vs, vol_ratio: c.map((x, i) => (i < 20 ? NaN : x.v / sma(c.slice(i - 20, i).map((y) => y.v), 20)[19])),
    adx14: dm.adx, plus_di: dm.pdi, minus_di: dm.mdi,
    macd, macd_signal: sig, macd_hist: macd.map((x, i) => x - sig[i]),
    bb_mid: bm, bb_upper: bm.map((x, i) => x + 2 * bs[i]), bb_lower: bm.map((x, i) => x - 2 * bs[i]),
    don_high_1d: prior(c, perDay, (x) => x.h, Math.max), don_low_1d: prior(c, perDay, (x) => x.l, Math.min),
    trend: e20.map((x, i) => (Math.abs(x - e50[i]) < 0.1 * a[i] ? 0 : Math.sign(x - e50[i]))), // EMA20 vs EMA50, datar bila selisih < 0.1 ATR
    regime: c.map((x, i) => (i < perDay ? 0 : x.c > e200[i] && e50[i] > e200[i] && e200[i] > e200[i - perDay] ? 1 : x.c < e200[i] && e50[i] < e200[i] && e200[i] < e200[i - perDay] ? -1 : 0)),
  };
  return cols;
}

// ---------- data ----------
const aggregate = (c15, min) => {
  const per = min / 15, ms = min * 60000, out = [];
  for (let k = 0; k + per <= c15.length; k += per) {
    const g = c15.slice(k, k + per);
    if (g[0].t % ms === 0) out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g.at(-1).c, v: g.reduce((s, x) => s + x.v, 0) });
  }
  return out;
};

async function fetch15m(ex, coin) {
  const rows = new Map();
  for (let since = START - WARMUP; ; ) {
    const page = await ex.fetchOHLCV(TOKO ? `${coin}/USDT` : `${coin}/USDT:USDT`, '15m', since, 1000);
    if (!page.length) break;
    for (const r of page) rows.set(r[0], r);
    since = page.at(-1)[0] + STEP;
    if (page.length < 2) break;
  }
  const c = [...rows.values()].filter((r) => r[0] + STEP <= Date.now()).sort((a, b) => a[0] - b[0]).map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  const gaps = c.filter((x, i) => i && x.t - c[i - 1].t !== STEP).length;
  if (gaps) throw new Error(`${coin}: ${gaps} gap candle`);
  return c;
}

// SOURCE=tokocrypto: candle spot Tokocrypto ke data/tokocrypto/. Default: Binance USDT-M futures ke data/.
const TOKO = process.env.SOURCE === 'tokocrypto', DIR = TOKO ? 'data/tokocrypto' : 'data';
const ex = TOKO ? new ccxt.tokocrypto() : new ccxt.binanceusdm();
mkdirSync(DIR, { recursive: true });
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const report = [];
for (const coin of COINS) {
  const c15 = await fetch15m(ex, coin);
  for (const [name, min] of Object.entries(TFS)) {
    const c = min === 15 ? c15 : aggregate(c15, min), ind = indicators(c, min), keys = Object.keys(ind);
    const from = c.findIndex((x) => x.t >= START), rows = [];
    for (let i = from; i < c.length; i++) {
      const bad = keys.filter((k) => !Number.isFinite(ind[k][i]));
      if (bad.length) throw new Error(`${coin} ${name} ${iso(c[i].t)}: NaN di ${bad.join(',')}`);
      rows.push([c[i].t, iso(c[i].t), c[i].o, c[i].h, c[i].l, c[i].c, +c[i].v.toFixed(3), ...keys.map((k) => +ind[k][i].toFixed(4))].join(','));
    }
    writeFileSync(`${DIR}/${coin}USDT_${name}.csv`, ['t,time_utc,open,high,low,close,volume,' + keys.join(','), ...rows].join('\n') + '\n');
    const r = ind.rsi14.slice(from);
    if (Math.min(...r) < 0 || Math.max(...r) > 100) throw new Error(`${coin} ${name}: RSI di luar 0-100`);
    report.push(`${coin} ${name}: ${rows.length} candle, ${iso(c[from].t)} .. ${iso(c.at(-1).t)}, ${keys.length} indikator`);
  }
}
console.log(report.join('\n'));
