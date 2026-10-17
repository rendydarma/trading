import 'dotenv/config';
import ccxt from 'ccxt';
import { EXCHANGE_REGISTRY, loadCredentials } from '../src/config.js';

const EXCHANGE_ID = 'tokocrypto';
const SYMBOL = 'BTC/USDT';

function mask(value) {
  if (!value) return '(empty)';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function main() {
  const { apiKey, secret } = loadCredentials(EXCHANGE_REGISTRY.tokocrypto);

  console.log('=== Tokocrypto connection test ===');
  console.log('API key loaded :', mask(apiKey));
  console.log('API secret set :', secret ? '(set)' : '(empty)');
  console.log('');

  if (!apiKey || !secret) {
    console.error('Missing TOKOCRYPTO_API_KEY / TOKOCRYPTO_API_SECRET in the environment (.env).');
    process.exit(1);
  }

  const exchange = new ccxt[EXCHANGE_ID]({
    apiKey,
    secret,
    enableRateLimit: true,
    timeout: 30000,
  });

  console.log('1) Public market data -> fetchTicker(' + SYMBOL + ')');
  try {
    const ticker = await exchange.fetchTicker(SYMBOL);
    console.log('   OK  last price:', ticker.last, ticker.quote ?? '');
    console.log('   raw:', JSON.stringify({ symbol: ticker.symbol, last: ticker.last, bid: ticker.bid, ask: ticker.ask, high: ticker.high, low: ticker.low, baseVolume: ticker.baseVolume }));
  } catch (err) {
    console.log('   FAILED:', err instanceof Error ? err.message : err);
    console.log('   (If it says "market not found", the symbol may be different — try BTC/IDR.)');
  }

  console.log('');
  console.log('2) Authenticated access -> fetchBalance()');
  try {
    const balance = await exchange.fetchBalance();
    const holdings = Object.entries(balance.total ?? {})
      .filter(([, amount]) => Number(amount) > 0)
      .map(([asset, amount]) => ({ asset, total: amount }));
    console.log('   OK  login + auth works. Non-zero balances:', holdings.length);
    console.log('   raw:', JSON.stringify(holdings, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('   FAILED:', message);
    if (/ip|whitelist|unauthor|signature|permission|-2015|-1003/i.test(message)) {
      console.log('   Hint: this is an authentication/permission problem, not the network.');
      console.log('   Check: Trade API enabled on website, correct key/secret, IP whitelist, key permissions.');
    }
  }

  console.log('');
  console.log('3) Market discovery -> list BTC pairs');
  try {
    await exchange.loadMarkets();
    const btc = Object.values(exchange.markets)
      .filter((m) => m.base === 'BTC' && m.active)
      .map((m) => m.symbol);
    console.log('   BTC markets:', btc.join(', ') || '(none)');
  } catch (err) {
    console.log('   FAILED:', err instanceof Error ? err.message : err);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
