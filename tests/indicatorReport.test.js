import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/indicatorReport.js';

const H = 3600e3;
const mk = (n) => Array.from({ length: n }, (_, i) => {
  const p = 100 + Math.sin(i / 7) * 5 + i * 0.01;
  return [i * H, p, p + 1, p - 1, p + 0.2, 10 + (i % 5)];
});
const fakeEx = (data) => ({
  id: 'fake',
  parseTimeframe: (tf) => (tf === '1d' ? 86400 : 3600),
  fetchOHLCV: async (_s, tf, since = 0, limit = 1000) =>
    tf === '1d' ? [] : data.filter((c) => c[0] >= since).slice(0, limit),
});
const now = 900 * H;

test('only+days: core keys and vwap over the last days only', async () => {
  const r = await buildReport({ ex: fakeEx(mk(900)), symbol: 'X/Y', timeframes: ['1h'], only: ['vwap'], days: 30, now });
  const t = r.timeframes['1h'];
  assert.deepEqual(Object.keys(t).sort(), ['candle', 'close', 'meta', 'vwap']);
  assert.equal(t.vwap.candles, 720);
  assert.equal(t.meta.candlesUsed, 900);
  assert.ok(r.mtf.perTf['1h']);
});

test('unknown only name lists valid names', async () => {
  await assert.rejects(
    buildReport({ ex: fakeEx(mk(900)), symbol: 'X/Y', timeframes: ['1h'], only: ['nope'], now }),
    (e) => /trend/.test(e.message) && /vwap/.test(e.message) && /nope/.test(e.message)
  );
});

test('no only: full sections', async () => {
  const r = await buildReport({ ex: fakeEx(mk(900)), symbol: 'X/Y', timeframes: ['1h'], now });
  const t = r.timeframes['1h'];
  assert.ok(t.trend && t.momentum && t.breakout);
  assert.equal(t.vwap, undefined);
  assert.equal(r.exchange, 'fake');
});

test('fewer than 30 candles gives an error entry', async () => {
  const r = await buildReport({ ex: fakeEx(mk(10)), symbol: 'X/Y', timeframes: ['1h'], now: 10 * H });
  assert.match(r.timeframes['1h'].error, /need >= 30/);
  assert.equal(r.mtf.alignment, null);
});
