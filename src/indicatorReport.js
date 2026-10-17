import { fetchClosedCandles } from './candles.js';
import { compute, anchoredVwap } from './indicators.js';

export const SECTIONS = ['trend', 'momentum', 'volatility', 'volume', 'levels', 'breakout', 'patterns', 'vwap'];
const DAY = 86400000;
const WARMUP = 250;

export async function buildReport({ ex, symbol, timeframes, limit = 1000, days, only = null, vwapAnchor = 'period', now = Date.now() }) {
  const bad = only?.filter((s) => !SECTIONS.includes(s));
  if (bad?.length) throw new Error(`Unknown section(s) ${bad.join(',')}; valid: ${SECTIONS.join('|')}`);

  const closed = async (tf) => {
    const since = days ? now - days * DAY - WARMUP * ex.parseTimeframe(tf) * 1000 : undefined;
    return fetchClosedCandles(ex, symbol, tf, { since, limit, now });
  };
  const data = {};
  for (const tf of timeframes) data[tf] = await closed(tf);
  const prevDaily = (data['1d'] ?? (await closed('1d'))).rows.at(-1);

  const out = { exchange: ex.id, symbol, fetchedAt: new Date(now).toISOString(), timeframes: {}, mtf: { perTf: {}, alignment: null } };
  for (const tf of timeframes) {
    const { ms, rows } = data[tf];
    if (rows.length < 30) { out.timeframes[tf] = { error: `only ${rows.length} closed candles, need >= 30` }; continue; }
    const full = compute(rows, { ms, prevDaily });
    out.mtf.perTf[tf] = { trend: full.trend.state, adxStrong: full.trend.adx.strong };
    // ponytail: vwap shown only when asked via `only` or `days`; a plain report keeps today's shape
    const wantVwap = only ? only.includes('vwap') : days != null;
    const vwap = wantVwap ? anchoredVwap(days ? rows.filter((r) => r.time >= now - days * DAY) : rows, vwapAnchor) : undefined;
    out.timeframes[tf] = only
      ? { candle: full.candle, close: full.close, meta: full.meta, ...Object.fromEntries(only.filter((s) => s !== 'vwap').map((s) => [s, full[s]])), ...(wantVwap && { vwap }) }
      : { ...full, ...(wantVwap && { vwap }) };
  }
  const states = Object.values(out.mtf.perTf).map((t) => t.trend);
  out.mtf.alignment = !states.length ? null : states.includes('bull') && states.includes('bear') ? 'opposed' : states.every((s) => s === states[0]) && states[0] !== 'mixed' ? `aligned ${states[0]}` : 'mixed';
  return out;
}
