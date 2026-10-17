import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchClosedCandles, sliceAsOf, ohlcvRows } from '../src/candles.js';

const H = 3600e3;
const all = Array.from({ length: 2500 }, (_, i) => [i * H, 1, 2, 0.5, 1.5, 10]);
const fakeEx = (data) => ({
  parseTimeframe: () => 3600,
  fetchOHLCV: async (_s, _tf, since = 0, limit = 1000) => data.filter((c) => c[0] >= since).slice(0, limit),
});

test('paginates, dedupes and returns objects oldest first', async () => {
  const { ms, rows } = await fetchClosedCandles(fakeEx(all), 'BTC/USDT', '1h', { since: 0, until: 2499 * H, now: 1e15 });
  assert.equal(ms, H);
  assert.equal(rows.length, 2500);
  assert.deepEqual(rows[1], { time: H, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].time > rows[i - 1].time);
});

test('drops the still-forming candle', async () => {
  const { rows } = await fetchClosedCandles(fakeEx(all), 'BTC/USDT', '1h', { since: 0, until: 2499 * H, now: 10 * H + 1000 });
  assert.equal(rows.at(-1).time, 9 * H);
});

test('empty exchange response gives empty rows', async () => {
  assert.deepEqual(await fetchClosedCandles(fakeEx([]), 'BTC/USDT', '1h', { since: 0 }), { ms: H, rows: [] });
});

test('sliceAsOf keeps only candles closed by t', () => {
  const rows = all.map(([time]) => ({ time }));
  assert.equal(sliceAsOf(rows, H, 5 * H + H).at(-1).time, 5 * H);
  assert.equal(sliceAsOf(rows, H, 5 * H + 3599999).at(-1).time, 4 * H);
});

const counting = (data) => {
  const ex = fakeEx(data);
  const f = ex.fetchOHLCV;
  ex.calls = 0;
  ex.fetchOHLCV = (...a) => (ex.calls++, f(...a));
  return ex;
};

test('ohlcvRows with since+limit returns exactly limit rows in one bounded call', async () => {
  const ex = counting(all);
  const rows = await ohlcvRows(ex, 'BTC/USDT', '1h', { since: 0, limit: 10, now: 1e15 });
  assert.equal(rows.length, 10);
  assert.equal(rows.at(-1)[0], 9 * H);
  assert.equal(ex.calls, 1);
});

test('ohlcvRows without since makes a single call and maps rows to arrays', async () => {
  const ex = counting(all);
  const rows = await ohlcvRows(ex, 'BTC/USDT', '1h', { limit: 5, now: 1e15 });
  assert.equal(ex.calls, 1);
  assert.deepEqual(rows[0], [0, 1, 2, 0.5, 1.5, 10]);
});

test('ohlcvRows closedOnly=false returns raw fetchOHLCV output', async () => {
  const ex = counting(all);
  const rows = await ohlcvRows(ex, 'BTC/USDT', '1h', { since: 0, limit: 3, closedOnly: false });
  assert.deepEqual(rows, all.slice(0, 3));
  assert.equal(ex.calls, 1);
});

test('ohlcvRows with since and no limit is capped at 1000 rows', async () => {
  const ex = counting(all);
  const rows = await ohlcvRows(ex, 'BTC/USDT', '1h', { since: 0, now: 1e15 });
  assert.equal(rows.length, 1000);
  assert.equal(rows.at(-1)[0], 999 * H);
  assert.equal(ex.calls, 1);
});
