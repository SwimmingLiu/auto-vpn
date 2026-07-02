import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runDoctor } from '../../dist/doctor/checks.js';

async function makeProjectRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autovpn-doctor-'));
  const runtimeRoot = path.join(root, '.auto-vpn');
  await mkdir(path.join(root, 'templates', 'share-worker'), { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "fixture"\n', 'utf8');
  await writeFile(path.join(root, 'templates', 'vmess_node.js'), '// worker\n', 'utf8');
  await writeFile(path.join(root, 'templates', 'share-worker', 'vpn.js'), '// share\n', 'utf8');
  await writeFile(path.join(runtimeRoot, 'profile.toml'), `
[sources.fixture]
url = "https://example.invalid/source"
key = "source-key"
enabled = true

[deploy]
project_name = "sub-nodes"
pages_project_url = "https://sub-nodes.pages.dev"
cloudflare_api_token = "token"
account_id = "account"
subscription_url = "https://example.invalid/sub"
verify_subscription_url = "https://example.invalid/verify"
secret_query = "secret"

[speed_test]
timeout_seconds = 5
concurrency = 1
min_download_mb_s = 0
max_download_bytes = 1024
probe_url = "https://example.invalid/probe"
urls = []
`, 'utf8');
  return { root, runtimeRoot };
}

test('Node doctor resolves managed JavaScript tools without installing missing tools', async () => {
  const { root, runtimeRoot } = await makeProjectRoot();
  const resolverCalls = [];
  const safeRunCalls = [];
  const result = await runDoctor(root, ['--deploy'], {
    PATH: process.env.PATH,
    VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot
  }, {
    resolveManagedNpmTool: async (options) => {
      resolverCalls.push(options);
      return { command: `/managed/bin/${options.binaryName}`, args: [], source: 'managed', packageName: options.packageName, version: options.version };
    },
    safeRun: (command) => {
      safeRunCalls.push(command);
      return { ok: true, message: 'ok' };
    }
  });
  const checks = Object.fromEntries(result.payload.checks.map((item) => [item.name, item]));

  assert.deepEqual(resolverCalls, [
    {
      packageName: 'javascript-obfuscator',
      binaryName: 'javascript-obfuscator',
      version: '5.4.3',
      projectRoot: root,
      installMissing: false
    },
    {
      packageName: 'wrangler',
      binaryName: 'wrangler',
      version: '4.106.0',
      projectRoot: root,
      installMissing: false
    }
  ]);
  assert.deepEqual(safeRunCalls.at(-1), ['/managed/bin/wrangler', 'pages', 'deploy', '--help']);
  assert.equal(checks.javascript_obfuscator.status, 'pass');
  assert.equal(checks.wrangler.status, 'pass');
});
