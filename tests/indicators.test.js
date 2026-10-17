import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../src/indicators.js';

const near = (x, y, eps = 1e-9) => assert.ok(Math.abs(x - y) < eps, `${x} != ${y}`);
const candle = (o, h, l, c, v = 1, time = 0) => ({ time, open: o, high: h, low: l, close: c, volume: v });
const D = 86400000;
const names = (c) => I.patterns(c).filter((p) => p.ago === 0).map((p) => p.name);
// previous candle that triggers no pattern, then x
const withPrev = (x) => [candle(5, 20, -10, 6), x];

test('anchoredVwap: weighted mean and band', () => {
  const r = I.anchoredVwap([candle(10, 10, 10, 10, 1, 0), candle(20, 20, 20, 20, 3, 1)]);
  near(r.value, 17.5, 1e-3); near(r.upper - r.value, 4.3301, 1e-3); near(r.value - r.lower, 4.3301, 1e-3);
  near(r.devPct, (20 / 17.5 - 1) * 100, 1e-3);
  assert.equal(r.candles, 2); assert.equal(r.anchorStart, new Date(0).toISOString());
});

test('anchoredVwap: day anchor uses only the last UTC day', () => {
  const c = [candle(1, 1, 1, 1, 5, D - 1000), candle(10, 10, 10, 10, 1, D), candle(20, 20, 20, 20, 3, D + 1000)];
  const r = I.anchoredVwap(c, 'day');
  near(r.value, 17.5, 1e-3); assert.equal(r.candles, 2); assert.equal(r.anchorStart, new Date(D).toISOString());
});

test('anchoredVwap: week starts Monday, month starts on the 1st', () => {
  const t = (s) => Date.parse(s);
  const c = [candle(1, 1, 1, 1, 1, t('2026-10-10T12:00:00Z')), candle(2, 2, 2, 2, 1, t('2026-10-12T00:00:00Z')), candle(3, 3, 3, 3, 1, t('2026-10-15T08:00:00Z'))];
  const w = I.anchoredVwap(c, 'week');
  assert.equal(w.anchorStart, '2026-10-12T00:00:00.000Z'); assert.equal(w.candles, 2);
  const m = I.anchoredVwap(c, 'month');
  assert.equal(m.anchorStart, '2026-10-01T00:00:00.000Z'); assert.equal(m.candles, 3);
  const sun = I.anchoredVwap([candle(1, 1, 1, 1, 1, t('2026-10-11T23:00:00Z'))], 'week'); // Sunday -> previous Monday
  assert.equal(sun.anchorStart, '2026-10-05T00:00:00.000Z');
});

test('anchoredVwap: zero volume -> null', () => {
  assert.equal(I.anchoredVwap([candle(10, 10, 10, 10, 0), candle(11, 11, 11, 11, 0, 1)]), null);
});

test('pinBar: small body, long lower wick', () => {
  const c = withPrev(candle(7, 10, 0, 8)); // body .1, lower .7, upper .2
  assert.ok(names(c).includes('pinBar')); assert.ok(!names(c).includes('hammer'));
});

test('pinBar: suppressed when hammer is reported', () => {
  const c = withPrev(candle(7, 10, 0, 9)); // body .2, lower .7, upper .1
  assert.ok(names(c).includes('hammer')); assert.ok(!names(c).includes('pinBar'));
});

test('pinBar: big body is not a pin bar', () => {
  assert.ok(!names(withPrev(candle(5, 10, 0, 10))).includes('pinBar'));
});

test('macd of constant closes is exactly 0', () => {
  const m = I.macd(Array(60).fill(100));
  assert.ok(m.line.at(-1) === 0 && m.signal.at(-1) === 0 && m.hist.at(-1) === 0);
});

test('bollinger of 1..20', () => {
  const b = I.bollinger(Array.from({ length: 20 }, (_, i) => i + 1));
  near(b.mid.at(-1), 10.5); near(b.upper.at(-1), 22.0326, 1e-3);
});

test('keltner on flat candles', () => {
  const k = I.keltner(Array.from({ length: 30 }, (_, i) => candle(10, 12, 8, 10, 1, i)));
  near(k.upper.at(-1), 16); near(k.lower.at(-1), 4);
});

test('cci', () => {
  near(I.cci(Array.from({ length: 20 }, (_, i) => candle(i + 1, i + 1, i + 1, i + 1))), 126.667, 1e-3);
});

test('mfi on a rising series is 100', () => {
  assert.equal(I.mfi(Array.from({ length: 20 }, (_, i) => candle(i, i + 1, i, i + 1))), 100);
});

test('stochRsi on a rising series: k = 50', () => {
  assert.equal(I.stochRsi(Array.from({ length: 40 }, (_, i) => i + 1)).k.at(-1), 50);
});

test('ichimoku', () => {
  const rise = (n) => Array.from({ length: n }, (_, i) => candle(10 + i, 11 + i, 9 + i, 10 + i));
  assert.equal(I.ichimoku(rise(77)), null);
  const k = I.ichimoku(rise(100));
  assert.equal(k.priceVsCloud, 'above'); assert.equal(k.tenkanAboveKijun, true);
});

test('divergence: bullish when price lower-lows and RSI higher-lows', () => {
  const c = Array.from({ length: 50 }, (_, i) => {
    const lo = i === 20 ? 5 : i === 40 ? 4 : 10 + 0.01 * i;
    return candle(lo + 0.5, 10 + 0.01 * i + 1, lo, lo + 0.5);
  });
  const rs = Array(50).fill(null); rs[20] = 30; rs[40] = 35;
  const d = I.divergence(c, rs);
  assert.equal(d.bullish, true); assert.equal(d.bearish, false);
});
