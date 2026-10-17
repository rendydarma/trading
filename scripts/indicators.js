// Usage: node scripts/indicators.js <SYMBOL> [--tf 15m,1h,1d] [--exchange tokocrypto] [--limit 1000]
//          [--format json|table] [--out file] [--history N]
//          [--days N] [--only trend,momentum,...,vwap] [--vwap-anchor day|week|month|period]
//        node scripts/indicators.js --test
// Public data only (no API key). Closed candles only; the in-progress candle is dropped.
// --history N prints the last N rows of the key series as CSV (one block per timeframe, with a tf column).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as I from '../src/indicators.js';
import { buildReport } from '../src/indicatorReport.js';
import { fetchClosedCandles } from '../src/candles.js';

const near = (x, y, eps = 1e-9) => assert.ok(Math.abs(x - y) < eps, `${x} != ${y}`);
const candle = (o, h, l, c, v = 1, time = 0) => ({ time, open: o, high: h, low: l, close: c, volume: v });

function selfTest() {
  near(I.sma([1, 2, 3, 4], 2).at(-1), 3.5);
  near(I.ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3).at(-1), 9);
  near(I.rsi([10, 11, 10, 11], 2).at(-1), 75); // hand-computed Wilder RSI
  near(I.rsi([1, 2, 3, 4, 5], 2).at(-1), 100);

  const flat = Array.from({ length: 30 }, (_, i) => candle(10, 12, 8, 10, 5, i));
  near(I.atr(flat).at(-1), 4);

  // constant uptrend: TR 2, +DM 1, -DM 0 -> +DI 50, -DI 0, ADX 100
  const up = Array.from({ length: 60 }, (_, i) => candle(10 + i, 11 + i, 9 + i, 10 + i, 1, i));
  const a = I.adx(up);
  near(a.adx.at(-1), 100); near(a.plusDI.at(-1), 50); near(a.minusDI.at(-1), 0);

  // stochastic: close at the high -> 100, close at the low -> 0
  assert.equal(I.stoch(Array.from({ length: 30 }, (_, i) => candle(i, i + 1, i, i + 1))).k.at(-1), 100);
  assert.equal(I.stoch(Array.from({ length: 30 }, (_, i) => candle(30 - i, 31 - i, 30 - i, 30 - i))).k.at(-1), 0);

  assert.equal(I.obv([10, 11, 10, 10].map((x, i) => candle(x, x, x, x, [5, 3, 2, 4][i]))).at(-1), 1);

  // supertrend flips down after a sharp reversal
  const rev = Array.from({ length: 80 }, (_, i) => {
    const x = i < 40 ? 100 + i : 139 - 5 * (i - 39);
    return candle(x, x + 1, x - 1, x);
  });
  const st = I.supertrend(rev).dir;
  assert.equal(st[39], 1); assert.equal(st.at(-1), -1);

  // fibonacci: upswing low 0 -> high 100; 0.382 retracement = 61.8
  const sw = Array.from({ length: 10 }, (_, i) => candle(i * 10, i === 9 ? 100 : i * 10 + 1, i === 0 ? 0 : i * 10, i * 10, 1, i));
  const fib = I.fibonacci(sw);
  assert.equal(fib.swing, 'up'); near(fib.levels[0.382], 61.8);

  const pp = I.dailyPivots({ high: 12, low: 8, close: 10 });
  assert.deepEqual([pp.P, pp.R1, pp.R2, pp.R3, pp.S1, pp.S2, pp.S3], [10, 12, 14, 16, 8, 6, 4]);

  const names = (c) => I.patterns(c).filter((p) => p.ago === 0).map((p) => p.name);
  assert.ok(names([candle(10, 11, 9, 10), candle(10, 12, 8, 10.05)]).includes('doji'));
  assert.ok(names([candle(10, 11, 9, 10), candle(10, 10.1, 6, 10.05)]).includes('hammer'));
  assert.ok(names([candle(10, 11, 9, 10), candle(10, 14, 9.9, 10.05)]).includes('shootingStar'));
  assert.ok(names([candle(10, 10.5, 8.8, 9), candle(8.9, 10.2, 8.8, 10.1)]).includes('bullishEngulfing'));
  assert.ok(names([candle(9, 10.2, 8.8, 10), candle(10.1, 10.2, 8.7, 8.9)]).includes('bearishEngulfing'));
  assert.ok(names([candle(10, 12, 8, 11), candle(10, 11, 9, 10.5)]).includes('insideBar'));

  // pivots: swing highs 9 and 8, price 7.5 -> nearest resistance 8, support 6 (lows are high-1)
  const pv = [5, 6, 7, 9, 7, 6, 5, 6, 7, 8, 7, 6, 5].map((h, i) => candle(h, h, h - 1, h, 1, i));
  assert.equal(I.levels(pv, 7.5, { k: 2 }).resistances[0].price, 8);

  // breakout on a flat series, and short history must warm up to null, not throw
  const r = I.compute([...flat, candle(10, 20, 10, 20, 10, 31)]);
  assert.equal(r.breakout.up, true);
  assert.equal(r.breakout.volumeConfirmed, true); // 10 / 5 >= 1.5
  const short = I.compute(flat.slice(0, 12));
  assert.equal(short.trend.ema[200], null);
  assert.equal(short.meta.warmupOk.ema200, false);
  assert.ok(!JSON.stringify(short).includes('NaN') && !JSON.stringify(r).includes('Infinity'));
  console.log('self-test OK');
}

const fmt = (v) => (v == null ? '-' : typeof v === 'number' ? String(Number(v.toPrecision(5))) : String(v));

function table(out) {
  const lines = [`${out.exchange} ${out.symbol}  @ ${out.fetchedAt}  MTF: ${out.mtf.alignment} (${Object.entries(out.mtf.perTf).map(([tf, t]) => `${tf}:${t.trend}`).join(' ')})`];
  for (const [tf, t] of Object.entries(out.timeframes)) {
    if (t.error) { lines.push('', `[${tf}] ${t.error}`); continue; }
    const { trend: tr, momentum: mo, volatility: vo, volume: vl, levels: lv, breakout: br } = t;
    const flags = Object.entries({ up: br.up, down: br.down, up55: br.up55, down55: br.down55, falseUp: br.falseBreakUp, falseDown: br.falseBreakDown, retestUp: br.retestUp, retestDown: br.retestDown }).filter(([, v]) => v).map(([k]) => k);
    lines.push('', `[${tf}] ${t.candle}  close ${fmt(t.close)}  trend ${tr.state.toUpperCase()}`,
      `  trend  EMA ${Object.values(tr.ema).map(fmt).join('/')}  ema21 slope ${fmt(tr.ema21SlopePctPerCandle)}%/c  vs200 ${fmt(tr.distFromEma200Pct)}%  ADX ${fmt(tr.adx.adx)} (+${fmt(tr.adx.plusDI)}/-${fmt(tr.adx.minusDI)})  ST ${tr.supertrend?.dir ?? '-'}${tr.supertrend?.flippedOnLastCandle ? ' (flip)' : ''}  cloud ${tr.ichimoku?.priceVsCloud ?? '-'}`,
      `  mom    RSI ${fmt(mo.rsi14)}  StochRSI ${fmt(mo.stochRsi.k)}/${fmt(mo.stochRsi.d)}  MACD hist ${fmt(mo.macd.hist)}  CCI ${fmt(mo.cci20)}  MFI ${fmt(mo.mfi14)}  W%R ${fmt(mo.williamsR14)}  div ${mo.divergence.bullish ? 'BULL' : mo.divergence.bearish ? 'BEAR' : 'none'}`,
      `  vol    ATR ${fmt(vo.atrPct)}%  BB %B ${fmt(vo.bollinger.pctB)}  bw pctile ${fmt(vo.bollinger.bandwidthPercentile)}  squeeze ${fmt(vo.squeeze)}  histVol ${fmt(vo.histVolPct)}%  compressed ${vo.compression.compressed}`,
      `  volume ratio ${fmt(vl.ratio)}  z ${fmt(vl.zScore50)}  OBV>EMA ${fmt(vl.obv.aboveEma21)}  VWAP ${fmt(vl.vwap)}`,
      `  levels S ${lv.supports.map((s) => s.price).join(',') || '-'}  R ${lv.resistances.map((s) => s.price).join(',') || '-'}  fib near ${fmt(lv.fibonacci?.nearest.ratio)}@${fmt(lv.fibonacci?.nearest.price)}  structure ${fmt(lv.structure)}`,
      `  break  ${flags.join(' ') || 'none'}  volConfirmed ${br.volumeConfirmed}  patterns ${t.patterns.map((p) => `${p.name}[${p.ago}]`).join(' ') || 'none'}`);
  }
  return lines.join('\n');
}

function csv(rows) {
  const keys = Object.keys(rows[0]);
  return [keys.join(','), ...rows.map((r) => keys.map((k) => r[k] ?? '').join(','))].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--test')) return selfTest();
  const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
  const symbol = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!symbol) throw new Error('Usage: node scripts/indicators.js <SYMBOL e.g. ADA/USDT> [--tf 15m,1h,1d] [--exchange tokocrypto] [--limit 1000] [--format json|table] [--out file] [--history N] [--days N] [--only a,b] [--vwap-anchor day|week|month|period]');

  const { getExchange } = await import('../src/exchange.js');
  const ex = getExchange(opt('--exchange', 'tokocrypto'));
  const limit = Number(opt('--limit', 1000)), history = Number(opt('--history', 0));
  const tfs = opt('--tf', '15m,1h,1d').split(',');
  const days = opt('--days') ? Number(opt('--days')) : undefined;
  const only = opt('--only') ? opt('--only').split(',') : null;
  let text;
  if (history > 0) {
    const sets = await Promise.all(tfs.map((tf) => fetchClosedCandles(ex, symbol, tf, { limit })));
    text = sets.map(({ rows }, i) => csv(I.seriesTable(rows.slice(-history)).map((r) => ({ tf: tfs[i], ...r })))).join('\n');
  } else {
    const out = await buildReport({ ex, symbol, timeframes: tfs, limit, days, only, vwapAnchor: opt('--vwap-anchor', 'period') });
    text = opt('--format', 'json') === 'table' && !only ? table(out) : JSON.stringify(out, null, 2);
  }

  if (opt('--out')) { writeFileSync(opt('--out'), text); console.log(`saved ${opt('--out')}`); }
  else console.log(text);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
