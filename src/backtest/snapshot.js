// Trimmed compute() output for backtest step payloads; drops meta (dataAgeSec depends on wall clock).
export function compactSnapshot(o) {
  const { trend: t, momentum: m, volatility: v, levels: l, breakout: b } = o;
  return {
    candle: o.candle,
    close: o.close,
    trend: {
      state: t.state,
      ema: t.ema,
      adx: { adx: t.adx.adx, strong: t.adx.strong },
      supertrend: t.supertrend && { dir: t.supertrend.dir },
      ichimoku: t.ichimoku && { priceVsCloud: t.ichimoku.priceVsCloud },
    },
    momentum: { rsi14: m.rsi14, macd: { hist: m.macd.hist }, stochRsi: m.stochRsi, divergence: m.divergence },
    volatility: { atr14: v.atr14, atrPct: v.atrPct, bollinger: { pctB: v.bollinger.pctB }, squeeze: v.squeeze },
    volume: { ratio: o.volume.ratio },
    levels: { supports: l.supports, resistances: l.resistances, structure: l.structure },
    breakout: {
      up: b.up, down: b.down, falseBreakUp: b.falseBreakUp, falseBreakDown: b.falseBreakDown,
      retestUp: b.retestUp, retestDown: b.retestDown, volumeConfirmed: b.volumeConfirmed,
    },
    patterns: o.patterns,
  };
}
