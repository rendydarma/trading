export const H = 3600000;
export const D = 24 * H;
export const END = Date.UTC(2026, 0, 31);
export const SENTINEL = 999999;
export const TF_SEC = { '1h': 3600, '4h': 14400, '1d': 86400 };
export const r2 = (x) => Math.round(x * 100) / 100;
export const price = (t) => r2(100 + 8 * Math.sin(t / (37 * H)) + 3 * Math.sin(t / (5 * H)) + ((t / H) % 7) * 0.1);

// Analytic market; every candle that has not closed by END carries the sentinel high.
export function fakeEx({ from = -Infinity, exchangeNow = END + 5 * D, gap } = {}) {
  return {
    parseTimeframe: (tf) => TF_SEC[tf],
    async fetchOHLCV(symbol, tf, since, limit) {
      const ms = TF_SEC[tf] * 1000, out = [];
      for (let T = Math.ceil(Math.max(since, from) / ms) * ms; T < exchangeNow && out.length < limit; T += ms) {
        if (ms === H && T === gap) continue;
        const o = price(T), c = price(T + ms);
        const high = T + ms > END ? SENTINEL : r2(Math.max(o, c) + 0.3 + ((T / H) % 3) * 0.1);
        out.push([T, o, high, r2(Math.min(o, c) - 0.3), c, 100 + ((T / H) % 13) * 10]);
      }
      return out;
    },
  };
}
