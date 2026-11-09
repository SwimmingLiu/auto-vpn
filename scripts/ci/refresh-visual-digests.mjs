#!/usr/bin/env node
/**
 * Write the Linux renderer digests into the visual test.
 *
 * The digests are captured on the ubuntu-24.04 runner (see
 * refresh-visual-baselines.yml) because Chromium rasterizes differently on
 * macOS. This script only edits the `linux:` block, so a macOS digest is never
 * overwritten by a value captured somewhere else.
 *
 *   node scripts/ci/refresh-visual-digests.mjs '{"dashboard":"…","runs":"…"}'
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', '..', 'electron', 'tests', 'renderer-visual.test.mjs');

const payload = JSON.parse(process.argv[2] ?? '{}');
const digests = payload.linux ?? payload;
const entries = Object.entries(digests).filter(([, value]) => /^[0-9a-f]{64}$/.test(String(value)));
if (entries.length === 0) {
  console.error('refresh-visual-digests: no 64-hex digests in the payload');
  process.exit(1);
}

const source = fs.readFileSync(target, 'utf8');
const blockPattern = /(  linux: \{\n)([\s\S]*?)(\n  \})/;
const match = blockPattern.exec(source);
if (!match) {
  console.error('refresh-visual-digests: could not find the linux digest block');
  process.exit(1);
}

const lines = new Map();
for (const [name, hash] of entries) lines.set(name, `    ${name}: '${hash}'`);
const existing = match[2].split('\n').filter((line) => line.trim());
let changed = 0;
const rewritten = existing.map((line, index, all) => {
  const name = /^\s*([a-zA-Z_]+):/.exec(line)?.[1];
  const next = name ? lines.get(name) : undefined;
  if (!next) return line;
  if (next !== line.trimEnd()) changed += 1;
  // Every entry but the last keeps its separator; the block's last line must
  // not, or the file stops parsing.
  return index === all.length - 1 ? next.replace(/,$/, '') : `${next.replace(/,$/, '')},`;
});
// A digest for a page the block does not list yet is appended, not dropped.
for (const [name, line] of lines) {
  if (!existing.some((entry) => new RegExp(`^\\s*${name}:`).test(entry))) {
    rewritten.push(line);
    changed += 1;
  }
}

fs.writeFileSync(target, source.replace(blockPattern, `${match[1]}${rewritten.join('\n')}${match[3]}`), 'utf8');
console.log(`refresh-visual-digests: ${changed} linux digest(s) updated`);
