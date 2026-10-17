const r2 = (x) => Math.round(x * 100) / 100 + 0;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

export function summarize(trades, { initialCapital }) {
  const closed = trades.filter((t) => t.status !== 'open').sort((a, b) => a.exitTime - b.exitTime);
  const n = closed.length;
  if (!n) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0, netPnl: 0, netPnlPct: 0, profitFactor: null,
      expectancyR: 0, avgR: 0, maxDrawdownPct: 0, avgHoldHours: 0, bestTrade: 0, worstTrade: 0,
      longs: 0, shorts: 0, finalEquity: initialCapital,
    };
  }

  const pnls = closed.map((t) => t.pnl);
  const grossWin = sum(pnls.filter((p) => p > 0));
  const grossLoss = -sum(pnls.filter((p) => p < 0));
  const netPnl = sum(pnls);
  const avgR = sum(closed.map((t) => t.r)) / n;

  let equity = initialCapital;
  let peak = equity;
  let maxDd = 0;
  for (const p of pnls) {
    equity += p;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  }

  return {
    totalTrades: n,
    wins: pnls.filter((p) => p > 0).length,
    losses: pnls.filter((p) => p < 0).length,
    winRate: r2((pnls.filter((p) => p > 0).length / n) * 100),
    netPnl: r2(netPnl),
    netPnlPct: r2((netPnl / initialCapital) * 100),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    expectancyR: r2(avgR),
    avgR: r2(avgR),
    maxDrawdownPct: r2(maxDd),
    avgHoldHours: r2(sum(closed.map((t) => t.exitTime - t.entryTime)) / n / 3600000),
    bestTrade: r2(Math.max(...pnls)),
    worstTrade: r2(Math.min(...pnls)),
    longs: closed.filter((t) => t.side === 'long').length,
    shorts: closed.filter((t) => t.side === 'short').length,
    finalEquity: r2(initialCapital + netPnl),
  };
}
