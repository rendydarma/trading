import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOrder, prepareOrder } from '../src/guard.js';

const order = { exchange: 'binance', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 1 };
const live = { TRADING_LIVE: 'true', MAX_ORDER_NOTIONAL: '100', MAX_ORDER_QUOTE: 'USDT' };
const ctx = (env = live, extra = {}) => ({ env, lastPrice: 50, quote: 'USDT', ...extra });

test('passes when live, under max: notional = amount * lastPrice', () => {
  assert.deepEqual(checkOrder(order, ctx()), { ok: true, notional: 50 });
});

test('limit order uses its own price for notional', () => {
  const r = checkOrder({ ...order, type: 'limit', price: 80 }, ctx());
  assert.deepEqual(r, { ok: true, notional: 80 });
});

test('blocks unless TRADING_LIVE is exactly "true"', () => {
  for (const v of [undefined, 'false', 'TRUE', '1']) {
    const r = checkOrder(order, ctx({ ...live, TRADING_LIVE: v }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /TRADING_LIVE/);
  }
});

test('blocks when MAX_ORDER_NOTIONAL is missing, NaN or not positive', () => {
  for (const v of [undefined, '', 'abc', '0', '-5']) {
    const r = checkOrder(order, ctx({ TRADING_LIVE: 'true', MAX_ORDER_NOTIONAL: v }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /MAX_ORDER_NOTIONAL/);
  }
});

test('ALLOWED_SYMBOLS is a case-insensitive allowlist when set', () => {
  const env = { ...live, ALLOWED_SYMBOLS: 'eth/usdt, btc/usdt' };
  assert.equal(checkOrder(order, ctx(env)).ok, true);
  const r = checkOrder({ ...order, symbol: 'SOL/USDT' }, ctx(env));
  assert.equal(r.ok, false);
  assert.match(r.reason, /ALLOWED_SYMBOLS/);
});

test('ALLOWED_SYMBOLS set but empty after parsing blocks; unset/empty means no allowlist', () => {
  for (const v of [',', ' ', ' , ']) {
    const r = checkOrder(order, ctx({ ...live, ALLOWED_SYMBOLS: v }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /ALLOWED_SYMBOLS/);
  }
  for (const v of [undefined, '']) assert.equal(checkOrder(order, ctx({ ...live, ALLOWED_SYMBOLS: v })).ok, true);
});

test('market order ignores a caller price: cap uses lastPrice', () => {
  const r = checkOrder({ ...order, amount: 4, price: 20 }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeds/);
});

test('limit sell priced below market is capped at lastPrice', () => {
  const r = checkOrder({ ...order, side: 'sell', type: 'limit', amount: 4, price: 20 }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeds/);
});

test('blocks notional over MAX_ORDER_NOTIONAL', () => {
  const r = checkOrder({ ...order, amount: 3 }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeds/);
});

test('blocks notional below exchange minimum', () => {
  const r = checkOrder(order, ctx(live, { minNotional: 60 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /minimum/);
});

test('fails closed when notional cannot be computed', () => {
  const r = checkOrder(order, ctx(live, { lastPrice: undefined }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /last price/);
});

test('rules run in order: TRADING_LIVE before MAX_ORDER_NOTIONAL', () => {
  const r = checkOrder(order, ctx({}));
  assert.match(r.reason, /TRADING_LIVE/);
});

test('blocks when MAX_ORDER_QUOTE is unset or blank', () => {
  for (const v of [undefined, '', '  ']) {
    const r = checkOrder(order, ctx({ ...live, MAX_ORDER_QUOTE: v }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /MAX_ORDER_QUOTE/);
  }
});

test('blocks when market quote differs from MAX_ORDER_QUOTE, or is missing', () => {
  const r = checkOrder(order, ctx(live, { quote: 'IDR' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /MAX_ORDER_QUOTE/);
  assert.match(r.reason, /IDR/);
  assert.match(r.reason, /USDT/);
  for (const quote of [undefined, null, '']) {
    const m = checkOrder(order, ctx(live, { quote }));
    assert.equal(m.ok, false);
    assert.match(m.reason, /MAX_ORDER_QUOTE/);
  }
});

test('MAX_ORDER_QUOTE matches case-insensitively', () => {
  assert.equal(checkOrder(order, ctx({ ...live, MAX_ORDER_QUOTE: 'usdt' }, { quote: 'USDT' })).ok, true);
  assert.equal(checkOrder(order, ctx(live, { quote: 'usdt' })).ok, true);
});

test('rules run in order: MAX_ORDER_NOTIONAL before MAX_ORDER_QUOTE before ALLOWED_SYMBOLS', () => {
  const env = { TRADING_LIVE: 'true', ALLOWED_SYMBOLS: 'ETH/USDT' };
  assert.match(checkOrder(order, ctx(env)).reason, /MAX_ORDER_NOTIONAL/);
  assert.match(checkOrder(order, ctx({ ...env, MAX_ORDER_NOTIONAL: '100' })).reason, /MAX_ORDER_QUOTE/);
  assert.match(checkOrder(order, ctx({ ...env, MAX_ORDER_NOTIONAL: '100', MAX_ORDER_QUOTE: 'USDT' })).reason, /ALLOWED_SYMBOLS/);
});

function fakeEx(calls, priceToPrecision = (s, p) => String(Math.floor(p * 10) / 10)) {
  return {
    loadMarkets: async () => ({ 'BTC/USDT': { quote: 'USDT', limits: { cost: { min: 10 } } } }),
    fetchTicker: async () => ({ last: 50 }),
    amountToPrecision: (s, a) => String(Math.floor(a * 100) / 100),
    priceToPrecision,
    createOrder: async (...args) => {
      calls.push(args);
      return { id: 'x' };
    },
  };
}

test('prepareOrder: blocked order never calls createOrder', async () => {
  const calls = [];
  const r = await prepareOrder(fakeEx(calls), order, { TRADING_LIVE: 'false' });
  assert.equal(r.submitted, false);
  assert.equal(r.blocked, true);
  assert.match(r.reason, /TRADING_LIVE/);
  assert.equal(calls.length, 0);
});

test('prepareOrder: below exchange minimum is blocked', async () => {
  const calls = [];
  const r = await prepareOrder(fakeEx(calls), { ...order, amount: 0.1 }, live);
  assert.equal(r.blocked, true);
  assert.match(r.reason, /minimum/);
  assert.equal(calls.length, 0);
});

test('prepareOrder: allowed market order is precision-rounded', async () => {
  const calls = [];
  const r = await prepareOrder(fakeEx(calls), { ...order, amount: 1.239 }, live);
  assert.equal(r.submitted, true);
  assert.deepEqual(calls, [['BTC/USDT', 'market', 'buy', 1.23, undefined]]);
});

test('prepareOrder: limit order rounds amount and price', async () => {
  const calls = [];
  await prepareOrder(fakeEx(calls), { ...order, type: 'limit', amount: 1.239, price: 9.99 }, live);
  assert.deepEqual(calls, [['BTC/USDT', 'limit', 'buy', 1.23, 9.9]]);
});

test('prepareOrder: market order with a low caller price is blocked, createOrder not called', async () => {
  const calls = [];
  const r = await prepareOrder(fakeEx(calls), { ...order, amount: 4, price: 20 }, live);
  assert.equal(r.blocked, true);
  assert.match(r.reason, /exceeds/);
  assert.equal(calls.length, 0);
});

test('prepareOrder: limit price rounding up over the cap is blocked', async () => {
  const calls = [];
  const roundUp = (s, p) => String(Math.ceil(p));
  const env = { ...live, MAX_ORDER_NOTIONAL: '99.9' };
  const limit = { ...order, type: 'limit', amount: 1, price: 99.5 };
  assert.equal(checkOrder(limit, ctx(env)).ok, true); // unrounded would pass
  const r = await prepareOrder(fakeEx(calls, roundUp), limit, env);
  assert.equal(r.blocked, true);
  assert.match(r.reason, /exceeds/);
  assert.equal(calls.length, 0);
});

test('prepareOrder: amount rounding to zero is blocked', async () => {
  const calls = [];
  const r = await prepareOrder(fakeEx(calls), { ...order, amount: 0.001 }, live);
  assert.equal(r.blocked, true);
  assert.equal(calls.length, 0);
});

test('blocks when last price is null, 0, NaN or undefined (limit and market)', () => {
  const limitSell = { ...order, side: 'sell', type: 'limit', amount: 4, price: 20 };
  for (const lastPrice of [null, 0, NaN, undefined, -1]) {
    for (const o of [limitSell, order]) {
      const r = checkOrder(o, ctx(live, { lastPrice }));
      assert.equal(r.ok, false);
      assert.match(r.reason, /last price/);
    }
  }
});

test('prepareOrder: ticker last null/0 with a low limit sell is blocked, createOrder not called', async () => {
  for (const last of [null, 0]) {
    const calls = [];
    const ex = { ...fakeEx(calls), fetchTicker: async () => ({ last }) };
    const r = await prepareOrder(ex, { ...order, side: 'sell', type: 'limit', amount: 4, price: 20 }, live);
    assert.equal(r.blocked, true);
    assert.match(r.reason, /last price/);
    assert.equal(calls.length, 0);
  }
});

test('prepareOrder: limit price rounding to 0 is blocked', async () => {
  const calls = [];
  const r = await prepareOrder(
    fakeEx(calls, () => '0'),
    { ...order, type: 'limit', amount: 1, price: 0.01 },
    live
  );
  assert.equal(r.blocked, true);
  assert.match(r.reason, /limit price/);
  assert.equal(calls.length, 0);
});

test('prepareOrder: market quote mismatch or missing is blocked, createOrder not called', async () => {
  for (const mkt of [{ quote: 'IDR' }, {}, undefined]) {
    const calls = [];
    const ex = { ...fakeEx(calls), loadMarkets: async () => ({ 'BTC/USDT': mkt }) };
    const r = await prepareOrder(ex, order, live);
    assert.equal(r.blocked, true);
    assert.match(r.reason, /MAX_ORDER_QUOTE/);
    assert.equal(calls.length, 0);
  }
});

test('prepareOrder: MAX_ORDER_QUOTE unset is blocked, createOrder not called', async () => {
  const calls = [];
  const r = await prepareOrder(fakeEx(calls), order, { TRADING_LIVE: 'true', MAX_ORDER_NOTIONAL: '100' });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /MAX_ORDER_QUOTE/);
  assert.equal(calls.length, 0);
});
