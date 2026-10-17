export const EXCHANGE_REGISTRY = {
  binance: {
    id: 'binance',
    label: 'Binance',
    apiKeyEnv: 'BINANCE_API_KEY',
    secretEnv: 'BINANCE_API_SECRET',
    sandboxEnv: 'BINANCE_SANDBOX',
    defaultTypeEnv: 'BINANCE_DEFAULT_TYPE',
  },
  tokocrypto: {
    id: 'tokocrypto',
    label: 'Tokocrypto',
    apiKeyEnv: 'TOKOCRYPTO_API_KEY',
    secretEnv: 'TOKOCRYPTO_API_SECRET',
    sandboxEnv: 'TOKOCRYPTO_SANDBOX',
    legacyApiKeyEnv: 'TOKOCYPTO_API_KEY',
    legacySecretEnv: 'TOKOCYPTO_API_SECRET',
    legacySandboxEnv: 'TOKOCYPTO_SANDBOX',
    defaultTypeEnv: null,
  },
};

export function resolveExchange(name) {
  const key = String(name ?? '').trim().toLowerCase();
  const entry = EXCHANGE_REGISTRY[key];
  if (!entry) {
    throw new Error(
      `Unknown exchange "${name}". Supported exchanges: ${Object.keys(EXCHANGE_REGISTRY).join(', ')}.`
    );
  }
  return entry;
}

export function loadCredentials(entry) {
  return {
    apiKey: process.env[entry.apiKeyEnv] || process.env[entry.legacyApiKeyEnv] || '',
    secret: process.env[entry.secretEnv] || process.env[entry.legacySecretEnv] || '',
  };
}
