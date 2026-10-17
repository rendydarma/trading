import ccxt from 'ccxt';
import { resolveExchange, loadCredentials } from './config.js';

const cache = new Map();

export function getExchange(name) {
  const entry = resolveExchange(name);

  if (cache.has(entry.id)) {
    return cache.get(entry.id);
  }

  if (typeof ccxt[entry.id] !== 'function') {
    throw new Error(`The ccxt library does not provide an adapter for "${entry.id}".`);
  }

  const { apiKey, secret } = loadCredentials(entry);

  const exchange = new ccxt[entry.id]({
    apiKey: apiKey || undefined,
    secret: secret || undefined,
    enableRateLimit: true,
    timeout: 30000,
  });

  if (entry.defaultTypeEnv && process.env[entry.defaultTypeEnv]) {
    exchange.options['defaultType'] = process.env[entry.defaultTypeEnv];
  }

  const sandbox = entry.sandboxEnv && (process.env[entry.sandboxEnv] || process.env[entry.legacySandboxEnv]);
  if (sandbox === 'true') {
    if (!exchange.urls?.test) {
      throw new Error(`${entry.id} has no sandbox/testnet in ccxt; unset ${entry.sandboxEnv}`);
    }
    exchange.setSandboxMode(true);
  }

  cache.set(entry.id, exchange);
  return exchange;
}

export function hasCredentials(name) {
  const entry = resolveExchange(name);
  const { apiKey, secret } = loadCredentials(entry);
  return Boolean(apiKey && secret);
}

export function resetExchanges() {
  cache.clear();
}
