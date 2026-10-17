import { z } from 'zod';
import { EXCHANGE_REGISTRY } from '../config.js';
import { getExchange } from '../exchange.js';
import { createRun, getStep, submitDecision, getRunStatus, finishRun } from '../backtest/session.js';
import { runTool } from './shared.js';

const iso = (t) => (t == null ? null : new Date(t).toISOString());

const defaultDeps = { getEx: getExchange };

export const handlers = {
  async start(a, { getEx = getExchange, dir, endTime } = defaultDeps) {
    const r = await createRun(getEx(a.exchange), {
      exchange: a.exchange, symbol: a.symbol, days: a.days, stepHours: a.step_hours, timeframes: a.timeframes,
      maxHoldHours: a.max_hold_hours, feePct: a.fee_pct, slippagePct: a.slippage_pct,
      initialCapital: a.initial_capital, riskPct: a.risk_pct, dir, endTime,
    });
    return { runId: r.runId, totalSteps: r.totalSteps, nextAction: 'call backtest_step' };
  },

  async step({ run_id, with_instructions }, { dir } = defaultDeps) {
    const p = await getStep(run_id, dir, { withInstructions: with_instructions === true });
    return p.done ? { done: true, nextAction: 'call backtest_finish' } : p;
  },

  async decide({ run_id, step_index, action, sl, tp, max_hold_hours, rationale }, { dir } = defaultDeps) {
    return submitDecision(run_id, step_index, { action, sl, tp, maxHoldHours: max_hold_hours, rationale }, dir);
  },

  // Counts only: trade outcomes, equity and prices would leak the future.
  async status({ run_id }, { dir } = defaultDeps) {
    const { runId, currentStep, totalSteps, decisions, trades, done } = getRunStatus(run_id, dir);
    return { runId, currentStep, totalSteps, decisions, trades, done };
  },

  // R14: finishRun force-closes trades with candles beyond the current step, so refuse until every step is decided.
  async finish({ run_id }, { dir } = defaultDeps) {
    const s = getRunStatus(run_id, dir);
    if (!s.done) {
      throw new Error(`Run not finished (step ${s.currentStep} of ${s.totalSteps}). Complete all steps with backtest_step and backtest_decide first; backtest_finish would reveal future outcomes.`);
    }
    const { summary, trades, xlsxPath } = await finishRun(run_id, dir);
    return {
      summary,
      trades: trades.map((t) => ({
        id: t.id, side: t.side, entryTime: iso(t.entryTime), entryPrice: t.entryPrice, sl: t.sl, tp: t.tp,
        exitTime: iso(t.exitTime), exitPrice: t.exitPrice, status: t.status, pnl: t.pnl, pnlPct: t.pnlPct, r: t.r,
      })),
      xlsxPath,
    };
  },
};

const runId = z.string().describe('run_id returned by backtest_start.');
const pos = z.number().positive();

export function registerBacktestTools(server) {
  const reg = (name, title, description, inputSchema, fn) =>
    server.registerTool(name, { title, description, inputSchema }, async (args) => runTool(() => fn(args), { compact: true }));

  reg(
    'backtest_start', 'Start backtest run',
    'Start a blind-forward backtest. Fetches history once and stores it; returns run_id and number of steps.',
    {
      exchange: z.enum(Object.keys(EXCHANGE_REGISTRY)).describe('Exchange: "binance" or "tokocrypto".'),
      symbol: z.string().describe('Unified symbol, e.g. "BTC/USDT".'),
      days: pos.optional().describe('Backtest length in days (default 30).'),
      step_hours: pos.optional().describe('Hours between decisions (default 4); must be a multiple of 1h.'),
      timeframes: z.array(z.string()).optional().describe('Snapshot timeframes (default ["1h","4h","1d"]); must include "1h".'),
      max_hold_hours: pos.optional().describe('Max holding time per trade in hours (default 48).'),
      fee_pct: z.number().min(0).optional().describe('Fee per side in percent (default 0.1).'),
      slippage_pct: z.number().min(0).optional().describe('Slippage in percent (default 0.05).'),
      initial_capital: pos.optional().describe('Starting capital (default 1000).'),
      risk_pct: pos.optional().describe('Risk per trade in percent of equity (default 1).'),
    },
    (a) => handlers.start(a)
  );

  reg(
    'backtest_step', 'Get next backtest step',
    'Get the market snapshot for the current step, or {done:true} when all steps are decided. Instructions are included only at step 0 or with with_instructions=true.',
    { run_id: runId, with_instructions: z.boolean().optional().describe('true to include the instructions (use when resuming a run in a new chat).') },
    (a) => handlers.step(a)
  );

  reg(
    'backtest_decide', 'Submit backtest decision',
    'Submit the decision for the current step. step_index must equal the stepIndex returned by backtest_step. sl and tp are required for long/short.',
    {
      run_id: runId,
      step_index: z.number().int().min(0).describe('stepIndex from backtest_step.'),
      action: z.enum(['long', 'short', 'none']),
      sl: z.number().optional().describe('Stop loss price.'),
      tp: z.number().optional().describe('Take profit price.'),
      max_hold_hours: z.number().optional().describe('Max holding hours (capped by the run limit).'),
      rationale: z.string().describe('Short reason for the decision.'),
    },
    (a) => handlers.decide(a)
  );

  reg(
    'backtest_status', 'Backtest run status',
    'Progress of a run (step counts only, no results). Use it to resume a run.',
    { run_id: runId },
    (a) => handlers.status(a)
  );

  reg(
    'backtest_finish', 'Finish backtest run',
    'Write report.xlsx and trades.json and return summary and trades. Refused until every step is decided.',
    { run_id: runId },
    (a) => handlers.finish(a)
  );
}
