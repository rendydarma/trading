import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillEntry, positionSize, settleTrade } from '../src/backtest/settle.js';
import { summarize } from '../src/backtest/stats.js';

const H = 3600000;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const candle = (i, o = {}) => ({ time: i * H, open: 100, high: 100, low: 100, close: 100, volume: 1, ...o });
const longTrade = (o = {}) => ({
  id: 't1', step: 0, decidedAt: 0, side: 'long', entryTime: 0, entryPrice: 100,
  sl: 95, tp: 110, maxHoldHours: 100, size: 2, riskAmount: 10, rationale: '', status: 'open', ...o,
});
const shortTrade = (o = {}) => longTrade({ side: 'short', sl: 105, tp: 90, ...o });
const costs = { feePct: 0, slippagePct: 0 };
const NEVER = 1e15;

test('long tp hit', () => {
  const t = settleTrade(longTrade(), [candle(0, { high: 111, low: 99 })], H, NEVER, costs);
  assert.equal(t.status, 'tp');
  assert.equal(t.exitPrice, 110);
  assert.equal(t.exitTime, H);
  near(t.pnl, 20);
  near(t.r, 2);
  near(t.pnlPct, 10);
});

test('same candle sl and tp resolves as sl', () => {
  const t = settleTrade(longTrade(), [candle(0, { high: 111, low: 94 })], H, NEVER, costs);
  assert.equal(t.status, 'sl');
  assert.equal(t.exitPrice, 95);
  near(t.pnl, -10);
  near(t.r, -1);
});

test('gap through sl exits at the open', () => {
  const t = settleTrade(longTrade(), [candle(0, { open: 93, high: 94, low: 92, close: 93 })], H, NEVER, costs);
  assert.equal(t.status, 'sl');
  assert.equal(t.exitPrice, 93);
  assert.equal(t.exitTime, 0);
  near(t.pnl, -14);
  near(t.r, -1.4);
});

test('long tp gap above fills at tp, not at open', () => {
  const t = settleTrade(longTrade(), [candle(0, { open: 115, high: 118, low: 114, close: 116 })], H, NEVER, costs);
  assert.equal(t.status, 'tp');
  assert.equal(t.exitPrice, 110);
});

test('short tp hit', () => {
  const t = settleTrade(shortTrade(), [candle(0, { low: 89, high: 101 })], H, NEVER, costs);
  assert.equal(t.status, 'tp');
  assert.equal(t.exitPrice, 90);
  near(t.pnl, 20);
});

test('short same candle sl and tp resolves as sl', () => {
  const t = settleTrade(shortTrade(), [candle(0, { low: 89, high: 106 })], H, NEVER, costs);
  assert.equal(t.status, 'sl');
  assert.equal(t.exitPrice, 105);
  near(t.pnl, -10);
  near(t.r, -1);
});

test('short gap through sl exits at the open; tp gap fills at tp', () => {
  const g = settleTrade(shortTrade(), [candle(0, { open: 107, high: 108, low: 106, close: 107 })], H, NEVER, costs);
  assert.equal(g.status, 'sl');
  assert.equal(g.exitPrice, 107);
  assert.equal(g.exitTime, 0);
  near(g.pnl, -14);
  const f = settleTrade(shortTrade(), [candle(0, { open: 85, high: 86, low: 84, close: 85 })], H, NEVER, costs);
  assert.equal(f.status, 'tp');
  assert.equal(f.exitPrice, 90);
});

test('sl exit applies slippage against the trade', () => {
  const l = settleTrade(longTrade(), [candle(0, { low: 94 })], H, NEVER, { feePct: 0, slippagePct: 1 });
  near(l.exitPrice, 95 * 0.99);
  const s = settleTrade(shortTrade(), [candle(0, { high: 106 })], H, NEVER, { feePct: 0, slippagePct: 1 });
  near(s.exitPrice, 105 * 1.01);
});

test('fees reduce pnl', () => {
  const t = settleTrade(longTrade(), [candle(0, { high: 111 })], H, NEVER, { feePct: 0.1, slippagePct: 0 });
  near(t.fees, 0.42);
  near(t.pnl, 19.58);
});

test('timeout exits at close of the first candle reaching maxHoldHours', () => {
  const rows = [0, 1, 2, 3].map((i) => candle(i, { close: 101 + i }));
  const t = settleTrade(longTrade({ maxHoldHours: 2 }), rows, H, NEVER, costs);
  assert.equal(t.status, 'timeout');
  assert.equal(t.exitTime, 2 * H);
  assert.equal(t.exitPrice, 102);
  near(t.pnl, 4);
});

test('sl/tp on the timeout candle wins over timeout', () => {
  const rows = [candle(0), candle(1, { high: 111 })];
  const t = settleTrade(longTrade({ maxHoldHours: 2 }), rows, H, NEVER, costs);
  assert.equal(t.status, 'tp');
});

test('asOf before the hit candle close leaves trade open; forceClose ends it', () => {
  const rows = [candle(0), candle(1, { high: 111 })];
  const asOf = 2 * H - 1;
  const open = settleTrade(longTrade(), rows, H, asOf, costs);
  assert.equal(open.status, 'open');
  assert.equal(open.exitPrice, undefined);
  const end = settleTrade(longTrade(), rows, H, asOf, { ...costs, forceClose: true });
  assert.equal(end.status, 'end');
  assert.equal(end.exitTime, H);
  assert.equal(end.exitPrice, 100);
});

test('forceClose with no closed candle at/after entry stays open', () => {
  const t = settleTrade(longTrade({ entryTime: 5 * H }), [candle(0)], H, NEVER, { ...costs, forceClose: true });
  assert.equal(t.status, 'open');
});

test('already closed trade is returned unchanged', () => {
  const closed = longTrade({ status: 'tp', exitTime: H, exitPrice: 110, pnl: 20, r: 2 });
  const t = settleTrade(closed, [candle(0, { low: 90 })], H, NEVER, costs);
  assert.deepEqual(t, closed);
});

test('settle does not mutate its input', () => {
  const trade = longTrade();
  const snapshot = structuredClone(trade);
  const t = settleTrade(trade, [candle(0, { high: 111 })], H, NEVER, costs);
  assert.notEqual(t, trade);
  assert.deepEqual(trade, snapshot);
  const later = settleTrade(trade, [candle(0, { high: 111 })], H, NEVER, costs);
  assert.equal(later.status, 'tp');
});

test('candles before entryTime are ignored', () => {
  const rows = [candle(0, { low: 90 }), candle(1)];
  const t = settleTrade(longTrade({ entryTime: H }), rows, H, NEVER, costs);
  assert.equal(t.status, 'open');
});

test('fillEntry applies slippage and finds the first candle at/after decidedAt', () => {
  const rows = [candle(0), candle(1, { open: 100 }), candle(2)];
  const l = fillEntry(rows, H - 1, 'long', 0.05);
  assert.equal(l.entryTime, H);
  near(l.entryPrice, 100.05);
  near(fillEntry(rows, H, 'short', 0.05).entryPrice, 99.95);
  assert.equal(fillEntry(rows, 3 * H, 'long', 0), null);
});

test('positionSize risks riskPct of equity', () => {
  assert.deepEqual(positionSize({ equity: 1000, riskPct: 1, entry: 100, sl: 95 }), { size: 2, riskAmount: 10 });
});

test('positionSize caps by leverage and recomputes riskAmount', () => {
  const p = positionSize({ equity: 1000, riskPct: 1, entry: 100, sl: 99.9 });
  near(p.size, 10, 1e-6);
  assert.ok(p.size * 100 <= 1000 + 1e-9);
  const q = positionSize({ equity: 1000, riskPct: 5, entry: 100, sl: 99, maxLeverage: 2 });
  near(q.size, 20);
  near(q.riskAmount, 20);
});

test('summarize computes headline stats and drawdown', () => {
  const pnl = [20, -10, -10, 30];
  const r = [2, -1, -1, 3];
  const trades = pnl.map((p, i) => ({
    ...longTrade({ id: `t${i}`, side: i % 2 ? 'short' : 'long' }),
    status: 'tp', entryTime: i * H, exitTime: (2 * i + 1) * H, pnl: p, r: r[i],
  }));
  const s = summarize(trades, { initialCapital: 1000 });
  assert.equal(s.totalTrades, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 2);
  assert.equal(s.netPnl, 30);
  assert.equal(s.netPnlPct, 3);
  assert.equal(s.winRate, 50);
  assert.equal(s.profitFactor, 2.5);
  assert.equal(s.expectancyR, 0.75);
  assert.equal(s.avgR, 0.75);
  assert.equal(s.maxDrawdownPct, 1.96);
  assert.equal(s.finalEquity, 1030);
  assert.equal(s.bestTrade, 30);
  assert.equal(s.worstTrade, -10);
  assert.equal(s.longs, 2);
  assert.equal(s.shorts, 2);
});

test('summarize orders by exitTime for the drawdown curve and ignores open trades', () => {
  const mk = (pnl, exitTime) => ({ ...longTrade(), status: 'tp', exitTime, pnl, r: pnl / 10 });
  // by exitTime: +20, -10, -10, +30 -> peak 1020, trough 1000 -> 1.96%
  const trades = [mk(30, 4 * H), mk(-10, 2 * H), mk(20, 1 * H), mk(-10, 3 * H), longTrade()];
  const s = summarize(trades, { initialCapital: 1000 });
  assert.equal(s.totalTrades, 4);
  assert.equal(s.maxDrawdownPct, 1.96);
});

test('summarize with no trades has no NaN', () => {
  const s = summarize([], { initialCapital: 1000 });
  assert.equal(s.totalTrades, 0);
  assert.equal(s.winRate, 0);
  assert.equal(s.maxDrawdownPct, 0);
  assert.equal(s.profitFactor, null);
  assert.equal(s.finalEquity, 1000);
  assert.equal(s.bestTrade, 0);
  assert.equal(s.worstTrade, 0);
  const nulls = Object.entries(s).filter(([, v]) => v === null).map(([k]) => k);
  assert.deepEqual(nulls, ['profitFactor']);
  assert.ok(!JSON.stringify(s).includes('NaN'));
});

test('summarize with no losses has null profitFactor', () => {
  const t = { ...longTrade(), status: 'tp', exitTime: H, pnl: 5, r: 0.5 };
  assert.equal(summarize([t], { initialCapital: 1000 }).profitFactor, null);
});
