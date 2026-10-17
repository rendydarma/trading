import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { listTemplates, loadTemplate, renderTemplate, matchIntent, fillVars } from '../src/templates.js';
import { createServer } from '../src/server.js';
import { registerTemplateTools } from '../src/tools/templates.js';

const SAMPLE = { symbol: 'ADA/USDT', indicator: 'vwap' };
const LEFTOVER = /\{[a-z_]+\}/;

test('matchIntent routes by frontmatter triggers with priority', () => {
  assert.equal(matchIntent('analisa BTC/USDT'), 'analysis');
  assert.equal(matchIntent('vwap 1 bulan ADA/USDT'), 'indicator');
  assert.equal(matchIntent('analisa vwap ADA'), 'analysis');
  assert.equal(matchIntent('backtest ADA 30 hari'), 'backtest');
  assert.equal(matchIntent('analisa dan backtest ADA'), 'backtest');
  assert.equal(matchIntent('halo'), null);
});

test('matchIntent matches whole words only', () => {
  assert.equal(matchIntent('lihat schema database'), null);
  assert.equal(matchIntent('cek ema ADA'), 'indicator');
  assert.equal(matchIntent('apa kabar? RSI?'), 'indicator');
});

test('listTemplates exposes analysis, indicator and backtest', () => {
  assert.deepEqual(listTemplates().map((t) => t.id).sort(), ['analysis', 'backtest', 'indicator']);
});

for (const meta of listTemplates()) {
  for (const inputStyle of meta.input_styles) {
    for (const outputStyle of meta.output_styles) {
      test(`render ${meta.id} input:${inputStyle} output:${outputStyle}`, () => {
        const { text, vars } = renderTemplate(meta.id, { inputStyle, outputStyle, vars: SAMPLE });
        const { sections } = loadTemplate(meta.id);
        assert.doesNotMatch(text, LEFTOVER);
        assert.ok(text.includes(fillVars(sections[`output:${outputStyle}`], vars)));
        assert.ok(text.includes(fillVars(sections[`input:${inputStyle}`], vars)));
      });
    }
  }
}

test('render defaults, missing vars and unknown styles', () => {
  const r = renderTemplate('analysis', { vars: { symbol: 'BTC/USDT' } });
  assert.equal(r.vars.timeframes, '15m,1h,1d');
  assert.throws(() => renderTemplate('analysis'), /Missing vars: symbol/);
  assert.throws(() => renderTemplate('indicator', { vars: { symbol: 'X' } }), /Missing vars: indicator/);
  assert.throws(() => renderTemplate('analysis', { inputStyle: 'x', vars: SAMPLE }), /ringkas, lengkap/);
  assert.throws(() => renderTemplate('analysis', { outputStyle: 'x', vars: SAMPLE }), /ringkas, detail, json, keputusan/);
  assert.throws(() => loadTemplate('nope'), /valid: /);
});

test('template content', () => {
  const k = renderTemplate('analysis', { outputStyle: 'keputusan', vars: SAMPLE }).text;
  assert.match(k, /"action"/);
  const i = renderTemplate('indicator', { vars: SAMPLE }).text;
  assert.match(i, /--only vwap/);
});

test('MCP tools and prompts work end to end', async () => {
  const server = createServer();
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const list = JSON.parse((await client.callTool({ name: 'list_prompt_templates', arguments: {} })).content[0].text);
    assert.equal(list.length, 3);

    const got = await client.callTool({ name: 'get_prompt_template', arguments: { text: 'vwap ADA/USDT', vars: { symbol: 'ADA/USDT', indicator: 'vwap' } } });
    assert.ok(!got.isError);
    assert.match(got.content[0].text, /Script: node scripts\/indicators\.js ADA\/USDT --exchange tokocrypto --tf 1h --days 30 --only vwap --vwap-anchor period/);
    assert.doesNotMatch(got.content[0].text, LEFTOVER);

    const num = await client.callTool({ name: 'get_prompt_template', arguments: { id: 'indicator', vars: { symbol: 'ADA/USDT', indicator: 'rsi', days: 7 } } });
    assert.ok(!num.isError);
    assert.match(num.content[0].text, /--days 7 /);

    const idWins = await client.callTool({ name: 'get_prompt_template', arguments: { id: 'analysis', text: 'vwap', vars: { symbol: 'X' } } });
    assert.match(idWins.content[0].text, /Template: analysis/);

    const none = await client.callTool({ name: 'get_prompt_template', arguments: { text: 'halo' } });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /analysis, backtest, indicator|valid ids/);

    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    assert.deepEqual(prompts, ['analysis', 'backtest', 'indicator']);
    const p = await client.getPrompt({ name: 'analysis', arguments: { symbol: 'BTC/USDT' } });
    assert.equal(p.messages[0].role, 'user');
    assert.match(p.messages[0].content.text, /BTC\/USDT/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('analysis min_rr var defaults to 1.5 and can be overridden', () => {
  const out = (vars) => renderTemplate('analysis', { vars: { symbol: 'X', ...vars } }).text;
  assert.match(out(), /di bawah 1:1\.5\./);
  assert.match(out({ min_rr: 2 }), /di bawah 1:2\./);
  assert.doesNotMatch(out(), /1:1,5/);
});

test('script hints carry --exchange', () => {
  assert.match(listTemplates().find((t) => t.id === 'analysis').script, /--exchange \{exchange\}/);
  assert.match(listTemplates().find((t) => t.id === 'indicator').script, /--exchange \{exchange\}/);
});

test('BOM is stripped and a malformed template is skipped with a warning, not thrown', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  const src = new URL('../prompts/indicator.md', import.meta.url);
  writeFileSync(join(dir, 'good.md'), `﻿${readFileSync(src, 'utf8')}`);
  writeFileSync(join(dir, 'bad.md'), '﻿no frontmatter here');
  writeFileSync(join(dir, 'bad2.md'), '---\n: : [unclosed\n---\n## peran\nx');
  const warn = t.mock.method(console, 'error', () => {});

  assert.deepEqual(listTemplates(dir).map((m) => m.id), ['indicator']);
  assert.equal(loadTemplate('indicator', dir).meta.id, 'indicator');
  assert.ok(warn.mock.calls.some((c) => /bad\.md/.test(c.arguments[0])));
  assert.ok(warn.mock.calls.some((c) => /bad2\.md/.test(c.arguments[0])));
  const names = [];
  const server = { registerTool() {}, registerPrompt: (n) => names.push(n) };
  registerTemplateTools(server, dir);
  assert.deepEqual(names, ['indicator']);
});
