import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(cliRoot, '..', '..');

test('start helper translates --proxy into redacted Node runtime environment', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-start-script-'));
  const capturePath = path.join(tempRoot, 'calls.jsonl');
  const fakeNode = path.join(tempRoot, 'node');
  await writeFile(fakeNode, `#!/usr/bin/env bash
printf '{"args":"%s","use_proxy":"%s","upstream":"%s","http":"%s","https":"%s","all":"%s"}\\n' "$*" "\${VPN_AUTOMATION_USE_UPSTREAM_PROXY:-}" "\${VPN_AUTOMATION_UPSTREAM_PROXY:-}" "\${HTTP_PROXY:-}" "\${HTTPS_PROXY:-}" "\${ALL_PROXY:-}" >> "$AUTOVPN_TEST_CAPTURE"
printf '{}\\n'
`, 'utf8');
  await chmod(fakeNode, 0o755);

  const proxyUrl = 'http://proxy-user:proxy-pass@127.0.0.1:7897';
  const { stdout, stderr } = await execFileAsync('bash', [
    path.join(repoRoot, 'scripts', 'start_autovpn.sh'),
    '--local',
    '--proxy', proxyUrl,
    '--logs-dir', path.join(tempRoot, 'logs'),
    '--run-id', 'fixture'
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempRoot}:${process.env.PATH ?? ''}`,
      AUTOVPN_TEST_CAPTURE: capturePath
    }
  });

  const calls = (await readFile(capturePath, 'utf8')).trim().split('\n').map(JSON.parse);
  const run = calls.find((call) => call.args.includes(' run '));
  assert.ok(run);
  assert.doesNotMatch(run.args, /--proxy/);
  assert.equal(run.use_proxy, '1');
  assert.equal(run.upstream, proxyUrl);
  assert.equal(run.http, proxyUrl);
  assert.equal(run.https, proxyUrl);
  assert.equal(run.all, proxyUrl);
  assert.doesNotMatch(`${stdout}${stderr}`, /proxy-pass/);
});
