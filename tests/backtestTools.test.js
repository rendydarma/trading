import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { handlers } from '../src/tools/backtest.js';
import { renderTemplate, listTemplates } from '../src/templates.js';
import { createServer } from '../src/server.js';
import { runTool } from '../src/tools/shared.js';
import { END, fakeEx } from './helpers/fakeEx.js';

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 'btt-'));
  return { dir, deps: { getEx: () => fakeEx(), dir, endTime: END } };
};
const start = (deps, a = {}) => handlers.start({ exchange: 'binance', symbol: 'BTC/USDT', days: 2, step_hours: 12, ...a }, deps);

test('full loop [long, none, none, none]: the long is closed by timeout at the last candle', async () => {
  const { dir, deps } = mk();
  const { runId, totalSteps, nextAction } = await start(deps);
  assert.equal(totalSteps, 4);
  assert.equal(nextAction, 'call backtest_step');

  for (const action of ['long', 'none', 'none', 'none']) {
    const p = await handlers.step({ run_id: runId }, deps);
    const close = p.snapshots['1h'].close;
    // sl/tp far outside the price range, so only the 48h hold limit (= run length) ends the trade
    const levels = action === 'long' ? { sl: close * 0.5, tp: close * 2 } : {};
    const res = await handlers.decide({ run_id: runId, step_index: p.stepIndex, action, rationale: 'scripted', ...levels }, deps);
    assert.equal(res.accepted, true);
  }
  assert.deepEqual(await handlers.step({ run_id: runId }, deps), { done: true, nextAction: 'call backtest_finish' });

  const fin = await handlers.finish({ run_id: runId }, deps);
  assert.equal(fin.trades.length, 1);
  assert.equal(fin.summary.totalTrades, 1);
  assert.ok(existsSync(fin.xlsxPath));
  const t = fin.trades[0];
  assert.deepEqual(Object.keys(t), ['id', 'side', 'entryTime', 'entryPrice', 'sl', 'tp', 'exitTime', 'exitPrice', 'status', 'pnl', 'pnlPct', 'r']);
  assert.equal(t.side, 'long');
  assert.equal(t.status, 'timeout');
  assert.equal(t.exitTime, new Date(END).toISOString());
  assert.ok(readdirSync(join(dir, runId)).includes('trades.json'));
});

test('decide with wrong step_index is rejected without advancing', async () => {
  const { deps } = mk();
  const { runId } = await start(deps);
  const bad = await handlers.decide({ run_id: runId, step_index: 3, action: 'none', rationale: 'x' }, deps);
  assert.equal(bad.accepted, false);
  assert.match(bad.reason, /stepIndex must be 0/);
  assert.equal((await handlers.status({ run_id: runId }, deps)).currentStep, 0);
});

test('R14: finish refuses on a run that is not done and writes nothing', async () => {
  const { dir, deps } = mk();
  const { runId } = await start(deps);
  const p = await handlers.step({ run_id: runId }, deps);
  const close = p.snapshots['1h'].close;
  await handlers.decide({ run_id: runId, step_index: 0, action: 'long', sl: close * 0.5, tp: close * 2, rationale: 'x' }, deps);

  await assert.rejects(handlers.finish({ run_id: runId }, deps), /Complete all steps/);
  const files = readdirSync(join(dir, runId));
  assert.ok(!files.includes('report.xlsx') && !files.includes('trades.json'));

  // through the MCP wrapper it is an isError result
  const server = createServer();
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['backtest_start', 'backtest_step', 'backtest_decide', 'backtest_status', 'backtest_finish']) assert.ok(names.includes(n), n);
    const r = await client.callTool({ name: 'backtest_finish', arguments: { run_id: 'no-such-run' } });
    assert.equal(r.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('status reveals progress counts only', async () => {
  const { deps } = mk();
  const { runId } = await start(deps);
  const p = await handlers.step({ run_id: runId }, deps);
  const close = p.snapshots['1h'].close;
  await handlers.decide({ run_id: runId, step_index: 0, action: 'long', sl: close * 0.5, tp: close * 2, rationale: 'x' }, deps);
  const s = await handlers.status({ run_id: runId }, deps);
  assert.deepEqual(s, { runId, currentStep: 1, totalSteps: 4, decisions: 1, trades: 1, done: false });
});

test('step tool: instructions only at step 0 or with with_instructions; backtest tools return compact JSON', async () => {
  const { deps } = mk();
  const { runId } = await start(deps);
  assert.equal(typeof (await handlers.step({ run_id: runId }, deps)).instructions, 'string');
  await handlers.decide({ run_id: runId, step_index: 0, action: 'none', rationale: 'x' }, deps);
  assert.ok(!('instructions' in (await handlers.step({ run_id: runId }, deps))));
  assert.equal(typeof (await handlers.step({ run_id: runId, with_instructions: true }, deps)).instructions, 'string');

  assert.equal((await runTool(() => ({ a: 1, b: [2] }), { compact: true })).content[0].text, '{"a":1,"b":[2]}');
  assert.equal((await runTool(() => ({ a: 1 }))).content[0].text, '{\n  "a": 1\n}');

  // end to end through MCP: a real run in the default dir is avoided, so only schema and error shape are checked
  const server = createServer();
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'backtest_step');
    assert.ok('with_instructions' in tool.inputSchema.properties);
  } finally {
    await client.close();
    await server.close();
  }
});

const SAMPLE = { symbol: 'ADA/USDT' };
const meta = listTemplates().find((t) => t.id === 'backtest');
for (const inputStyle of meta.input_styles) {
  for (const outputStyle of meta.output_styles) {
    test(`backtest template input:${inputStyle} output:${outputStyle}`, () => {
      const { text } = renderTemplate('backtest', { inputStyle, outputStyle, vars: SAMPLE });
      assert.doesNotMatch(text, /\{[a-z_]+\}/);
      assert.doesNotMatch(text, /diisi di Task/);
      for (const w of ['backtest_start', 'backtest_step', 'backtest_decide', 'backtest_finish', 'run_id']) assert.ok(text.includes(w), w);
      if (outputStyle === 'lengkap') for (const w of ['TP', 'SL']) assert.ok(text.includes(w), w);
      if (outputStyle === 'excel') assert.match(text, /report\.xlsx/);
    });
  }
}
