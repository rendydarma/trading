import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EXCHANGE_REGISTRY, loadCredentials } from '../src/config.js';

const KEYS = ['TOKOCRYPTO_API_KEY', 'TOKOCYPTO_API_KEY'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  KEYS.forEach((k) => delete process.env[k]);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('new TOKOCRYPTO name wins over legacy', () => {
  process.env.TOKOCRYPTO_API_KEY = 'new';
  process.env.TOKOCYPTO_API_KEY = 'old';
  assert.equal(loadCredentials(EXCHANGE_REGISTRY.tokocrypto).apiKey, 'new');
});

test('legacy TOKOCYPTO name still works', () => {
  process.env.TOKOCYPTO_API_KEY = 'old';
  assert.equal(loadCredentials(EXCHANGE_REGISTRY.tokocrypto).apiKey, 'old');
});

test('neither set gives empty string', () => {
  assert.equal(loadCredentials(EXCHANGE_REGISTRY.tokocrypto).apiKey, '');
});
