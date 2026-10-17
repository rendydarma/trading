import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, getStep, submitDecision, getRunStatus } from '../src/backtest/session.js';
import { compactSnapshot } from '../src/backtest/snapshot.js';
import { compute } from '../src/indicators.js';
import { sliceAsOf } from '../src/candles.js';
import { settleTrade } from '../src/backtest/settle.js';
import { D, END, H, SENTINEL, fakeEx, price } from './helpers/fakeEx.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'bt-'));
const opts = (dir, o = {}) => ({ exchange: 'binance', symbol: 'BTC/USDT', days: 3, stepHours: 4, endTime: END, dir, ...o });
const runDir = (dir, id) => join(dir, id);
const readState = (dir, id) => JSON.parse(readFileSync(join(runDir(dir, id), 'state.json'), 'utf8'));
const readCandles = (dir, id, tf) => JSON.parse(readFileSync(join(runDir(dir, id), `candles-${tf}.json`), 'utf8'));
const writeCandles = (dir, id, tf, data) => writeFileSync(join(runDir(dir, id), `candles-${tf}.json`), JSON.stringify(data));
const leaks = (payload) => /(?<![\d.])999999(?!\d)/.test(JSON.stringify(payload));

function expected(state, C, t) {
  const { feePct, slippagePct, initialCapital, baseTimeframe } = state.params;
  const prevDaily = C['1d'] && sliceAsOf(C['1d'].rows, C['1d'].ms, t).at(-1);
  const snapshots = Object.fromEntries(
    Object.entries(C).map(([tf, { ms, rows }]) => [tf, compactSnapshot(compute(sliceAsOf(rows, ms, t), { ms, prevDaily }))]),
  );
  const base = C[baseTimeframe];
  const settled = state.trades.map((tr) => settleTrade(tr, base.rows, base.ms, t, { feePct, slippagePct }));
  const open = settled.find((s) => s.status === 'open');
  const closed = settled.filter((s) => s.status !== 'open').sort((a, b) => a.exitTime - b.exitTime);
  return {
    snapshots,
    position: open ? { side: open.side, entryTime: new Date(open.entryTime).toISOString(), entryPrice: open.entryPrice, sl: open.sl, tp: open.tp } : null,
    lastClosedTrade: closed.at(-1) ?? null,
    equity: initialCapital + closed.reduce((s, x) => s + x.pnl, 0),
  };
}

test('no lookahead at any step of a full run; position and equity settled only as of t', async () => {
  const dir = tmp();
  const { runId, totalSteps, startTime, stepMs } = await createRun(fakeEx(), opts(dir));
  const tfs = ['1h', '4h', '1d'];
  const original = Object.fromEntries(tfs.map((tf) => [tf, readCandles(dir, runId, tf)]));
  for (const tf of tfs) assert.ok(original[tf].rows.every((r) => r.time + original[tf].ms <= END && r.high !== SENTINEL));

  let trades = 0, sawClosed = false, sawBlocked = false;
  for (let k = 0; k < totalSteps; k++) {
    const t = startTime + k * stepMs;
    for (const tf of tfs) {
      const { ms, rows } = original[tf];
      writeCandles(dir, runId, tf, { ...original[tf], rows: rows.map((r) => (r.time + ms > t ? { ...r, high: SENTINEL } : r)) });
    }
    const p = await getStep(runId, dir);
    assert.equal(p.stepIndex, k);
    assert.equal(p.asOf, new Date(t).toISOString());
    assert.ok(!leaks(p), `step ${k} leaks sentinel`);
    assert.ok(p.snapshots['1h'].candle <= p.asOf);
    const exp = expected(readState(dir, runId), original, t);
    assert.deepEqual(p.snapshots, exp.snapshots);
    assert.deepEqual(p.position, exp.position);
    assert.deepEqual(p.lastClosedTrade, exp.lastClosedTrade);
    assert.ok(Math.abs(p.equity - exp.equity) < 1e-9);
    if (p.lastClosedTrade) sawClosed = true;

    const close = p.snapshots['1h'].close;
    const side = k % 2 ? 'short' : 'long';
    const levels = side === 'long' ? { sl: close * 0.98, tp: close * 1.02 } : { sl: close * 1.02, tp: close * 0.98 };
    if (p.position) {
      const rej = await submitDecision(runId, k, { action: side, ...levels, rationale: 'x' }, dir);
      assert.equal(rej.accepted, false);
      sawBlocked = true;
      assert.deepEqual(await submitDecision(runId, k, { action: 'none', rationale: 'hold' }, dir), { accepted: true, nextStep: k + 1 < totalSteps ? k + 1 : null });
    } else {
      const res = await submitDecision(runId, k, { action: side, ...levels, maxHoldHours: 12, rationale: 'x' }, dir);
      assert.equal(res.accepted, true);
      trades = readState(dir, runId).trades.length;
    }
  }
  for (const tf of tfs) writeCandles(dir, runId, tf, original[tf]);
  assert.deepEqual(await getStep(runId, dir), { done: true });
  assert.ok(trades > 0 && sawClosed && sawBlocked);
  assert.equal(getRunStatus(runId, dir).done, true);
});

test('createRun persists files, runId format, no candles closing after endTime, unique ids', async () => {
  const dir = tmp();
  const a = await createRun(fakeEx(), opts(dir));
  const b = await createRun(fakeEx(), opts(dir));
  assert.match(a.runId, /^BTCUSDT-\d{8}-\d{6}/);
  assert.notEqual(a.runId, b.runId);
  assert.equal(a.stepMs, 4 * H);
  assert.equal(a.startTime % a.stepMs, 0);
  assert.equal(a.totalSteps, 18);
  assert.deepEqual(readdirSync(runDir(dir, a.runId)).sort(), ['candles-1d.json', 'candles-1h.json', 'candles-4h.json', 'state.json']);
  const h = readCandles(dir, a.runId, '1h');
  assert.ok(h.rows[0].time <= a.startTime - 250 * H);
  assert.equal(h.rows.at(-1).time + h.ms, END);
});

test('getStep idempotent; wrong or repeated stepIndex rejected without state change', async () => {
  const dir = tmp();
  const { runId } = await createRun(fakeEx(), opts(dir));
  assert.equal((await getStep(runId, dir)).stepIndex, 0);
  assert.equal((await getStep(runId, dir)).stepIndex, 0);
  const wrong = await submitDecision(runId, 1, { action: 'none', rationale: '' }, dir);
  assert.equal(wrong.accepted, false);
  assert.equal(getRunStatus(runId, dir).currentStep, 0);
  assert.deepEqual(await submitDecision(runId, 0, { action: 'none', rationale: '' }, dir), { accepted: true, nextStep: 1 });
  assert.equal((await submitDecision(runId, 0, { action: 'none', rationale: '' }, dir)).accepted, false);
  assert.deepEqual(getRunStatus(runId, dir), { runId, currentStep: 1, totalSteps: 18, decisions: 1, trades: 0, done: false });
});

test('invalid actions and levels are rejected and leave state untouched', async () => {
  const dir = tmp();
  const { runId } = await createRun(fakeEx(), opts(dir));
  const c = (await getStep(runId, dir)).snapshots['1h'].close;
  const before = readFileSync(join(runDir(dir, runId), 'state.json'), 'utf8');
  const bad = [
    { action: 'buy', rationale: '' },
    { action: 'long', sl: c, tp: c + 5, rationale: '' },
    { action: 'long', sl: c - 5, tp: c, rationale: '' },
    { action: 'short', sl: c, tp: c - 5, rationale: '' },
    { action: 'short', sl: c + 5, tp: c, rationale: '' },
    { action: 'long', sl: NaN, tp: c + 5, rationale: '' },
    { action: 'long', tp: c + 5, rationale: '' },
    { action: 'long', sl: c - 5, tp: c + 5, maxHoldHours: -1, rationale: '' },
  ];
  for (const d of bad) {
    const r = await submitDecision(runId, 0, d, dir);
    assert.equal(r.accepted, false, JSON.stringify(d));
    assert.equal(typeof r.reason, 'string');
  }
  assert.equal(readFileSync(join(runDir(dir, runId), 'state.json'), 'utf8'), before);
});

test('none at every step finishes with zero trades', async () => {
  const dir = tmp();
  const { runId, totalSteps } = await createRun(fakeEx(), opts(dir, { days: 2 }));
  for (let k = 0; k < totalSteps; k++) {
    const p = await getStep(runId, dir);
    await submitDecision(runId, p.stepIndex, { action: 'none', rationale: 'flat' }, dir);
  }
  assert.deepEqual(await getStep(runId, dir), { done: true });
  const s = getRunStatus(runId, dir);
  assert.equal(s.trades, 0);
  assert.equal(s.decisions, totalSteps);
  assert.equal((await submitDecision(runId, totalSteps, { action: 'none', rationale: '' }, dir)).accepted, false);
});

test('open position blocks entries until settled closed; lastClosedTrade appears later', async () => {
  const dir = tmp();
  const { runId } = await createRun(fakeEx(), opts(dir));
  const c = (await getStep(runId, dir)).snapshots['1h'].close;
  assert.deepEqual(await submitDecision(runId, 0, { action: 'long', sl: c * 0.5, tp: c * 2, maxHoldHours: 8, rationale: 'go' }, dir), { accepted: true, nextStep: 1 });
  const st = readState(dir, runId);
  assert.equal(st.trades.length, 1);
  assert.equal(st.trades[0].status, 'open');
  assert.ok(st.trades[0].size > 0);

  const p1 = await getStep(runId, dir, { withInstructions: true });
  assert.equal(p1.position.side, 'long');
  assert.equal(p1.lastClosedTrade, null);
  assert.match(p1.instructions, /hanya action "none"/);
  const c1 = p1.snapshots['1h'].close;
  assert.equal((await submitDecision(runId, 1, { action: 'long', sl: c1 * 0.5, tp: c1 * 2, rationale: '' }, dir)).accepted, false);
  assert.equal((await submitDecision(runId, 1, { action: 'none', rationale: '' }, dir)).accepted, true);

  const p2 = await getStep(runId, dir);
  assert.equal(p2.position, null);
  assert.equal(p2.lastClosedTrade.status, 'timeout');
  const c2 = p2.snapshots['1h'].close;
  assert.equal((await submitDecision(runId, 2, { action: 'long', sl: c2 * 0.5, tp: c2 * 2, rationale: '' }, dir)).accepted, true);
  assert.equal(readState(dir, runId).trades.length, 2);
});

test('fill that invalidates levels or missing fill candle skips the trade but advances', async () => {
  const dir = tmp();
  const { runId, startTime } = await createRun(fakeEx(), opts(dir));
  const c = (await getStep(runId, dir)).snapshots['1h'].close;
  // entry = next open (== last close) * (1 + slippage) lands above this tp
  const r = await submitDecision(runId, 0, { action: 'long', sl: c * 0.9, tp: c * 1.0001, rationale: '' }, dir);
  assert.equal(r.accepted, true);
  assert.equal(r.nextStep, 1);
  assert.equal(typeof r.skipped, 'string');
  let st = readState(dir, runId);
  assert.equal(st.trades.length, 0);
  assert.equal(typeof st.decisions[0].skipped, 'string');

  const base = readCandles(dir, runId, '1h');
  writeCandles(dir, runId, '1h', { ...base, rows: base.rows.filter((x) => x.time < startTime + 4 * H) });
  const c1 = (await getStep(runId, dir)).snapshots['1h'].close;
  assert.equal((await submitDecision(runId, 1, { action: 'long', sl: c1 * 0.9, tp: c1 * 1.1, rationale: '' }, dir)).accepted, true);
  st = readState(dir, runId);
  assert.equal(st.trades.length, 0);
  assert.equal(typeof st.decisions[1].skipped, 'string');
  assert.equal(st.currentStep, 2);
});

test('instructions carry the backtest override and keputusan JSON shape', async () => {
  const dir = tmp();
  const { runId } = await createRun(fakeEx(), opts(dir));
  const { instructions } = await getStep(runId, dir);
  assert.match(instructions, /MODE BACKTEST/);
  assert.match(instructions, /JANGAN memanggil `get_indicators`/);
  assert.ok(instructions.indexOf('MODE BACKTEST') < instructions.indexOf('get_indicators` lebih dulu'));
  assert.ok(instructions.includes('"action"'));
  assert.match(instructions, /Tidak ada posisi terbuka/);
  assert.match(instructions, /max_hold_hours` \(di JSON panduan: `maxHoldHours`\) di atas batas run \(48 jam\) akan dipotong/);
  assert.match(instructions, /MEMANGGIL tool `backtest_decide`/);
  assert.match(instructions, /param `run_id`, `step_index`, `action`, `sl`, `tp`, `max_hold_hours`, `rationale`/);
  assert.match(instructions, /hanya panduan field/);
  assert.doesNotMatch(instructions, /Jawab HANYA/);
});

test('instructions only at step 0 or with withInstructions; other fields unchanged', async () => {
  const dir = tmp();
  const { runId } = await createRun(fakeEx(), opts(dir));
  const s0 = await getStep(runId, dir);
  assert.equal(typeof s0.instructions, 'string');
  await submitDecision(runId, 0, { action: 'none', rationale: '' }, dir);
  const s1 = await getStep(runId, dir);
  assert.equal(s1.stepIndex, 1);
  assert.ok(!('instructions' in s1));
  const s1i = await getStep(runId, dir, { withInstructions: true });
  assert.equal(typeof s1i.instructions, 'string');
  const { instructions, ...rest } = s1i;
  assert.deepEqual(rest, s1);
});

test('resume after restart reads only from disk', async () => {
  const dir = tmp();
  const { runId } = await createRun(fakeEx(), opts(dir));
  await getStep(runId, dir);
  await submitDecision(runId, 0, { action: 'none', rationale: '' }, dir);
  const fresh = await import(`../src/backtest/session.js?restart=${Date.now()}`);
  assert.equal((await fresh.getStep(runId, dir)).stepIndex, 1);
  assert.equal(fresh.getRunStatus(runId, dir).currentStep, 1);
});

test('createRun with too few base candles throws and writes nothing', async () => {
  const dir = tmp();
  await assert.rejects(createRun(fakeEx({ from: END - 20 * H }), opts(dir)), /30/);
  assert.deepEqual(readdirSync(dir), []);
});

test('compactSnapshot keeps listed fields, drops meta, stays small', () => {
  const rows = Array.from({ length: 300 }, (_, i) => {
    const T = i * H, o = price(T), c = price(T + H);
    return { time: T, open: o, high: Math.max(o, c) + 0.4, low: Math.min(o, c) - 0.4, close: c, volume: 100 + (i % 13) * 10 };
  });
  const s = compactSnapshot(compute(rows, { ms: H }));
  assert.equal(s.meta, undefined);
  assert.deepEqual(Object.keys(s), ['candle', 'close', 'trend', 'momentum', 'volatility', 'volume', 'levels', 'breakout', 'patterns']);
  assert.deepEqual(Object.keys(s.trend.adx), ['adx', 'strong']);
  assert.deepEqual(Object.keys(s.volume), ['ratio']);
  assert.ok(JSON.stringify(s).length <= 2500, `${JSON.stringify(s).length}`);
});

test('base candle missing at decision time: skipped, later candle price never revealed', async () => {
  const dir = tmp();
  const gap = END - 72 * H + 4 * H; // step 1 decision time
  const { runId, startTime } = await createRun(fakeEx({ gap }), opts(dir));
  assert.equal(startTime + 4 * H, gap);
  await submitDecision(runId, 0, { action: 'none', rationale: '' }, dir);
  const p1 = await getStep(runId, dir);
  const c = p1.snapshots['1h'].close;
  const res = await submitDecision(runId, 1, { action: 'long', sl: c * 0.5, tp: c * 2, rationale: '' }, dir);
  assert.equal(res.accepted, true);
  assert.match(res.skipped, /decision time/);
  const p2 = await getStep(runId, dir);
  assert.equal(p2.position, null);
  assert.equal(p2.lastClosedTrade, null);
  assert.equal(p2.equity, 1000);
  assert.equal(readState(dir, runId).trades.length, 0);
  const later = price(gap + H);
  for (const x of [later, later * 1.0005]) {
    for (const out of [p1, res, p2]) assert.ok(!JSON.stringify(out).includes(`:${x}`), `leaked ${x}`);
  }
});

test('createRun validates params and writes nothing on bad input', async () => {
  const bad = [
    { stepHours: 0 }, { stepHours: -1 }, { stepHours: NaN }, { stepHours: 1.5 }, { days: 0 }, { riskPct: NaN },
    { feePct: -1 }, { maxHoldHours: 0 }, { initialCapital: -5 }, { timeframes: ['4h', '1d'] }, { timeframes: [] },
    { baseTimeframe: '4h', stepHours: 1 }, { baseTimeframe: '4h', stepHours: 6 },
  ];
  for (const o of bad) {
    const dir = tmp();
    await assert.rejects(createRun(fakeEx(), opts(dir, o)), Error, JSON.stringify(o));
    assert.deepEqual(readdirSync(dir), [], JSON.stringify(o));
  }
  await assert.rejects(createRun(fakeEx(), opts(tmp(), { baseTimeframe: '4h', stepHours: 1 })), /multiple/);
});

test('maxHoldHours above the run cap is clamped and reported', async () => {
  const dir = tmp();
  const { runId } = await createRun(fakeEx(), opts(dir));
  const c = (await getStep(runId, dir)).snapshots['1h'].close;
  const res = await submitDecision(runId, 0, { action: 'long', sl: c * 0.5, tp: c * 2, maxHoldHours: 100, rationale: '' }, dir);
  assert.deepEqual(res, { accepted: true, nextStep: 1, maxHoldHours: 48 });
  assert.equal(readState(dir, runId).trades[0].maxHoldHours, 48);
});
