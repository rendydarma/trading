import { z } from 'zod';
import { EXCHANGE_REGISTRY } from '../config.js';
import { getExchange } from '../exchange.js';
import { buildReport, SECTIONS } from '../indicatorReport.js';
import { runTool } from './shared.js';

export function registerIndicatorTools(server) {
  server.registerTool(
    'get_indicators',
    {
      title: 'Get technical indicators',
      description:
        'Technical-analysis report from closed candles (public, no credentials): trend, momentum, volatility, volume, levels, breakout, patterns, anchored VWAP, plus multi-timeframe alignment.',
      inputSchema: {
        exchange: z.enum(Object.keys(EXCHANGE_REGISTRY)).describe('Exchange to use: "binance" or "tokocrypto".'),
        symbol: z.string().describe('Unified market symbol, e.g. "BTC/USDT".'),
        timeframes: z.array(z.string()).min(1).default(['15m', '1h', '1d']).describe('Timeframes, e.g. ["15m","1h","1d"].'),
        days: z.number().positive().optional().describe('Look-back window in days; VWAP is computed over this window (EMA warm-up candles are added automatically).'),
        only: z.array(z.enum(SECTIONS)).min(1).optional().describe('Return only these sections (plus candle, close, meta).'),
        vwap_anchor: z.enum(['day', 'week', 'month', 'period']).optional().describe('VWAP anchor; default "period" (start of the window).'),
      },
    },
    async ({ exchange, symbol, timeframes, days, only, vwap_anchor }) =>
      runTool(() => buildReport({ ex: getExchange(exchange), symbol, timeframes, days, only, vwapAnchor: vwap_anchor }))
  );
}
