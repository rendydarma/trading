// Blind-forward backtest session. Everything lives on disk under <dir>/<runId>/ (no in-memory cache):
// state.json (v1):
//   { version: 1, runId, createdAt: ISO,
//     params: { exchange, symbol, days, stepHours, timeframes, baseTimeframe, maxHoldHours,
//               feePct, slippagePct, initialCapital, riskPct, endTime },
//     startTime, stepMs, totalSteps, tfMs: { [tf]: ms }, currentStep,   // step k decides at startTime + k*stepMs
//     decisions: [{ step, time: ISO, action, rationale, sl?, tp?, maxHoldHours?, skipped? }],
//     trades: [{ id, step, decidedAt, side, entryTime, entryPrice, sl, tp, maxHoldHours, size, riskAmount,
//                rationale, status: 'open' }] }   // stored as opened; settle on demand against base candles
// candles-<tf>.json: { tf, ms, rows: [{ time, open, high, low, close, volume }] }, only candles closed by endTime.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchClosedCandles, sliceAsOf } from '../candles.js';
import { compute } from '../indicators.js';
import { renderTemplate } from '../templates.js';
import { writeReport } from './excel.js';
import { fillEntry, positionSize, settleTrade } from './settle.js';
import { compactSnapshot } from './snapshot.js';
import { summarize } from './stats.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../backtests', import.meta.url));
const H = 3600000;
const iso = (t) => new Date(t).toISOString();
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows intermittently refuses rename (AV/indexer holds the target): retry briefly, rethrow anything else.
export function writeAtomic(file, data, rename = renameSync) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  for (let attempt = 1; ; attempt++) {
    try { return rename(tmp, file); } catch (e) {
      if (!RETRY_CODES.has(e.code) || attempt >= 5) throw e;
      sleep(10 * attempt);
    }
  }
}

function runPath(runId, dir) {
  if (!/^[A-Za-z0-9-]+$/.test(String(runId))) throw new Error(`Invalid runId "${runId}"`);
  return join(dir, runId);
}

function load(runId, dir) {
  const p = runPath(runId, dir);
  const state = readJson(join(p, 'state.json'));
  const C = Object.fromEntries(Object.keys(state.tfMs).map((tf) => [tf, readJson(join(p, `candles-${tf}.json`)).rows]));
  return { p, state, C };
}

const stepTime = (s) => s.startTime + s.currentStep * s.stepMs;

// Trades settled strictly with candles closed by t.
function book(state, C, t) {
  const { feePct, slippagePct, initialCapital, baseTimeframe } = state.params;
  const settled = state.trades.map((tr) => settleTrade(tr, C[baseTimeframe], state.tfMs[baseTimeframe], t, { feePct, slippagePct }));
  const closed = settled.filter((s) => s.status !== 'open').sort((a, b) => a.exitTime - b.exitTime);
  return {
    open: settled.find((s) => s.status === 'open') ?? null,
    lastClosed: closed.at(-1) ?? null,
    equity: initialCapital + closed.reduce((s, x) => s + x.pnl, 0),
  };
}

export async function createRun(ex, opts = {}) {
  const {
    exchange, symbol, days = 30, stepHours = 4, timeframes = ['1h', '4h', '1d'], baseTimeframe = '1h',
    maxHoldHours = 48, feePct = 0.1, slippagePct = 0.05, initialCapital = 1000, riskPct = 1,
    endTime = Date.now(), dir = DEFAULT_DIR,
  } = opts;
  const params = { exchange, symbol, days, stepHours, timeframes, baseTimeframe, maxHoldHours, feePct, slippagePct, initialCapital, riskPct, endTime };
  const pos = { days, stepHours, maxHoldHours, initialCapital, riskPct };
  for (const [k, v] of Object.entries(pos)) if (!Number.isFinite(v) || v <= 0) throw new Error(`${k} must be a finite number > 0`);
  for (const [k, v] of Object.entries({ feePct, slippagePct })) if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a finite number >= 0`);
  if (!Number.isFinite(endTime)) throw new Error('endTime must be a finite timestamp');
  if (!Array.isArray(timeframes) || !timeframes.length || !timeframes.includes(baseTimeframe)) {
    throw new Error(`timeframes must be a non-empty array that includes baseTimeframe "${baseTimeframe}"`);
  }
  const stepMs = stepHours * H;
  const baseMs = ex.parseTimeframe(baseTimeframe) * 1000;
  if (!(baseMs > 0) || stepMs % baseMs !== 0) throw new Error(`stepHours (${stepHours}) must be a whole multiple of baseTimeframe ${baseTimeframe}`);
  const startTime = Math.ceil((endTime - days * 24 * H) / stepMs) * stepMs;
  const totalSteps = Math.floor((endTime - startTime) / stepMs);

  const candles = {};
  for (const tf of new Set([...timeframes, baseTimeframe])) {
    const ms = ex.parseTimeframe(tf) * 1000;
    candles[tf] = await fetchClosedCandles(ex, symbol, tf, { since: startTime - 250 * ms, until: endTime, now: endTime });
  }
  const inRange = candles[baseTimeframe].rows.filter((c) => c.time >= startTime).length;
  if (inRange < 30) throw new Error(`Only ${inRange} ${baseTimeframe} candles in the backtest range; need at least 30`);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const stem = `${String(symbol).replace(/[^A-Za-z0-9]/g, '')}-${stamp}`;
  mkdirSync(dir, { recursive: true });
  let runId = stem;
  for (let n = 2; ; n++) {
    try { mkdirSync(join(dir, runId)); break; } catch (e) { if (e.code !== 'EEXIST') throw e; runId = `${stem}-${n}`; }
  }
  const p = join(dir, runId);
  try {
    for (const [tf, { ms, rows }] of Object.entries(candles)) writeAtomic(join(p, `candles-${tf}.json`), { tf, ms, rows });
    writeAtomic(join(p, 'state.json'), {
      version: 1, runId, createdAt: iso(Date.now()), params, startTime, stepMs, totalSteps,
      tfMs: Object.fromEntries(Object.entries(candles).map(([tf, c]) => [tf, c.ms])),
      currentStep: 0, decisions: [], trades: [],
    });
  } catch (e) {
    rmSync(p, { recursive: true, force: true });
    throw e;
  }
  return { runId, totalSteps, startTime, stepMs };
}

const override = (maxHold) => `### MODE BACKTEST (mengesampingkan instruksi di bawah bila bertentangan)
- Ini simulasi backtest blind-forward. Semua data pasar yang boleh dipakai sudah ada di field \`snapshots\`.
- JANGAN memanggil \`get_indicators\`, \`get_ohlcv\`, \`get_ticker\`, \`get_order_book\`, atau tool lain untuk data pasar: data live berisi masa depan dan merusak backtest.
- Ukuran posisi ditentukan server; abaikan perhitungan ukuran posisi.
- \`max_hold_hours\` (di JSON panduan: \`maxHoldHours\`) di atas batas run (${maxHold} jam) akan dipotong menjadi ${maxHold} jam.
- Kirim keputusan dengan MEMANGGIL tool \`backtest_decide\` (param \`run_id\`, \`step_index\`, \`action\`, \`sl\`, \`tp\`, \`max_hold_hours\`, \`rationale\`) dan jangan menulis teks lain.
- JSON keputusan pada template di bawah hanya panduan field, bukan jawaban; \`maxHoldHours\` di sana sama dengan param tool \`max_hold_hours\`.
- Bila \`position\` terisi, hanya action "none" yang diterima.`;

// instructions repeat verbatim every step, so they are sent only at step 0 or on request (e.g. resuming in a new chat)
export async function getStep(runId, dir = DEFAULT_DIR, { withInstructions = false } = {}) {
  const { state, C } = load(runId, dir);
  if (state.currentStep >= state.totalSteps) return { done: true };
  const t = stepTime(state);
  const { params, tfMs } = state;
  const prevDaily = C['1d'] && sliceAsOf(C['1d'], tfMs['1d'], t).at(-1);
  const snapshots = {};
  for (const tf of params.timeframes) {
    const rows = sliceAsOf(C[tf], tfMs[tf], t);
    snapshots[tf] = rows.length ? compactSnapshot(compute(rows, { ms: tfMs[tf], prevDaily })) : null;
  }
  const { open, lastClosed, equity } = book(state, C, t);
  const position = open && { side: open.side, entryTime: iso(open.entryTime), entryPrice: open.entryPrice, sl: open.sl, tp: open.tp };
  const template = renderTemplate('analysis', {
    outputStyle: 'keputusan',
    vars: { symbol: params.symbol, exchange: params.exchange, timeframes: params.timeframes.join(','), risk_pct: params.riskPct },
  }).text;
  const posLine = position
    ? `Posisi terbuka: ${position.side} sejak ${position.entryTime} di ${position.entryPrice} (SL ${position.sl}, TP ${position.tp}); hanya action "none" yang diterima.`
    : 'Tidak ada posisi terbuka; action "long", "short", atau "none" diterima.';
  const payload = {
    runId, stepIndex: state.currentStep, totalSteps: state.totalSteps, asOf: iso(t), equity, position,
    lastClosedTrade: lastClosed, snapshots,
  };
  if (withInstructions || state.currentStep === 0) payload.instructions = `${override(params.maxHoldHours)}\n\n${template}\n\n${posLine}`;
  return payload;
}

export async function submitDecision(runId, stepIndex, decision, dir = DEFAULT_DIR) {
  const { p, state, C } = load(runId, dir);
  const reject = (reason) => ({ accepted: false, reason });
  if (state.currentStep >= state.totalSteps) return reject('run already finished');
  if (stepIndex !== state.currentStep) return reject(`stepIndex must be ${state.currentStep}`);
  const { action, sl, tp, rationale = '' } = decision ?? {};
  if (!['long', 'short', 'none'].includes(action)) return reject('action must be "long", "short" or "none"');

  const t = stepTime(state);
  const { params } = state;
  const base = C[params.baseTimeframe];
  const record = { step: stepIndex, time: iso(t), action, rationale: String(rationale) };
  if (action !== 'none') {
    const { open, equity } = book(state, C, t);
    if (open) return reject('a position is open; only "none" is accepted');
    const hold = decision.maxHoldHours ?? params.maxHoldHours;
    if (![sl, tp, hold].every(Number.isFinite) || hold <= 0) return reject('sl, tp and maxHoldHours must be finite numbers, maxHoldHours > 0');
    const lastClose = sliceAsOf(base, state.tfMs[params.baseTimeframe], t).at(-1)?.close;
    const long = action === 'long';
    if (!(long ? sl < lastClose && lastClose < tp : tp < lastClose && lastClose < sl)) {
      return reject(`${action} requires ${long ? 'sl < lastClose < tp' : 'tp < lastClose < sl'}; lastClose = ${lastClose}`);
    }
    Object.assign(record, { sl, tp, maxHoldHours: Math.min(hold, params.maxHoldHours) });
    const fill = fillEntry(base, t, action, params.slippagePct);
    const e = fill?.entryPrice;
    // only the candle opening exactly at t may fill; a later one (data gap) would leak its price
    if (!fill || fill.entryTime !== t) record.skipped = 'no base candle opens at decision time';
    else if (long ? sl >= e || tp <= e : sl <= e || tp >= e) record.skipped = `fill price ${e} invalidates sl/tp`;
    else if (equity <= 0) record.skipped = 'no equity left';
    else {
      const { size, riskAmount } = positionSize({ equity, riskPct: params.riskPct, entry: e, sl });
      state.trades.push({
        id: `t${state.trades.length + 1}`, step: stepIndex, decidedAt: t, side: action, ...fill, sl, tp,
        maxHoldHours: record.maxHoldHours, size, riskAmount, rationale: record.rationale, status: 'open',
      });
    }
  }
  state.decisions.push(record);
  state.currentStep++;
  writeAtomic(join(p, 'state.json'), state);
  const res = { accepted: true, nextStep: state.currentStep < state.totalSteps ? state.currentStep : null };
  if (record.skipped) res.skipped = record.skipped;
  if (action !== 'none' && decision.maxHoldHours > params.maxHoldHours) res.maxHoldHours = record.maxHoldHours;
  return res;
}

export function getRunStatus(runId, dir = DEFAULT_DIR) {
  const s = readJson(join(runPath(runId, dir), 'state.json'));
  return { runId, currentStep: s.currentStep, totalSteps: s.totalSteps, decisions: s.decisions.length, trades: s.trades.length, done: s.currentStep >= s.totalSteps };
}

// Settles every trade against base candles closed by endTime (forceClose), then writes trades.json and report.xlsx.
// Derived purely from state.json, so repeated calls give identical output.
export async function finishRun(runId, dir = DEFAULT_DIR) {
  const { p, state, C } = load(runId, dir);
  const { params, tfMs } = state;
  const { baseTimeframe, feePct, slippagePct, initialCapital, endTime } = params;
  const trades = state.trades.map((tr) => settleTrade(tr, C[baseTimeframe], tfMs[baseTimeframe], endTime, { feePct, slippagePct, forceClose: true }));
  const summary = summarize(trades, { initialCapital });
  const xlsxPath = join(p, 'report.xlsx');
  const tradesPath = join(p, 'trades.json');
  writeAtomic(tradesPath, trades);
  const { exchange, symbol, days, stepHours, timeframes, maxHoldHours, riskPct } = params;
  await writeReport(xlsxPath, {
    params: { symbol, exchange, days, stepHours, timeframes, feePct, slippagePct, initialCapital, riskPct, maxHoldHours, startUtc: iso(state.startTime), endUtc: iso(endTime) },
    summary, trades, decisions: state.decisions,
  });
  return { summary, trades, xlsxPath, tradesPath };
}
