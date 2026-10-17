import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'yaml';

const DEFAULT_DIR = fileURLToPath(new URL('../prompts', import.meta.url));
const PRIORITY = ['backtest', 'analysis', 'indicator'];
const PLACEHOLDER = /\{([a-z_]+)\}/g;

function parseFile(file) {
  const raw = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('missing frontmatter');
  const meta = parse(m[1]);
  if (!meta || typeof meta.id !== 'string' || !Array.isArray(meta.input_styles) || !Array.isArray(meta.output_styles)) {
    throw new Error('frontmatter needs id, input_styles and output_styles');
  }
  const sections = {};
  let name = null;
  for (const line of m[2].split('\n')) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { name = h[1]; sections[name] = []; } else if (name) sections[name].push(line);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join('\n').trim();
  return { meta, sections };
}

function files(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
}

// A malformed template is skipped with a warning so it cannot take the server down.
function parsedAll(dir) {
  const out = [];
  for (const f of files(dir)) {
    try { out.push(parseFile(f)); } catch (e) { console.error(`Skipping template ${f}: ${e.message}`); }
  }
  return out;
}

export function listTemplates(dir = DEFAULT_DIR) {
  return parsedAll(dir).map((p) => p.meta);
}

export function loadTemplate(id, dir = DEFAULT_DIR) {
  const all = parsedAll(dir);
  const found = all.find((p) => p.meta.id === id);
  if (!found) throw new Error(`Unknown template "${id}"; valid: ${all.map((p) => p.meta.id).join(', ')}`);
  const { meta, sections } = found;
  const required = ['peran', 'instruksi', ...meta.input_styles.map((s) => `input:${s}`), ...meta.output_styles.map((s) => `output:${s}`)];
  const missing = required.filter((s) => !sections[s]);
  if (missing.length) throw new Error(`Template "${id}" missing section(s): ${missing.join(', ')}`);
  return { meta, sections };
}

export function fillVars(str, vars) {
  const out = str.replace(PLACEHOLDER, (whole, name) => (name in vars ? vars[name] : whole));
  const left = out.match(PLACEHOLDER);
  if (left) throw new Error(`Unresolved placeholder(s): ${[...new Set(left)].join(', ')}`);
  return out;
}

export function renderTemplate(id, { inputStyle, outputStyle, vars = {} } = {}, dir = DEFAULT_DIR) {
  const { meta, sections } = loadTemplate(id, dir);
  const inStyle = inputStyle ?? meta.default_input_style;
  const outStyle = outputStyle ?? meta.default_output_style;
  if (!meta.input_styles.includes(inStyle)) throw new Error(`Unknown input style "${inStyle}"; valid: ${meta.input_styles.join(', ')}`);
  if (!meta.output_styles.includes(outStyle)) throw new Error(`Unknown output style "${outStyle}"; valid: ${meta.output_styles.join(', ')}`);

  const resolved = {};
  const missing = [];
  for (const [name, spec] of Object.entries(meta.vars ?? {})) {
    const v = vars[name];
    if (v !== undefined && v !== '') resolved[name] = String(v);
    else if (spec.default !== undefined) resolved[name] = String(spec.default);
    else if (spec.required) missing.push(name);
  }
  if (missing.length) throw new Error(`Missing vars: ${missing.join(', ')}`);

  const text = [sections.peran, sections[`input:${inStyle}`], sections.instruksi, sections[`output:${outStyle}`]]
    .map((s) => fillVars(s, resolved))
    .join('\n\n');
  return { text, meta, vars: resolved };
}

// Triggers come from frontmatter; matched on word boundaries so "ema" does not hit "schema".
export function matchIntent(text, dir = DEFAULT_DIR) {
  const lower = String(text).toLowerCase();
  const metas = listTemplates(dir);
  const rank = (id) => (PRIORITY.includes(id) ? PRIORITY.indexOf(id) : PRIORITY.length);
  metas.sort((a, b) => rank(a.id) - rank(b.id));
  for (const meta of metas) {
    for (const t of meta.triggers ?? []) {
      const esc = t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'u').test(lower)) return meta.id;
    }
  }
  return null;
}
