import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EXCHANGE_REGISTRY } from './config.js';
import { getExchange, hasCredentials, resetExchanges } from './exchange.js';
import { ohlcvRows } from './candles.js';
import { prepareOrder } from './guard.js';
import { slimTicker, slimBalance, slimOrderBook } from './slim.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerTemplateTools } from './tools/templates.js';
import { registerBacktestTools } from './tools/backtest.js';

const exchangeParam = z
  .enum(Object.keys(EXCHANGE_REGISTRY))
  .describe('Exchange to use: "binance" or "tokocrypto".');

const symbolParam = z
  .string()
  .describe('Unified market symbol, e.g. "BTC/USDT" (Binance) or "BTC/IDR" (Tokocrypto).');

function toContent(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

async function run(fn) {
  try {
    return toContent(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
  }
}

function requireCredentials(exchangeName) {
  if (!hasCredentials(exchangeName)) {
    throw new Error(
      `Missing API credentials for "${exchangeName}". Set the corresponding *_API_KEY and *_API_SECRET environment variables.`
    );
  }
}

export function createServer() {
  const server = new McpServer({
    name: 'trading-mcp',
    version: '1.0.0',
  });

  server.registerTool(
    'list_exchanges',
    {
      title: 'List supported exchanges',
      description: 'List the exchanges this server can reach and whether API credentials are configured.',
      inputSchema: {},
    },
    async () =>
      run(() =>
        Object.values(EXCHANGE_REGISTRY).map((entry) => ({
          id: entry.id,
          label: entry.label,
          credentialsConfigured: hasCredentials(entry.id),
        }))
      )
  );

  server.registerTool(
    'get_ticker',
    {
      title: 'Get ticker',
      description: 'Fetch the latest price ticker for a symbol (public, no credentials required).',
      inputSchema: {
        exchange: exchangeParam,
        symbol: symbolParam,
      },
    },
    async ({ exchange, symbol }) =>
      run(async () => slimTicker(await getExchange(exchange).fetchTicker(symbol)))
  );

  server.registerTool(
    'get_order_book',
    {
      title: 'Get order book',
      description: 'Fetch the current order book (bids/asks) for a symbol (public).',
      inputSchema: {
        exchange: exchangeParam,
        symbol: symbolParam,
        limit: z.number().int().positive().max(100).optional().describe('Depth of the order book.'),
      },
    },
    async ({ exchange, symbol, limit }) =>
      run(async () => slimOrderBook(await getExchange(exchange).fetchOrderBook(symbol, limit), limit))
  );

  server.registerTool(
    'get_ohlcv',
    {
      title: 'Get OHLCV candles',
      description: 'Fetch historical candlestick data for a symbol (public).',
      inputSchema: {
        exchange: exchangeParam,
        symbol: symbolParam,
        timeframe: z.string().default('1h').describe('Candle timeframe, e.g. 1m, 5m, 1h, 1d.'),
        since: z.number().int().optional().describe('Start time in milliseconds since epoch.'),
        limit: z.number().int().positive().max(1000).optional().describe('Number of candles to return.'),
        closedOnly: z
          .boolean()
          .default(true)
          .describe('Drop the still-forming candle. Returns [time, open, high, low, close, volume] rows.'),
      },
    },
    async ({ exchange, symbol, timeframe, since, limit, closedOnly }) =>
      run(() => ohlcvRows(getExchange(exchange), symbol, timeframe, { since, limit, closedOnly }))
  );

  server.registerTool(
    'get_markets',
    {
      title: 'List markets',
      description: 'List available trading markets/pairs, optionally filtered (public).',
      inputSchema: {
        exchange: exchangeParam,
        quote: z.string().optional().describe('Filter by quote currency, e.g. "USDT" or "IDR".'),
        search: z.string().optional().describe('Case-insensitive substring match on the symbol.'),
        limit: z.number().int().positive().max(1000).optional().describe('Max number of markets to return.'),
      },
    },
    async ({ exchange, quote, search, limit }) =>
      run(async () => {
        const ex = getExchange(exchange);
        const markets = await ex.loadMarkets();
        const needle = search ? search.toLowerCase() : null;
        const result = Object.values(markets).filter((m) => {
          if (quote && String(m.quote).toUpperCase() !== quote.toUpperCase()) return false;
          if (needle && !String(m.symbol).toLowerCase().includes(needle)) return false;
          return true;
        });
        return {
          total: result.length,
          markets: (limit ? result.slice(0, limit) : result).map((m) => ({
            symbol: m.symbol,
            base: m.base,
            quote: m.quote,
            active: m.active,
          })),
        };
      })
  );

  server.registerTool(
    'get_balance',
    {
      title: 'Get account balance',
      description: 'Fetch the account balances. Requires API credentials with read permission.',
      inputSchema: {
        exchange: exchangeParam,
      },
    },
    async ({ exchange }) =>
      run(async () => {
        requireCredentials(exchange);
        return slimBalance(await getExchange(exchange).fetchBalance());
      })
  );

  server.registerTool(
    'get_open_orders',
    {
      title: 'Get open orders',
      description: 'List currently open orders. Requires API credentials.',
      inputSchema: {
        exchange: exchangeParam,
        symbol: symbolParam.optional(),
      },
    },
    async ({ exchange, symbol }) =>
      run(async () => {
        requireCredentials(exchange);
        return getExchange(exchange).fetchOpenOrders(symbol ?? undefined);
      })
  );

  server.registerTool(
    'get_my_trades',
    {
      title: 'Get trade history',
      description: 'List past (filled) trades. Requires API credentials.',
      inputSchema: {
        exchange: exchangeParam,
        symbol: symbolParam.optional(),
        since: z.number().int().optional().describe('Start time in milliseconds since epoch.'),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async ({ exchange, symbol, since, limit }) =>
      run(async () => {
        requireCredentials(exchange);
        return getExchange(exchange).fetchMyTrades(symbol ?? undefined, since, limit);
      })
  );

  server.registerTool(
    'create_order',
    {
      title: 'Create order (live trading)',
      description:
        'Place a live buy/sell order on the exchange. Requires API credentials with trade permission. confirm is a model-set flag, not a safety guard: with confirm=false (default) the order is only previewed; with confirm=true it is still blocked unless the server has TRADING_LIVE=true, MAX_ORDER_NOTIONAL and MAX_ORDER_QUOTE set (the market quote currency must equal MAX_ORDER_QUOTE) and, optionally, ALLOWED_SYMBOLS.',
      inputSchema: {
        exchange: exchangeParam,
        symbol: symbolParam,
        side: z.enum(['buy', 'sell']),
        type: z.enum(['market', 'limit']).default('market'),
        amount: z.number().positive().describe('Amount of the base asset to trade.'),
        price: z.number().positive().optional().describe('Limit price (required for limit orders).'),
        confirm: z
          .boolean()
          .default(false)
          .describe('Model-set flag, not a safety guard. Must be true to attempt submission; server-side limits still apply.'),
      },
    },
    async ({ exchange, symbol, side, type, amount, price, confirm }) =>
      run(async () => {
        requireCredentials(exchange);
        if (type === 'limit' && price == null) {
          throw new Error('A price is required for limit orders.');
        }
        if (!confirm) {
          return {
            submitted: false,
            message: 'Order not submitted. Re-run with confirm=true to place this live order.',
            preview: { exchange, symbol, side, type, amount, price: price ?? null },
          };
        }
        return prepareOrder(
          getExchange(exchange),
          { exchange, symbol, side, type, amount, price },
          process.env
        );
      })
  );

  server.registerTool(
    'cancel_order',
    {
      title: 'Cancel order',
      description: 'Cancel an open order by its id. Requires API credentials with trade permission.',
      inputSchema: {
        exchange: exchangeParam,
        id: z.string().describe('Exchange order id to cancel.'),
        symbol: symbolParam.optional(),
      },
    },
    async ({ exchange, id, symbol }) =>
      run(async () => {
        requireCredentials(exchange);
        return getExchange(exchange).cancelOrder(id, symbol ?? undefined);
      })
  );

  server.registerTool(
    'reload_config',
    {
      title: 'Reload exchange configuration',
      description: 'Clear cached exchange clients only. Changes to .env or the environment (TRADING_LIVE, MAX_ORDER_NOTIONAL, MAX_ORDER_QUOTE, ALLOWED_SYMBOLS, API keys) are NOT re-read: restart the MCP server to apply them.',
      inputSchema: {},
    },
    async () =>
      run(() => {
        resetExchanges();
        return { reloaded: true };
      })
  );

  registerIndicatorTools(server);
  registerTemplateTools(server);
  registerBacktestTools(server);

  return server;
}
