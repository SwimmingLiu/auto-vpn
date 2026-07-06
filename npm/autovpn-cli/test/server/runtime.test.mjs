import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServerRuntime, sanitizeProfileForServer } from '../../dist/server/runtime.js';

test('server profile redacts source urls and keys', () => {
  const profile = sanitizeProfileForServer({
    sources: {
      demo: { url: 'https://provider.example/private/abc123', key: 'source-key', enabled: true }
    },
    deploy: {
      pages_project_url: 'https://sub-nodes.pages.dev',
      cloudflare_api_token: 'cloudflare-secret',
      subscription_url: 'https://vpn.example/sub'
    }
  });

  const text = JSON.stringify(profile);
  assert.doesNotMatch(text, /private\/abc123|source-key|cloudflare-secret|vpn\.example\/sub/);
  assert.equal(profile.sources.demo.url, '<redacted>');
  assert.equal(profile.sources.demo.key, '<redacted>');
  assert.equal(profile.deploy.pages_project_url, 'https://sub-nodes.pages.dev');
});

test('server runtime starts and stops managed detached jobs', async () => {
  const calls = [];
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-'));
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, 'state') },
    startDetachedRun: async (command) => {
      calls.push(['start', command]);
      return {
        job_id: 'job-1',
        status: 'running',
        event_log: path.join(projectRoot, 'state', 'jobs', 'job-1', 'events.jsonl')
      };
    },
    stopManagedJob: async (_projectRoot, jobId) => {
      calls.push(['stop', jobId]);
      return { job_id: jobId, status: 'stopped' };
    },
    followLog: async function* () {}
  });

  assert.deepEqual(await runtime.startRun({ skipDeploy: true, skipVerify: true }), {
    ok: true,
    runId: 'job-1',
    job_id: 'job-1',
    status: 'running'
  });
  assert.deepEqual(await runtime.stopRun(), {
    ok: true,
    requested: true,
    job_id: 'job-1',
    status: 'stopped'
  });
  assert.deepEqual(calls, [
    ['start', { projectRoot, skipDeploy: true, skipVerify: true, resumeLatest: false, outputFormat: 'jsonl' }],
    ['stop', 'job-1']
  ]);
});

test('server runtime starts retry jobs and preserves redacted secrets when saving profile', async () => {
  const calls = [];
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-retry-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'profile.toml'), [
    '[sources.demo]',
    'url = "https://provider.example/private"',
    'key = "source-secret"',
    'enabled = true',
    '[deploy]',
    'cloudflare_api_token = "cloudflare-secret"',
    'pages_project_url = "https://sub-nodes.pages.dev"',
    ''
  ].join('\n'), 'utf8');

  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    startDetachedRetry: async (command) => {
      calls.push(['retry', command]);
      return {
        job_id: 'retry-1',
        status: 'running',
        event_log: path.join(runtimeRoot, 'jobs', 'retry-1', 'events.jsonl')
      };
    },
    stopManagedJob: async () => ({ job_id: 'unused' }),
    followLog: async function* () {}
  });

  const saved = await runtime.saveProfile?.({
    sources: { demo: { url: '<redacted>', key: '<redacted>', enabled: false } },
    deploy: { cloudflare_api_token: '<redacted>', pages_project_url: 'https://new.example.dev' }
  });
  assert.equal(saved?.ok, true);
  const persisted = fs.readFileSync(path.join(runtimeRoot, 'profile.toml'), 'utf8');
  assert.match(persisted, /https:\/\/provider\.example\/private/);
  assert.match(persisted, /source-secret/);
  assert.match(persisted, /cloudflare-secret/);
  assert.match(persisted, /https:\/\/new\.example\.dev/);

  assert.deepEqual(await runtime.startRetry?.({ artifactDir: '/artifacts/run-1', stage: 'render' }), {
    ok: true,
    runId: 'retry-1',
    job_id: 'retry-1',
    status: 'running'
  });
  assert.deepEqual(calls, [
    ['retry', { projectRoot, artifactDir: '/artifacts/run-1', stage: 'render', outputFormat: 'jsonl' }]
  ]);
});

test('server runtime state includes latest artifact preview and retry artifacts', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-artifacts-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20260703-120000');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'profile.toml'), '[sources.demo]\nurl = "https://provider.example/private"\nkey = "secret"\n', 'utf8');
  fs.writeFileSync(path.join(artifactDir, 'pipeline_report.json'), JSON.stringify({
    run_status: 'success',
    stage_status: { deploy: 'success' },
    counts: { final_links: 2 },
    deployment: { pages_project_url: 'https://sub-nodes.pages.dev', subscription_url: 'https://secret.example/sub' }
  }), 'utf8');
  fs.writeFileSync(path.join(artifactDir, 'vpn_node_emoji.txt'), 'vmess://invalid\n', 'utf8');

  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    startDetachedRun: async () => ({ job_id: 'unused' }),
    stopManagedJob: async () => ({ job_id: 'unused' }),
    followLog: async function* () {}
  });

  const state = await runtime.loadState();
  assert.equal(state.artifact?.artifact_dir, artifactDir);
  assert.equal(state.artifact?.run_status, 'success');
  assert.equal(state.deployment?.pages_project_url, 'https://sub-nodes.pages.dev');
  assert.equal(state.retryArtifacts?.length, 1);
  assert.doesNotMatch(JSON.stringify(state), /provider\.example\/private|secret\.example\/sub|secret/);
});
