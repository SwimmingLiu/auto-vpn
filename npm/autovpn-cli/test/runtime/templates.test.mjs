import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveShareWorkerTemplatePath, resolveWorkerTemplatePath } from '../../dist/runtime/templates.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('resolveWorkerTemplatePath prefers a project-local override', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-template-'));
  const overridePath = path.join(projectRoot, 'templates', 'vmess_node.js');
  await mkdir(path.dirname(overridePath), { recursive: true });
  await writeFile(overridePath, '// override\n', 'utf8');

  assert.equal(resolveWorkerTemplatePath(projectRoot), overridePath);
});

test('resolveWorkerTemplatePath falls back to the template shipped in the npm package', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-template-'));

  assert.equal(
    resolveWorkerTemplatePath(projectRoot),
    path.join(packageRoot, 'dist', 'templates', 'vmess_node.js')
  );
});

test('resolveShareWorkerTemplatePath falls back to the share Worker shipped in the npm package', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-template-'));

  assert.equal(
    resolveShareWorkerTemplatePath(projectRoot, {}),
    path.join(packageRoot, 'dist', 'templates', 'share-worker', 'vpn.js')
  );
});
