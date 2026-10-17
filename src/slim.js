const TICKER_KEYS = [
  'symbol', 'last', 'bid', 'ask', 'open', 'high', 'low',
  'change', 'percentage', 'baseVolume', 'quoteVolume', 'timestamp',
];

export function slimTicker(t) {
  return Object.fromEntries(TICKER_KEYS.map((k) => [k, t[k]]));
}

export function slimBalance(b) {
  const out = {};
  for (const [asset, total] of Object.entries(b.total ?? {})) {
    if (total > 0) out[asset] = { free: b.free?.[asset] ?? 0, used: b.used?.[asset] ?? 0, total };
  }
  return out;
}

export function slimOrderBook(ob, depth = 20) {
  return {
    symbol: ob.symbol,
    timestamp: ob.timestamp,
    bids: ob.bids.slice(0, depth),
    asks: ob.asks.slice(0, depth),
  };
}
