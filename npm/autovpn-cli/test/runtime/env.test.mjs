import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadProjectDotEnv, mergeProjectEnv } from '../../dist/runtime/env.js';

test('loadProjectDotEnv reads project .env without exposing missing files as errors', async () => {
  const root = await mkdir(path.join(os.tmpdir(), `autovpn-env-${Date.now()}`), { recursive: true });
  await writeFile(path.join(root, '.env'), 'VPN_AUTOMATION_UPSTREAM_PROXY=off\nCLOUDFLARE_API_TOKEN=secret\n', 'utf8');

  assert.deepEqual(loadProjectDotEnv(root), {
    VPN_AUTOMATION_UPSTREAM_PROXY: 'off',
    CLOUDFLARE_API_TOKEN: 'secret'
  });
  assert.deepEqual(loadProjectDotEnv(path.join(root, 'missing')), {});
});

test('mergeProjectEnv lets explicit process env override .env values', async () => {
  const root = await mkdir(path.join(os.tmpdir(), `autovpn-env-precedence-${Date.now()}`), { recursive: true });
  await writeFile(path.join(root, '.env'), 'VPN_AUTOMATION_UPSTREAM_PROXY=off\nEXTRA=value\n', 'utf8');

  const merged = mergeProjectEnv(root, {
    VPN_AUTOMATION_UPSTREAM_PROXY: 'http://127.0.0.1:7890',
    PATH: '/bin'
  });

  assert.equal(merged.VPN_AUTOMATION_UPSTREAM_PROXY, 'http://127.0.0.1:7890');
  assert.equal(merged.EXTRA, 'value');
  assert.equal(merged.PATH, '/bin');
});
