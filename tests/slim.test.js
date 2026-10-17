import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slimTicker, slimBalance, slimOrderBook } from '../src/slim.js';

test('slimTicker drops info and keeps the picked fields', () => {
  const t = { symbol: 'BTC/USDT', last: 1, bid: 0.9, ask: 1.1, info: { raw: 1 }, vwap: 5, timestamp: 7 };
  const s = slimTicker(t);
  assert.equal('info' in s, false);
  assert.equal('vwap' in s, false);
  assert.equal(s.symbol, 'BTC/USDT');
  assert.equal(s.last, 1);
  assert.equal(s.timestamp, 7);
  const full = slimTicker({ change: 1, percentage: 2, baseVolume: 3, quoteVolume: 4 });
  assert.deepEqual([full.change, full.percentage, full.baseVolume, full.quoteVolume], [1, 2, 3, 4]);
});

test('slimBalance keeps only assets with total > 0', () => {
  const b = { total: { BTC: 1, ETH: 0 }, free: { BTC: 1, ETH: 0 }, used: { BTC: 0, ETH: 0 }, info: {} };
  assert.deepEqual(slimBalance(b), { BTC: { free: 1, used: 0, total: 1 } });
});

test('slimOrderBook truncates to depth (default 20)', () => {
  const lv = Array.from({ length: 50 }, (_, i) => [i, 1]);
  const ob = { symbol: 'BTC/USDT', timestamp: 1, bids: lv, asks: lv, nonce: 9 };
  const s = slimOrderBook(ob, 5);
  assert.equal(s.bids.length, 5);
  assert.equal(s.asks.length, 5);
  assert.equal('nonce' in s, false);
  assert.equal(slimOrderBook(ob).bids.length, 20);
});
