import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { writeReport } from '../src/backtest/excel.js';
import { createRun, finishRun, getStep, submitDecision, writeAtomic } from '../src/backtest/session.js';
import { summarize } from '../src/backtest/stats.js';
import { END, fakeEx } from './helpers/fakeEx.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'bt-xl-'));
const params = { symbol: 'BTC/USDT', exchange: 'binance', days: 3, stepHours: 4, timeframes: ['1h', '4h'], initialCapital: 1000 };
const T0 = Date.UTC(2026, 0, 30, 4);
const trade = (o) => ({
  id: 't1', step: 0, decidedAt: T0, side: 'long', entryTime: T0, entryPrice: 100, sl: 95, tp: 110, maxHoldHours: 48, size: 2,
  riskAmount: 10, rationale: 'breakout', status: 'tp', exitTime: T0 + 7200000, exitPrice: 110, fees: 0.4, pnl: 19.6, pnlPct: 9.8, r: 1.96, ...o,
});
const decisions = [
  { step: 0, time: new Date(T0).toISOString(), action: 'long', rationale: 'breakout' },
  { step: 1, time: new Date(T0 + 4 * 3600000).toISOString(), action: 'none', rationale: '' },
];

async function read(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
}
const rowOf = (ws, label) => { let r; ws.eachRow((row) => { if (row.getCell(1).value === label) r = row; }); return r; };

test('writeReport: three sheets, trade rows incl. open, numbers stay numeric, WIB = UTC+7', async () => {
  const open = trade({ id: 't2', status: 'open', entryTime: T0 + 8 * 3600000 });
  for (const k of ['exitTime', 'exitPrice', 'fees', 'pnl', 'pnlPct', 'r']) delete open[k];
  const trades = [trade(), open];
  const summary = summarize(trades, { initialCapital: 1000 });
  const file = join(tmp(), 'r.xlsx');
  await writeReport(file, { params, summary, trades, decisions });
  const wb = await read(file);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Trades', 'Decisions']);

  const ws = wb.getWorksheet('Trades');
  assert.equal(ws.rowCount, trades.length + 1);
  assert.equal(ws.getCell('A1').value, '#');
  assert.deepEqual(ws.getRow(1).values.slice(1), ['#', 'Decision (UTC)', 'Side', 'Entry (UTC)', 'Entry (WIB)', 'Entry Price', 'SL', 'TP', 'Exit (UTC)', 'Exit (WIB)', 'Exit Reason', 'Exit Price', 'Hold (h)', 'Size', 'Fees', 'P/L', 'P/L %', 'R', 'Equity After', 'Rationale']);
  const r = ws.getRow(2);
  assert.equal(r.getCell(4).value, '2026-01-30T04:00:00.000Z');
  assert.equal(r.getCell(5).value, '2026-01-30 11:00');
  assert.equal(r.getCell(10).value, '2026-01-30 13:00');
  assert.equal(r.getCell(11).value, 'tp');
  assert.equal(r.getCell(13).value, 2);
  assert.equal(r.getCell(16).value, 19.6);
  assert.ok(Math.abs(r.getCell(19).value - 1019.6) < 1e-9);
  assert.equal(typeof r.getCell(6).value, 'number');
  const o = ws.getRow(3);
  assert.equal(o.getCell(11).value, 'open');
  assert.ok(o.getCell(16).value == null);

  const sm = wb.getWorksheet('Summary');
  assert.equal(rowOf(sm, 'winRate').getCell(2).value, summary.winRate);
  assert.equal(rowOf(sm, 'symbol').getCell(2).value, 'BTC/USDT');
  assert.equal(rowOf(sm, 'timeframes').getCell(2).value, '1h,4h');
  assert.equal(wb.getWorksheet('Decisions').rowCount, 3);
  assert.deepEqual(wb.getWorksheet('Decisions').getRow(1).values.slice(1), ['Step', 'Time (UTC)', 'Action', 'Rationale']);
});

test('writeReport with zero trades writes a valid file with a header-only Trades sheet', async () => {
  const summary = summarize([], { initialCapital: 1000 });
  assert.ok(Object.values(summary).every((v) => v === null || Number.isFinite(v)));
  const file = join(tmp(), 'r.xlsx');
  await writeReport(file, { params, summary, trades: [], decisions: [] });
  const wb = await read(file);
  assert.equal(wb.getWorksheet('Trades').rowCount, 1);
  assert.equal(rowOf(wb.getWorksheet('Summary'), 'winRate').getCell(2).value, 0);
});

const runOpts = (dir, o = {}) => ({ exchange: 'binance', symbol: 'BTC/USDT', days: 3, stepHours: 4, maxHoldHours: 1000, endTime: END, dir, ...o });

async function runWithLong(dir, { steps = Infinity } = {}) {
  const { runId, totalSteps } = await createRun(fakeEx(), runOpts(dir));
  const c = (await getStep(runId, dir)).snapshots['1h'].close;
  assert.equal((await submitDecision(runId, 0, { action: 'long', sl: c * 0.5, tp: c * 2, rationale: 'go' }, dir)).accepted, true);
  for (let k = 1; k < Math.min(totalSteps, steps); k++) await submitDecision(runId, k, { action: 'none', rationale: '' }, dir);
  return runId;
}

test('finishRun force-closes the open trade at the last base candle, writes files, is idempotent', async () => {
  const dir = tmp();
  const runId = await runWithLong(dir);
  const res = await finishRun(runId, dir);
  assert.equal(res.summary.totalTrades, 1);
  assert.equal(res.trades.length, 1);
  assert.equal(res.trades[0].status, 'end');
  assert.equal(res.trades[0].exitTime, END);
  assert.ok(existsSync(res.xlsxPath) && existsSync(res.tradesPath));
  assert.equal(res.xlsxPath, join(dir, runId, 'report.xlsx'));
  assert.deepEqual(JSON.parse(readFileSync(res.tradesPath, 'utf8')), res.trades);
  const wb = await read(res.xlsxPath);
  assert.equal(wb.getWorksheet('Trades').rowCount, 2);
  assert.equal(wb.getWorksheet('Decisions').rowCount, 19);
  assert.equal(rowOf(wb.getWorksheet('Summary'), 'totalTrades').getCell(2).value, 1);

  const again = await finishRun(runId, dir);
  assert.deepEqual(again.summary, res.summary);
  assert.deepEqual(again.trades, res.trades);
  assert.deepEqual(JSON.parse(readFileSync(res.tradesPath, 'utf8')), res.trades);
});

test('finishRun on an unfinished run settles with what exists; zero-trade run gives zero stats', async () => {
  const dir = tmp();
  const runId = await runWithLong(dir, { steps: 3 });
  const res = await finishRun(runId, dir);
  assert.equal(res.summary.totalTrades, 1);
  assert.equal((await getStep(runId, dir)).stepIndex, 3);

  const dir2 = tmp();
  const { runId: id2 } = await createRun(fakeEx(), runOpts(dir2));
  const z = await finishRun(id2, dir2);
  assert.equal(z.summary.totalTrades, 0);
  assert.equal(z.summary.winRate, 0);
  assert.deepEqual(z.trades, []);
  assert.equal((await read(z.xlsxPath)).getWorksheet('Trades').rowCount, 1);
});

test('finishRun keeps a trade with no closed candle open: ignored by summary, listed in Trades', async () => {
  const dir = tmp();
  const runId = await runWithLong(dir);
  const f = join(dir, runId, 'state.json');
  const st = JSON.parse(readFileSync(f, 'utf8'));
  st.trades.push({ ...st.trades[0], id: 't2', entryTime: END, decidedAt: END });
  writeFileSync(f, JSON.stringify(st));
  const res = await finishRun(runId, dir);
  assert.equal(res.summary.totalTrades, 1);
  assert.equal(res.trades.length, 2);
  assert.equal(res.trades[1].status, 'open');
  const ws = (await read(res.xlsxPath)).getWorksheet('Trades');
  assert.equal(ws.rowCount, 3);
  assert.equal(ws.getRow(3).getCell(11).value, 'open');
});

test('writeAtomic retries transient rename errors and rethrows persistent or other errors', () => {
  const f = join(tmp(), 'a.json');
  const failing = (n, code) => {
    const s = { calls: 0 };
    s.fn = (from, to) => {
      if (++s.calls <= n) throw Object.assign(new Error(code), { code });
      writeFileSync(to, readFileSync(from));
    };
    return s;
  };
  const flaky = failing(2, 'EPERM');
  writeAtomic(f, { ok: 1 }, flaky.fn);
  assert.equal(flaky.calls, 3);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { ok: 1 });
  const always = failing(99, 'EBUSY');
  assert.throws(() => writeAtomic(f, { ok: 2 }, always.fn), { code: 'EBUSY' });
  assert.equal(always.calls, 5);
  const other = failing(99, 'ENOENT');
  assert.throws(() => writeAtomic(f, { ok: 3 }, other.fn), { code: 'ENOENT' });
  assert.equal(other.calls, 1);
});
