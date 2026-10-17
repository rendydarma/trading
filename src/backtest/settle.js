export function fillEntry(candles, decidedAt, side, slippagePct) {
  const c = candles.find((k) => k.time >= decidedAt);
  if (!c) return null;
  const slip = slippagePct / 100;
  return { entryTime: c.time, entryPrice: c.open * (side === 'long' ? 1 + slip : 1 - slip) };
}

export function positionSize({ equity, riskPct, entry, sl, maxLeverage = 1 }) {
  const dist = Math.abs(entry - sl);
  let riskAmount = (equity * riskPct) / 100;
  let size = riskAmount / dist;
  const maxSize = (equity * maxLeverage) / entry;
  if (size > maxSize) {
    size = maxSize;
    riskAmount = size * dist;
  }
  return { size, riskAmount };
}

function close(trade, exitTime, exitPrice, status, feePct) {
  const dir = trade.side === 'long' ? 1 : -1;
  const gross = dir * (exitPrice - trade.entryPrice) * trade.size;
  const fees = (feePct / 100) * (trade.entryPrice + exitPrice) * trade.size;
  const pnl = gross - fees;
  return {
    ...trade,
    status,
    exitTime,
    exitPrice,
    fees,
    pnl,
    pnlPct: (pnl / (trade.entryPrice * trade.size)) * 100,
    r: pnl / trade.riskAmount,
  };
}

export function settleTrade(trade, candles, ms, asOf, { feePct = 0, slippagePct = 0, forceClose = false } = {}) {
  if (trade.status !== 'open') return trade;
  const long = trade.side === 'long';
  const slip = slippagePct / 100;
  const deadline = trade.entryTime + trade.maxHoldHours * 3600000;
  let last = null;

  for (const c of candles) {
    if (c.time < trade.entryTime || c.time + ms > asOf) continue;
    last = c;
    const end = c.time + ms;
    if (long ? c.open <= trade.sl : c.open >= trade.sl) return close(trade, c.time, c.open, 'sl', feePct);
    if (long ? c.low <= trade.sl : c.high >= trade.sl) {
      return close(trade, end, trade.sl * (long ? 1 - slip : 1 + slip), 'sl', feePct);
    }
    if (long ? c.high >= trade.tp : c.low <= trade.tp) return close(trade, end, trade.tp, 'tp', feePct);
    if (end >= deadline) return close(trade, end, c.close, 'timeout', feePct);
  }

  if (forceClose && last) return close(trade, last.time + ms, last.close, 'end', feePct);
  return { ...trade };
}
