import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

test('npm package ships the canonical Worker template', async () => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const canonicalTemplate = await readFile(path.join(repoRoot, 'templates', 'vmess_node.js'), 'utf8');
  const packagedTemplate = await readFile(path.join(packageRoot, 'dist', 'templates', 'vmess_node.js'), 'utf8');

  assert.ok(packageJson.files.includes('dist/'));
  assert.equal(packagedTemplate, canonicalTemplate);
});

test('npm package ships the canonical share Worker template', async () => {
  const canonicalTemplate = await readFile(path.join(repoRoot, 'templates', 'share-worker', 'vpn.js'), 'utf8');
  const packagedTemplate = await readFile(path.join(packageRoot, 'dist', 'templates', 'share-worker', 'vpn.js'), 'utf8');

  assert.equal(packagedTemplate, canonicalTemplate);
});
