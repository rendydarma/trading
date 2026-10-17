export function checkOrder(order, { env, lastPrice, minNotional, quote }) {
  if (env.TRADING_LIVE !== 'true') {
    return { ok: false, reason: 'Live trading is disabled: set TRADING_LIVE=true to allow real orders.' };
  }
  const max = env.MAX_ORDER_NOTIONAL?.trim() ? Number(env.MAX_ORDER_NOTIONAL) : NaN;
  if (!Number.isFinite(max) || max <= 0) {
    return { ok: false, reason: 'MAX_ORDER_NOTIONAL must be set to a positive number to allow real orders.' };
  }
  const capQuote = env.MAX_ORDER_QUOTE?.trim().toUpperCase();
  if (!capQuote) {
    return { ok: false, reason: 'MAX_ORDER_QUOTE must be set (the quote currency MAX_ORDER_NOTIONAL is expressed in, e.g. USDT) to allow real orders.' };
  }
  const marketQuote = typeof quote === 'string' ? quote.trim().toUpperCase() : '';
  if (marketQuote !== capQuote) {
    return { ok: false, reason: `Order refused: market quote currency ${quote ?? 'unknown'} does not match MAX_ORDER_QUOTE ${capQuote}; the cap is only valid in ${capQuote}.` };
  }
  // unset or empty means no allowlist; a set value that parses to nothing (",", " ") blocks everything
  const allowed = (env.ALLOWED_SYMBOLS ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (env.ALLOWED_SYMBOLS && !allowed.includes(String(order.symbol).toUpperCase())) {
    return { ok: false, reason: `Symbol ${order.symbol} is not in ALLOWED_SYMBOLS.` };
  }
  if (!(Number.isFinite(lastPrice) && lastPrice > 0)) {
    return { ok: false, reason: 'Order refused: last price is missing or invalid, so notional cannot be determined.' };
  }
  if (order.type === 'limit' && !(Number.isFinite(order.price) && order.price > 0)) {
    return { ok: false, reason: 'Order refused: limit price is missing, zero or invalid.' };
  }
  // market orders fill near lastPrice whatever the caller's price; a limit order can fill at lastPrice if marketable
  const refPrice = order.type === 'limit' ? Math.max(order.price ?? lastPrice, lastPrice) : lastPrice;
  const notional = order.amount * refPrice;
  if (!Number.isFinite(notional) || notional <= 0) {
    return { ok: false, reason: 'Order refused: notional cannot be determined (missing or invalid price or amount).' };
  }
  if (notional > max) {
    return { ok: false, reason: `Order notional ${notional} exceeds MAX_ORDER_NOTIONAL ${max}.` };
  }
  if (minNotional != null && notional < minNotional) {
    return { ok: false, reason: `Order notional ${notional} is below the exchange minimum ${minNotional}.` };
  }
  return { ok: true, notional };
}

export async function prepareOrder(ex, order, env) {
  const { symbol, side, type } = order;
  const markets = await ex.loadMarkets();
  const { last } = await ex.fetchTicker(symbol);
  const amount = Number(ex.amountToPrecision(symbol, order.amount));
  const price = type === 'limit' ? Number(ex.priceToPrecision(symbol, order.price)) : undefined;
  const verdict = checkOrder(
    { ...order, amount, price },
    { env, lastPrice: last, minNotional: markets[symbol]?.limits?.cost?.min, quote: markets[symbol]?.quote }
  );
  if (!verdict.ok) return { submitted: false, blocked: true, reason: verdict.reason };

  return { submitted: true, order: await ex.createOrder(symbol, type, side, amount, price) };
}
