import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('indicators self-test passes', () => {
  const out = execFileSync(process.execPath, ['scripts/indicators.js', '--test'], { cwd: root, encoding: 'utf8' });
  assert.ok(out.includes('self-test OK'));
});
