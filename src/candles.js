const toCandle = ([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume });

export async function fetchClosedCandles(ex, symbol, timeframe, { since, until, limit = 1000, now = Date.now() } = {}) {
  const ms = ex.parseTimeframe(timeframe) * 1000;
  const byTime = new Map();

  if (since === undefined) {
    for (const c of await ex.fetchOHLCV(symbol, timeframe, undefined, limit)) byTime.set(c[0], c);
  } else {
    const end = until ?? now;
    let cursor = since;
    while (cursor < end) {
      const page = await ex.fetchOHLCV(symbol, timeframe, cursor, limit);
      if (!page.length) break;
      const next = page[page.length - 1][0] + ms;
      for (const c of page) byTime.set(c[0], c);
      if (next <= cursor) break;
      cursor = next;
    }
  }

  const rows = [...byTime.values()]
    .map(toCandle)
    .filter((c) => c.time + ms <= now && (until === undefined || c.time <= until))
    .sort((a, b) => a.time - b.time);
  return { ms, rows };
}

export function sliceAsOf(rows, ms, t) {
  return rows.filter((c) => c.time + ms <= t);
}

// get_ohlcv rows: [time, open, high, low, close, volume]; limit caps the result and bounds paging; with since and no limit the cap is 1000 rows.
export async function ohlcvRows(ex, symbol, timeframe, { since, limit, closedOnly = true, now } = {}) {
  if (!closedOnly) return ex.fetchOHLCV(symbol, timeframe, since, limit);
  const cap = limit ?? (since !== undefined ? 1000 : undefined);
  const until = since !== undefined ? since + (cap - 1) * ex.parseTimeframe(timeframe) * 1000 : undefined;
  const { rows } = await fetchClosedCandles(ex, symbol, timeframe, { since, until, limit: cap, now });
  return (cap ? rows.slice(0, cap) : rows).map((r) => [r.time, r.open, r.high, r.low, r.close, r.volume]);
}
