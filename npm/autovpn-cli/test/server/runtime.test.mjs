import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountStore } from '../../dist/pool/account-store.js';
import { createServerRuntime, sanitizeProfileForServer } from '../../dist/server/runtime.js';
import { RunStore } from '../../dist/pipeline/run-store.js';

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJobFixture(runtimeRoot, jobId, fields = {}) {
  const jobDir = path.join(runtimeRoot, 'jobs', jobId);
  const createdAt = fields.created_at ?? '2026-07-09T00:00:00+00:00';
  const job = {
    schema_version: 1,
    job_id: jobId,
    kind: 'run',
    status: 'running',
    pid: process.pid,
    pgid: process.pid,
    created_at: createdAt,
    started_at: createdAt,
    finished_at: '',
    updated_at: createdAt,
    exit_code: null,
    signal: '',
    project_root: '',
    command: [],
    event_log: path.join(jobDir, 'events.jsonl'),
    human_log: path.join(jobDir, 'human.log'),
    stdout_log: path.join(jobDir, 'stdout.log'),
    stderr_log: path.join(jobDir, 'stderr.log'),
    artifact_dir: '',
    session_dir: jobDir,
    resume_from: '',
    retry: { source_artifact_dir: '', stage: '' },
    options: {},
    stop_requested_at: '',
    last_event_at: '',
    last_error: '',
    job_file: path.join(jobDir, 'job.json'),
    ...fields
  };
  fs.mkdirSync(jobDir, { recursive: true });
  for (const key of ['event_log', 'human_log', 'stdout_log', 'stderr_log']) {
    fs.closeSync(fs.openSync(String(job[key]), 'a'));
  }
  writeJson(job.job_file, job);
  writeJson(path.join(runtimeRoot, 'jobs', 'index.json'), {
    schema_version: 1,
    latest_job_id: jobId,
    jobs: [{ job_id: jobId, status: job.status, kind: job.kind, created_at: job.created_at, job_file: job.job_file }]
  });
  return job;
}

test('running state restores SQLite passed totals and repeated follower events carry absolute progress', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-live-counts-'));
  const artifact = path.join(root, 'artifacts', '20261110-120000');
  fs.mkdirSync(artifact, { recursive: true });
  writeJson(path.join(artifact, 'pipeline_report.json'), { run_status: 'running', stage_status: { extract: 'running' }, counts: {} });
  const store = RunStore.open(path.join(artifact, 'run.db'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  store.initializeRun('running');
  const link = (n, name = 'node') => 'vmess://' + Buffer.from(JSON.stringify({ ps: name, add: `203.0.113.${n}`, port: '443', id: 'fixture-uuid', net: 'ws', path: '/' })).toString('base64');
  const passed = link(1), failed = link(2), pending = link(3);
  store.recordExtractedNode('leiting', passed);
  store.recordExtractedNode('heidong', link(1, 'same endpoint'));
  store.recordExtractedNode('heidong', failed);
  store.recordExtractedNode('heidong', pending);
  store.recordSpeedResult({ link: passed, reachable: true, average_download_mb_s: 2, latency_ms: 1, error: '' }, true);
  store.recordSpeedResult({ link: failed, reachable: false, average_download_mb_s: 0, latency_ms: 0, error: 'unreachable' }, false);
  store.markSpeedRunning(pending);
  store.recordAvailabilityResult({ link: passed, all_passed: true, provider_results: {} });
  store.recordAvailabilityResult({ link: failed, all_passed: false, provider_results: {} });
  writeJobFixture(root, 'live-counts', { artifact_dir: artifact });
  let deliver;
  const gate = new Promise((resolve) => { deliver = resolve; });
  const runtime = createServerRuntime({ projectRoot: root, env: { VPN_AUTOMATION_RUNTIME_ROOT: root, AUTOVPN_SERVER_HISTORY_RETENTION_DAYS: '0' }, followLog: async function* () {
    await gate;
    yield JSON.stringify({ type: 'speedtest_result', link: passed, passed_threshold: true }) + '\n';
    yield JSON.stringify({ type: 'speedtest_result', link: passed, passed_threshold: true }) + '\n';
  } });
  const received = [];
  runtime.subscribe((event) => received.push(event));
  const snapshot = await runtime.loadState();
  assert.deepEqual(snapshot.artifact.counts, { raw_links: 4, deduped_links: 3, speedtest_links: 1, availability_links: 1 });
  assert.deepEqual(snapshot.artifact.source_counts, { leiting: { raw_links: 1, deduped_links: 1 }, heidong: { raw_links: 3, deduped_links: 2 } });
  assert.ok(snapshot.artifact.progress_snapshot);
  deliver();
  for (let attempt = 0; attempt < 50 && received.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(received.length, 2);
  assert.deepEqual(received[0].progress_snapshot.counts, snapshot.artifact.counts);
  assert.deepEqual(received[1].progress_snapshot.counts, snapshot.artifact.counts);
});

test('server profile only redacts Cloudflare token and Pages Secret ADMIN with field labels', () => {
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
  assert.match(text, /private\/abc123|source-key|vpn\.example\/sub/);
  assert.doesNotMatch(text, /cloudflare-secret/);
  assert.equal(profile.sources.demo.url, 'https://provider.example/private/abc123');
  assert.equal(profile.sources.demo.key, 'source-key');
  assert.equal(profile.deploy.pages_project_url, 'https://sub-nodes.pages.dev');
  assert.equal(profile.deploy.subscription_url, 'https://vpn.example/sub');
  assert.equal(profile.deploy.cloudflare_api_token, '<Cloudflare Token>');
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
    status: 'stopped',
    stopped: true
  });
  assert.deepEqual(calls, [
    ['start', { projectRoot, skipDeploy: true, skipVerify: true, resumeLatest: false, outputFormat: 'jsonl' }],
    ['stop', 'job-1']
  ]);
});

test('server runtime restores an active latest job after serve restarts', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-restore-active-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  const job = writeJobFixture(runtimeRoot, 'active-job', { project_root: projectRoot });
  const calls = [];
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    stopManagedJob: async (_projectRoot, jobId) => {
      calls.push(['stop', jobId]);
      return { job_id: jobId, status: 'stopped' };
    },
    followLog: async function* (_projectRoot, jobId) {
      calls.push(['follow', jobId]);
      yield JSON.stringify({ type: 'stage', stage: 'extract', status: 'running' }) + '\n';
    }
  });

  const state = await runtime.loadState();

  assert.equal(state.runState, 'running');
  assert.deepEqual(await runtime.stopRun?.(), {
    ok: true,
    requested: true,
    job_id: job.job_id,
    status: 'stopped',
    stopped: true
  });
  assert.deepEqual(calls, [['follow', 'active-job'], ['stop', 'active-job']]);
});

test('server runtime reconciles failed job status when log following ends without a terminal event', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-follow-failed-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  const job = writeJobFixture(runtimeRoot, 'crashed-job', {
    project_root: projectRoot,
    pid: 0
  });
  const states = [];
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    startDetachedRun: async () => job,
    followLog: async function* () {
      yield JSON.stringify({ type: 'stage', stage: 'speedtest', status: 'running' }) + '\n';
      writeJson(job.job_file, {
        ...job,
        status: 'failed',
        finished_at: '2026-07-09T00:01:00+00:00',
        exit_code: 1,
        last_error: 'process exited without terminal status'
      });
    }
  });
  runtime.subscribe?.((event) => {
    if (event?.type === 'server_state') {
      states.push(event.run_state);
    }
  });

  await runtime.startRun?.({ skipDeploy: true, skipVerify: true });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal((await runtime.loadState()).runState, 'failed');
  assert.deepEqual(states, ['failed']);
});

test('server runtime returns recent latest job events for page refresh hydration', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-refresh-events-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  const job = writeJobFixture(runtimeRoot, 'active-job', { project_root: projectRoot });
  fs.writeFileSync(job.event_log, [
    JSON.stringify({ type: 'stage', stage: 'doctor', status: 'success' }),
    JSON.stringify({ type: 'stage', stage: 'extract', status: 'running' }),
    JSON.stringify({ type: 'log', message: '[extract] leiting 开始提取' }),
    ''
  ].join('\n'), 'utf8');
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    followLog: async function* () {}
  });

  const state = await runtime.loadState();

  assert.equal(state.runState, 'running');
  assert.deepEqual(state.logEvents?.map((event) => event.type), ['stage', 'stage', 'log']);
  assert.equal(state.logEvents?.[1].stage, 'extract');
});

test('server runtime close stops the restored active latest job', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-close-stops-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  const job = writeJobFixture(runtimeRoot, 'active-job', { project_root: projectRoot });
  const calls = [];
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    stopManagedJob: async (_projectRoot, jobId) => {
      calls.push(jobId);
      writeJson(job.job_file, { ...job, status: 'stopped', finished_at: '2026-07-09T00:01:00+00:00' });
      return { job_id: jobId, status: 'stopped' };
    },
    followLog: async function* () {}
  });

  await runtime.close?.();

  assert.deepEqual(calls, [job.job_id]);
  assert.equal((await runtime.loadState()).runState, 'idle');
});

test('server runtime retains terminal latest job state only within the configured TTL', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-terminal-ttl-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  writeJobFixture(runtimeRoot, 'fresh-failed-job', {
    project_root: projectRoot,
    status: 'failed',
    pid: 0,
    finished_at: '2026-07-09T00:09:00+00:00',
    exit_code: 1
  });
  const freshRuntime = createServerRuntime({
    projectRoot,
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
      AUTOVPN_SERVER_TERMINAL_STATE_TTL_SECONDS: '600'
    },
    now: () => new Date('2026-07-09T00:10:00Z'),
    followLog: async function* () {}
  });

  assert.equal((await freshRuntime.loadState()).runState, 'failed');

  const expiredRuntime = createServerRuntime({
    projectRoot,
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
      AUTOVPN_SERVER_TERMINAL_STATE_TTL_SECONDS: '600'
    },
    now: () => new Date('2026-07-09T00:30:00Z'),
    followLog: async function* () {}
  });

  assert.equal((await expiredRuntime.loadState()).runState, 'idle');
});

test('server runtime prunes artifacts and jobs older than the configured retention window', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-prune-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactsRoot = path.join(runtimeRoot, 'artifacts');
  const oldArtifact = path.join(artifactsRoot, '20260630-000000');
  const freshArtifact = path.join(artifactsRoot, '20260708-000000');
  fs.mkdirSync(oldArtifact, { recursive: true });
  fs.mkdirSync(freshArtifact, { recursive: true });
  fs.writeFileSync(path.join(oldArtifact, 'pipeline_report.json'), '{"run_status":"failed"}\n', 'utf8');
  fs.writeFileSync(path.join(freshArtifact, 'pipeline_report.json'), '{"run_status":"success"}\n', 'utf8');
  fs.utimesSync(oldArtifact, new Date('2026-06-30T00:00:00Z'), new Date('2026-06-30T00:00:00Z'));
  fs.utimesSync(freshArtifact, new Date('2026-07-08T00:00:00Z'), new Date('2026-07-08T00:00:00Z'));
  const oldJob = writeJobFixture(runtimeRoot, 'old-job', {
    project_root: projectRoot,
    status: 'failed',
    pid: 0,
    artifact_dir: oldArtifact,
    created_at: '2026-06-30T00:00:00+00:00',
    finished_at: '2026-06-30T00:01:00+00:00',
    exit_code: 1
  });
  const freshJob = writeJobFixture(runtimeRoot, 'fresh-job', {
    project_root: projectRoot,
    status: 'success',
    pid: 0,
    artifact_dir: freshArtifact,
    created_at: '2026-07-08T00:00:00+00:00',
    finished_at: '2026-07-08T00:01:00+00:00',
    exit_code: 0
  });
  writeJson(path.join(runtimeRoot, 'jobs', 'index.json'), {
    schema_version: 1,
    latest_job_id: 'fresh-job',
    jobs: [
      { job_id: 'old-job', status: 'failed', kind: 'run', created_at: oldJob.created_at, job_file: oldJob.job_file },
      { job_id: 'fresh-job', status: 'success', kind: 'run', created_at: freshJob.created_at, job_file: freshJob.job_file }
    ]
  });

  const runtime = createServerRuntime({
    projectRoot,
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
      AUTOVPN_SERVER_HISTORY_RETENTION_DAYS: '7'
    },
    now: () => new Date('2026-07-09T00:00:00Z'),
    followLog: async function* () {}
  });

  await runtime.loadState();

  assert.equal(fs.existsSync(oldArtifact), false);
  assert.equal(fs.existsSync(path.dirname(oldJob.job_file)), false);
  assert.equal(fs.existsSync(freshArtifact), true);
  assert.equal(fs.existsSync(path.dirname(freshJob.job_file)), true);
  const index = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'jobs', 'index.json'), 'utf8'));
  assert.deepEqual(index.jobs.map((item) => item.job_id), ['fresh-job']);
  assert.equal(index.latest_job_id, 'fresh-job');
});

test('server runtime forwards opt-in proxy settings through worker env without forcing CLI Python proxy mode', async () => {
  const calls = [];
  const execOptions = [];
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-proxy-'));
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, 'state') },
    proxy: { enabled: true, url: 'http://127.0.0.1:7897' },
    startDetachedRun: async (command, options) => {
      calls.push(command);
      execOptions.push(options);
      return {
        job_id: 'job-proxy',
        status: 'running',
        event_log: path.join(projectRoot, 'state', 'jobs', 'job-proxy', 'events.jsonl')
      };
    },
    followLog: async function* () {}
  });

  await runtime.startRun?.({ skipDeploy: true, skipVerify: true });

  assert.equal(calls[0].useProxy, undefined);
  assert.equal(calls[0].proxyUrl, undefined);
  assert.equal(execOptions[0].env.VPN_AUTOMATION_USE_UPSTREAM_PROXY, '1');
  assert.equal(execOptions[0].env.VPN_AUTOMATION_UPSTREAM_PROXY, 'http://127.0.0.1:7897');
});

test('server runtime rolls back run state when detached run creation fails', async () => {
  const states = [];
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-start-fails-'));
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, 'state') },
    startDetachedRun: async () => {
      throw new Error('spawn failed');
    },
    followLog: async function* () {}
  });
  runtime.subscribe?.((event) => {
    if (event && typeof event === 'object' && event.type === 'server_state') {
      states.push(event.run_state);
    }
  });

  await assert.rejects(() => runtime.startRun?.({ skipDeploy: true, skipVerify: true }), /spawn failed/);

  const state = await runtime.loadState();
  assert.equal(state.runState, 'failed');
  assert.deepEqual(states, ['failed']);
  assert.deepEqual(await runtime.stopRun?.(), {
    ok: true,
    requested: false,
    run_state: 'failed'
  });
});

test('server runtime stop reports terminal state when logs already marked run failed', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-stop-failed-'));
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, 'state') },
    startDetachedRun: async () => ({
      job_id: 'job-failed-before-stop',
      status: 'running',
      event_log: path.join(projectRoot, 'state', 'jobs', 'job-failed-before-stop', 'events.jsonl')
    }),
    stopManagedJob: async () => {
      throw new Error('stop should not be called for a terminal run');
    },
    followLog: async function* () {
      yield JSON.stringify({ type: 'run_failed', error: 'Error: fetch failed' }) + '\n';
    }
  });

  await runtime.startRun?.({ skipDeploy: true, skipVerify: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await runtime.stopRun?.(), {
    ok: true,
    requested: false,
    run_state: 'failed'
  });
});

test('server runtime marks run failed when followed logs emit run_failed', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-failed-'));
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, 'state') },
    startDetachedRun: async () => ({
      job_id: 'job-failed',
      status: 'running',
      event_log: path.join(projectRoot, 'state', 'jobs', 'job-failed', 'events.jsonl')
    }),
    followLog: async function* () {
      yield JSON.stringify({ type: 'stage', stage: 'extract', status: 'failed' }) + '\n';
      yield JSON.stringify({ type: 'summary', run_status: 'failed', error: 'Error: fetch failed' }) + '\n';
      yield JSON.stringify({ type: 'run_failed', error: 'Error: fetch failed' }) + '\n';
    }
  });

  await runtime.startRun?.({ skipDeploy: true, skipVerify: true });
  await new Promise((resolve) => setImmediate(resolve));
  const state = await runtime.loadState();

  assert.equal(state.runState, 'failed');
});

test('server runtime starts retry jobs with serve proxy env and preserves redacted secrets when saving profile', async () => {
  const calls = [];
  const execOptions = [];
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
    proxy: { enabled: true, url: 'http://127.0.0.1:7897' },
    startDetachedRetry: async (command, options) => {
      calls.push(['retry', command]);
      execOptions.push(options);
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
  assert.equal(execOptions[0].env.VPN_AUTOMATION_USE_UPSTREAM_PROXY, '1');
  assert.equal(execOptions[0].env.VPN_AUTOMATION_UPSTREAM_PROXY, 'http://127.0.0.1:7897');
});

test('server runtime persists source iteration settings for subsequent runs', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-runtime-profile-save-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'profile.toml'), [
    '[sources.demo]',
    'url = "https://provider.example/private"',
    'key = "source-secret"',
    'enabled = true',
    'max_iterations = 10',
    'min_iterations = 0',
    '',
    '[deploy]',
    'pages_project_url = "https://sub-nodes.pages.dev"',
    ''
  ].join('\n'), 'utf8');

  const observed = [];
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    startDetachedRun: async () => {
      observed.push(fs.readFileSync(path.join(runtimeRoot, 'profile.toml'), 'utf8'));
      return {
        job_id: 'run-after-save',
        status: 'running',
        event_log: path.join(runtimeRoot, 'jobs', 'run-after-save', 'events.jsonl')
      };
    },
    stopManagedJob: async () => ({ job_id: 'unused' }),
    followLog: async function* () {}
  });

  await runtime.saveProfile?.({
    sources: { demo: { url: 'https://provider.example/private', key: 'source-secret', enabled: true, max_iterations: 25, min_iterations: 0 } },
    deploy: { pages_project_url: 'https://sub-nodes.pages.dev' }
  });

  const persisted = fs.readFileSync(path.join(runtimeRoot, 'profile.toml'), 'utf8');
  assert.match(persisted, /max_iterations = 25/);
  const state = await runtime.loadState?.();
  assert.equal(state?.profile?.sources?.demo?.max_iterations, 25);
  await runtime.startRun?.({ skipDeploy: true, skipVerify: true });
  assert.match(observed.at(-1), /max_iterations = 25/);
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
  assert.equal(fs.realpathSync(String(state.artifact?.artifact_dir)), fs.realpathSync(artifactDir));
  assert.equal(state.artifact?.run_status, 'success');
  assert.equal(state.deployment?.pages_project_url, 'https://sub-nodes.pages.dev');
  assert.equal(state.retryArtifacts?.length, 1);
  const stateText = JSON.stringify(state);
  assert.match(stateText, /provider\.example\/private/);
  assert.match(stateText, /"key":"secret"/);
  assert.equal(state.deployment?.subscription_url, 'set');
});

test('server state ships the final node rows so the browser charts countries', async (t) => {
  // `/api/state` used to answer `nodeRows: []`. The results page and the
  // 国家分布 donut read that array, so the served UI showed 0 nodes and an
  // empty region chart even on a complete artifact.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-rows-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261111-042453');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'pipeline_report.json'), JSON.stringify({ run_status: 'success', counts: { final_links: 3 } }), 'utf8');
  const link = (ps) => 'vmess://' + Buffer.from(JSON.stringify({ ps, add: '203.0.113.7', port: '443', id: 'fixture-uuid', net: 'ws', path: '/' })).toString('base64');
  fs.writeFileSync(path.join(artifactDir, 'vpn_node_emoji.txt'), [link('🇺🇸 US 76'), link('🇹🇼 TW 972'), link('🇸🇬 SG 1050')].join('\n') + '\n', 'utf8');

  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    startDetachedRun: async () => ({ job_id: 'unused' }),
    stopManagedJob: async () => ({ job_id: 'unused' }),
    followLog: async function* () {}
  });

  const state = await runtime.loadState();
  const rows = state.artifact?.nodeRows;
  assert.equal(Array.isArray(rows), true);
  assert.deepEqual(rows.map((row) => row.regionCode), ['US', 'TW', 'SG']);
  assert.deepEqual(rows.map((row) => row.name), ['🇺🇸 US 76', '🇹🇼 TW 972', '🇸🇬 SG 1050']);
  assert.equal(rows[0].link.startsWith('vmess://'), true);
  assert.deepEqual(state.artifact?.safe_node_counts.regions, [
    { region_code: 'SG', count: 1 },
    { region_code: 'TW', count: 1 },
    { region_code: 'US', count: 1 }
  ]);
});

test('a credential source password is redacted before it reaches the client', () => {
  // The state endpoint must not echo a real account password back to the UI.
  const profile = sanitizeProfileForServer({
    sources: {
      brand_a: { mode: 'credential', official_site: 'https://site.example', account: 'user1', password: 'secret-pass' },
      brand_b: { mode: 'credential', official_site: 'https://other.example', account: 'user2', password: '' }
    }
  });
  assert.equal(profile.sources.brand_a.password, '<redacted>');
  assert.equal(profile.sources.brand_b.password, '');
  assert.equal(profile.sources.brand_a.account, 'user1');
  assert.equal(profile.sources.brand_a.official_site, 'https://site.example');
});

test('page refresh retains early extraction substages beyond the bounded text log tail', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-substage-history-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const job = writeJobFixture(runtimeRoot, 'active-job', { project_root: projectRoot });
  const step = { type: 'extract_substage', source_name: 'leiting', platform: 'android', substage: 'apk_analysis', status: 'success' };
  fs.writeFileSync(job.event_log, [JSON.stringify(step), ...Array(1100).fill(JSON.stringify({ type: 'log', message: 'later' }))].join('\n'));
  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  const state = await runtime.loadState();
  assert.deepEqual(state.logEvents[0], step);
  assert.equal(state.logEvents.filter((event) => event.type === 'log').length, 1000);
});

test('a finished stage stays finished when its success lands inside the log tail', async (t) => {
  // The regression: the fold only looked at events *before* the bounded tail,
  // so extract/dedupe/speedtest/availability whose final `success` fell inside
  // the tail were replayed as `running` and the run page never left 运行中.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-stage-tail-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const job = writeJobFixture(runtimeRoot, 'finished-job', { project_root: projectRoot, status: 'success' });
  const stages = ['doctor', 'extract', 'dedupe', 'speedtest', 'availability'];
  const events = [];
  for (const stage of stages) {
    events.push({ type: 'stage', stage, status: 'running' });
    events.push(...Array(300).fill({ type: 'log', message: `[${stage}] working` }));
    events.push({ type: 'stage', stage, status: 'success' });
  }
  fs.writeFileSync(job.event_log, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    now: () => new Date('2026-07-09T01:00:00Z'),
    followLog: async function* () {}
  });
  const state = await runtime.loadState();
  const replayed = Object.fromEntries(
    state.logEvents.filter((event) => event.type === 'stage').map((event) => [event.stage, event.status])
  );
  assert.deepEqual(replayed, { doctor: 'success', extract: 'success', dedupe: 'success', speedtest: 'success', availability: 'success' });
});

test('a scheduled run with no job directory still hydrates its stages and logs', async (t) => {
  // cron runs `autovpn run` directly: there is no job record, so the only
  // history is the mirror the CLI writes beside the artifact.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-artifact-log-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-030000');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), {
    run_status: 'success',
    stage_status: { extract: 'success', dedupe: 'success', speedtest: 'success', availability: 'success' },
    counts: { raw_links: 3, deduped_links: 3, final_links: 3 }
  });
  fs.writeFileSync(path.join(artifactDir, 'events.jsonl'), [
    { type: 'run_started', artifact_dir: artifactDir },
    { type: 'stage', stage: 'extract', status: 'running' },
    { type: 'log', message: '[extract] leiting 开始提取' },
    { type: 'stage', stage: 'extract', status: 'success' },
    { type: 'summary', run_status: 'success', artifact_dir: artifactDir }
  ].map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  const state = await runtime.loadState();
  assert.deepEqual(state.logEvents.map((event) => event.type), ['stage', 'run_started', 'log', 'summary']);
  assert.equal(state.logEvents[0].status, 'success');
  assert.equal(state.logEvents[2].message, '[extract] leiting 开始提取');
});

test('log retention prunes yesterday\'s daily-run logs and keeps today\'s', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-log-retention-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const logs = path.join(runtimeRoot, 'logs');
  const results = path.join(runtimeRoot, 'daily-run-results');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(results, { recursive: true });
  const oldLog = path.join(logs, 'daily-run-20261110-032000.log');
  const todayLog = path.join(logs, 'daily-run-20261112-032000.log');
  const oldResult = path.join(results, '20261110-032000.json');
  const todayResult = path.join(results, '20261112-032000.json');
  // systemd keeps the serve unit's own stdout file open in the same directory.
  const serverLog = path.join(logs, 'server-v201.log');
  for (const file of [oldLog, todayLog, oldResult, todayResult, serverLog]) fs.writeFileSync(file, 'record\n', 'utf8');
  const yesterday = new Date('2026-11-10T03:20:00Z');
  const today = new Date('2026-11-12T03:20:00Z');
  fs.utimesSync(oldLog, yesterday, yesterday);
  fs.utimesSync(oldResult, yesterday, yesterday);
  fs.utimesSync(todayLog, today, today);
  fs.utimesSync(todayResult, today, today);
  fs.utimesSync(serverLog, yesterday, yesterday);
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot, AUTOVPN_SERVER_LOG_RETENTION_DAYS: '1' },
    now: () => new Date('2026-11-12T04:00:00Z'),
    followLog: async function* () {}
  });
  await runtime.loadState();
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(oldResult), false);
  assert.equal(fs.existsSync(todayLog), true);
  assert.equal(fs.existsSync(todayResult), true);
  // The daemon's own log is not this job's record, however old it looks.
  assert.equal(fs.existsSync(serverLog), true);
});

test('a scheduled run is followed live and the follower stops at its summary', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-artifact-follow-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-040000');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: { extract: 'running' }, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n', 'utf8');
  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  const state = await runtime.loadState();
  assert.equal(state.runState, 'running', 'a growing artifact log means the run is live');

  fs.appendFileSync(log, JSON.stringify({ type: 'stage', stage: 'extract', status: 'success' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(seen.some((event) => event.type === 'stage' && event.status === 'success'), 'the appended stage must reach subscribers');

  fs.appendFileSync(log, JSON.stringify({ type: 'summary', run_status: 'success', artifact_dir: artifactDir }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(seen.some((event) => event.type === 'server_state' && event.run_state === 'success'));
  const afterSummary = seen.length;
  fs.appendFileSync(log, JSON.stringify({ type: 'log', message: 'late line' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(seen.length, afterSummary, 'the follower must stop once the run reported its summary');
});

test('a new scheduled run is followed even after the previous one reported success', async (t) => {
  // The terminal state belongs to the run that produced it. A cron run the next
  // night writes a fresh artifact log, and the page must pick it up without a
  // server restart — the old code returned early on any non-idle state.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-artifact-reattach-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const previous = path.join(runtimeRoot, 'artifacts', '20261112-030000');
  const current = path.join(runtimeRoot, 'artifacts', '20261113-030000');
  fs.mkdirSync(previous, { recursive: true });
  fs.mkdirSync(current, { recursive: true });
  writeJson(path.join(previous, 'pipeline_report.json'), { run_status: 'success', counts: { final_links: 2 } });
  fs.writeFileSync(path.join(previous, 'events.jsonl'),
    JSON.stringify({ type: 'summary', run_status: 'success', artifact_dir: previous }) + '\n', 'utf8');
  writeJson(path.join(current, 'pipeline_report.json'), { run_status: 'running', stage_status: { extract: 'running' }, counts: {} });
  const log = path.join(current, 'events.jsonl');
  fs.writeFileSync(log, JSON.stringify({ type: 'run_started', artifact_dir: current }) + '\n', 'utf8');

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  const state = await runtime.loadState();
  assert.equal(state.runState, 'running');

  fs.appendFileSync(log, JSON.stringify({ type: 'stage', stage: 'dedupe', status: 'success' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(
    seen.some((event) => event.type === 'stage' && event.stage === 'dedupe' && event.status === 'success'),
    'the new artifact log must be followed after a terminal previous run'
  );
});

test('a followed artifact result line carries absolute database totals', async (t) => {
  // Replayed result lines arrive after the page already hydrated a snapshot;
  // without absolute totals the renderer adds them on top and doubles counts.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-artifact-progress-'));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-050000');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: { extract: 'running' }, counts: {} });
  const store = RunStore.open(path.join(artifactDir, 'run.db'));
  t.after(() => { store.close(); fs.rmSync(projectRoot, { recursive: true, force: true }); });
  store.initializeRun('running');
  const link = (n) => 'vmess://' + Buffer.from(JSON.stringify({ ps: 'node', add: `203.0.113.${n}`, port: '443', id: 'fixture-uuid', net: 'ws', path: '/' })).toString('base64');
  store.recordExtractedNode('leiting', link(1));
  store.recordExtractedNode('leiting', link(2));
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n', 'utf8');

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  await runtime.loadState();

  fs.appendFileSync(log, JSON.stringify({ type: 'extract_iteration', source_name: 'leiting', iteration: 1 }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const metric = seen.find((event) => event.type === 'extract_iteration');
  assert.ok(metric, 'the appended result line must reach subscribers');
  assert.deepEqual(metric.progress_snapshot?.counts, { raw_links: 2, deduped_links: 2, speedtest_links: 0, availability_links: 0 });
  assert.equal(fs.realpathSync(String(metric.progress_snapshot?.artifact_dir)), fs.realpathSync(artifactDir));
});

test('a resume appended after an earlier terminal line is still followed', async (t) => {
  // A resume reuses the artifact and appends to the same events.jsonl. Scanning
  // the whole file for any terminal line marked the live resume finished, so
  // the page kept the old failure and never followed the new events.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-resume-log-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-070000');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: { availability: 'running' }, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, [
    { type: 'run_started', artifact_dir: artifactDir },
    { type: 'summary', run_status: 'failed', artifact_dir: artifactDir },
    // The operator resumed it; the mirror is seeded from the session.
    { type: 'resume_pipeline_state', artifact_dir: artifactDir, speedtest_links: 4 }
  ].map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  const state = await runtime.loadState();
  assert.equal(state.runState, 'running', 'the last run in the log is the resumed one');

  fs.appendFileSync(log, JSON.stringify({ type: 'stage', stage: 'availability', status: 'success' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(
    seen.some((event) => event.type === 'stage' && event.stage === 'availability' && event.status === 'success'),
    'the resumed run must be followed past the earlier terminal line'
  );
});

test('a resume shared with a failed run does not replay the old failure', async (t) => {
  // The follower used to start at byte 0 of the shared log. The first poll
  // replayed the earlier `summary failed`, republished a terminal state, and
  // then unsubscribed itself — so a resumed run's later stages never reached a
  // page that was already open. Starting at the last run boundary fixes both.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-resume-replay-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-071500');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: { availability: 'running' }, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, [
    { type: 'run_started', artifact_dir: artifactDir },
    { type: 'summary', run_status: 'failed', artifact_dir: artifactDir },
    { type: 'resume_pipeline_state', artifact_dir: artifactDir, speedtest_links: 4 }
  ].map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  const state = await runtime.loadState();
  assert.equal(state.runState, 'running');
  // Let the first poll consume the seed file before anything new is appended.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(
    seen.some((event) => event.type === 'server_state' && event.run_state === 'failed'),
    false,
    'the interrupted run\'s failure is not this run\'s state'
  );

  fs.appendFileSync(log, JSON.stringify({ type: 'stage', stage: 'availability', status: 'success' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(
    seen.some((event) => event.type === 'stage' && event.stage === 'availability' && event.status === 'success'),
    'the follower must stay attached to the resumed run'
  );
});

test('a speedtest resume counts as a live run', async (t) => {
  // `autovpn resume speedtest` appends `speedtest_resume_state`, which was not
  // a run boundary: a failed summary before it kept the log "finished", so the
  // page read idle and never followed the live speedtest retry.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-speedtest-resume-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-081500');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: { speedtest: 'running' }, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, [
    { type: 'run_started', artifact_dir: artifactDir },
    { type: 'summary', run_status: 'failed', artifact_dir: artifactDir },
    { type: 'speedtest_resume_state', resumed_probe_count: 10, total_links: 40 }
  ].map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  const state = await runtime.loadState();
  assert.equal(state.runState, 'running', 'a live speedtest resume is a running run');

  fs.appendFileSync(log, JSON.stringify({ type: 'stage', stage: 'speedtest', status: 'success' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(seen.some((event) => event.type === 'stage' && event.stage === 'speedtest' && event.status === 'success'));
});

test('the next night\'s run reaches an open page without a reload', async (t) => {
  // Night 1's follower clears itself at its summary. Nothing called loadState
  // afterwards, so night 2's artifact log sat unread until someone reloaded —
  // the "logs stopped refreshing" complaint, one run later. The runtime now
  // watches for a run it is not following.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-watch-next-run-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const first = path.join(runtimeRoot, 'artifacts', '20261112-031500');
  fs.mkdirSync(first, { recursive: true });
  writeJson(path.join(first, 'pipeline_report.json'), { run_status: 'running', stage_status: { extract: 'running' }, counts: {} });
  const firstLog = path.join(first, 'events.jsonl');
  fs.writeFileSync(firstLog, JSON.stringify({ type: 'run_started', artifact_dir: first }) + '\n', 'utf8');

  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    followLog: async function* () {},
    runWatchIntervalMs: 1000
  });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  await runtime.loadState();
  fs.appendFileSync(firstLog, JSON.stringify({ type: 'summary', run_status: 'success', artifact_dir: first }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const second = path.join(runtimeRoot, 'artifacts', '20261113-031500');
  fs.mkdirSync(second, { recursive: true });
  writeJson(path.join(second, 'pipeline_report.json'), { run_status: 'running', stage_status: { extract: 'running' }, counts: {} });
  const secondLog = path.join(second, 'events.jsonl');
  fs.writeFileSync(secondLog, JSON.stringify({ type: 'run_started', artifact_dir: second }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1400));
  fs.appendFileSync(secondLog, JSON.stringify({ type: 'stage', stage: 'extract', status: 'success' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.ok(
    seen.some((event) => event.type === 'stage' && event.stage === 'extract' && event.status === 'success'),
    'the watcher must attach to a run that started after the previous one ended'
  );
});

test('a live progress snapshot keeps the report\'s area_count', async (t) => {
  // readRunProgress knows only link counts. Replacing the report's map with it
  // dropped area_count, so the sources drawer read "估算 31 区域" for a run
  // whose frozen list was 26 — the estimate the operator checks by hand.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-area-count-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-055208');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), {
    run_status: 'success',
    stage_status: {},
    counts: { raw_links: 1 },
    source_counts: { xuanfeng: { raw_links: 213, area_count: 26 } }
  });
  const store = RunStore.open(path.join(artifactDir, 'run.db'));
  t.after(() => { store.close(); });
  store.initializeRun('success');
  store.recordExtractedNode('xuanfeng', 'vmess://' + Buffer.from(JSON.stringify({ ps: 'node', add: '203.0.113.9', port: '443', id: 'fixture-uuid', net: 'ws', path: '/' })).toString('base64'));

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot, AUTOVPN_SERVER_HISTORY_RETENTION_DAYS: '0' }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const state = await runtime.loadState();
  assert.equal(state.artifact.source_counts.xuanfeng.area_count, 26);
  // The database still wins on the numbers it owns.
  assert.equal(state.artifact.source_counts.xuanfeng.raw_links, 1);
});

test('a pipeline resume is live from its first event, before it writes a boundary', async (t) => {
  // `resume pipeline` re-runs the extract it found incomplete and only writes
  // `resume_pipeline_state` once speedtest results exist. Keying "is this log
  // live" off boundary events therefore read a working resume as finished for
  // its whole extract phase. The last line decides instead.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-resume-early-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-072000');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'failed', stage_status: { extract: 'failed' }, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, [
    { type: 'run_started', artifact_dir: artifactDir },
    { type: 'summary', run_status: 'failed', artifact_dir: artifactDir },
    // The resume's first events: extract is running, and there is no boundary
    // marker until much later in the run.
    { type: 'stage', stage: 'extract', status: 'running' }
  ].map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  const state = await runtime.loadState();
  assert.equal(state.runState, 'running', 'a log whose last line is not terminal is a live run');
  assert.equal(state.artifact.run_status, 'running', 'the replay must not hand the page the interrupted run\'s failure');

  fs.appendFileSync(log, JSON.stringify({ type: 'extract_iteration', source_name: 'leiting', iteration: 1 }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(seen.some((event) => event.type === 'extract_iteration'), 'the extract phase must be followed');
});

test('a summary and the resume that follows it never flash a terminal state', async (t) => {
  // Both lines can land in one 800ms poll. Publishing the summary's state on the
  // way through showed 失败 on a page that was already displaying the resume.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-summary-then-resume-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-073000');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: { extract: 'running' }, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n', 'utf8');

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  await runtime.loadState();

  fs.appendFileSync(log, [
    { type: 'summary', run_status: 'failed', artifact_dir: artifactDir },
    { type: 'resume_pipeline_state', artifact_dir: artifactDir, speedtest_links: 2 },
    { type: 'stage', stage: 'availability', status: 'running' }
  ].map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(
    seen.some((event) => event.type === 'server_state' && event.run_state === 'failed'),
    false,
    'the summary is history by the time the chunk is flushed'
  );
  assert.equal(
    seen.filter((event) => event.type === 'server_state').at(-1)?.run_state,
    'running'
  );
});

test('a managed job does not leave the scheduled-run watcher dead', async (t) => {
  // followJob leaves `unsubscribeLogs` and `activeJobId` set when its stream
  // ends. The watcher returned on those guards, so after one manual run the
  // next scheduled run was never noticed until the server restarted.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-watch-after-job-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  writeJobFixture(runtimeRoot, 'finished-job', {
    project_root: projectRoot,
    status: 'success',
    pid: 0,
    finished_at: '2026-11-12T00:00:00+00:00'
  });
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-074500');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: { extract: 'running' }, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');

  let started;
  const startedSignal = new Promise((resolve) => { started = resolve; });
  const runtime = createServerRuntime({
    projectRoot,
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    runWatchIntervalMs: 1000,
    followLog: async function* (_root, jobId) {
      started();
      yield JSON.stringify({ type: 'summary', run_status: 'success' }) + '\n';
    }
  });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  await runtime.startRun?.({});
  await startedSignal;
  // The job follower runs to its summary and leaves its guards set; the next
  // scheduled run appears afterwards.
  await new Promise((resolve) => setTimeout(resolve, 600));
  fs.writeFileSync(log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 2400));
  fs.appendFileSync(log, JSON.stringify({ type: 'stage', stage: 'extract', status: 'success' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.ok(
    seen.some((event) => event.type === 'stage' && event.stage === 'extract' && event.status === 'success'),
    'the scheduled run that started after the job ended must be followed'
  );
});

test('stopping a scheduled run leaves the page idle and does not re-adopt it', async (t) => {
  // The cron process keeps writing after the operator ends the run, so its log
  // still looks active. Without a record of what was stopped, the new watcher
  // picked the same run straight back up.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-stop-cron-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-075500');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: { extract: 'running' }, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n', 'utf8');

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {}, runWatchIntervalMs: 1000 });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  await runtime.loadState();

  const stopped = await runtime.stopRun?.();
  assert.equal(stopped.run_state, 'idle');
  // The attach itself published `running` during loadState; only what happens
  // after the stop counts here.
  const runningBefore = seen.filter((event) => event.type === 'server_state' && event.run_state === 'running').length;
  const stageBefore = seen.filter((event) => event.type === 'stage').length;
  fs.appendFileSync(log, JSON.stringify({ type: 'stage', stage: 'extract', status: 'success' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 2400));
  assert.equal(
    seen.filter((event) => event.type === 'server_state' && event.run_state === 'running').length,
    runningBefore,
    'the stopped run is not picked back up'
  );
  assert.equal(seen.filter((event) => event.type === 'stage').length, stageBefore, 'its later events are not followed');
});

test('the follower does not re-arm after close', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-close-watch-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-080500');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: {}, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n', 'utf8');
  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {}, runWatchIntervalMs: 1000 });
  await runtime.loadState();
  await runtime.close?.();
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  fs.appendFileSync(log, JSON.stringify({ type: 'stage', stage: 'deploy', status: 'success' }) + '\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(seen.length, 0, 'nothing polls after close');
});

test('the follow offset counts bytes, not characters', async (t) => {
  // The log carries Chinese vendor messages. Character offsets would land
  // mid-line and the next event would be lost or garbled.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-byte-offset-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  const artifactDir = path.join(runtimeRoot, 'artifacts', '20261112-081500');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'running', stage_status: {}, counts: {} });
  const log = path.join(artifactDir, 'events.jsonl');
  fs.writeFileSync(log, [
    { type: 'run_started', artifact_dir: artifactDir },
    { type: 'log', message: '登录失败，账号或者密码错误' },
    { type: 'summary', run_status: 'failed', artifact_dir: artifactDir },
    // The pipeline resume's extract phase, before it writes its own boundary.
    { type: 'stage', stage: 'extract', status: 'running' }
  ].map((event) => JSON.stringify(event)).join('\r\n') + '\r\n', 'utf8');

  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  const seen = [];
  runtime.subscribe((event) => seen.push(event));
  const state = await runtime.loadState();
  assert.equal(state.runState, 'running');

  fs.appendFileSync(log, JSON.stringify({ type: 'stage', stage: 'render', status: 'success' }) + '\r\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(seen.some((event) => event.type === 'stage' && event.stage === 'render'));
  assert.equal(seen.filter((event) => event.type === 'log').length, 0, 'no line may be garbled into a log entry');
});

test('the membership sweep guard resets after the sweep settles', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-server-expiry-guard-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(projectRoot, 'state');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const runtime = createServerRuntime({ projectRoot, env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }, followLog: async function* () {} });
  t.after(async () => { await runtime.close?.(); });
  // An empty pool makes the real worker return at once. What matters here is
  // that a completed sweep does not leave the guard latched: a second call must
  // not be refused as in-progress.
  const first = await runtime.refreshAccountExpiry({ brand: 'leiting', limit: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.checked, 0);
  const second = await runtime.refreshAccountExpiry({ brand: 'leiting', limit: 1 });
  assert.equal(second.ok, true);
});

test('loading the pool from serve erases retired rows past the retention window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-serve-pool-retention-'));
  const dbPath = path.join(root, 'accounts.db');
  const seed = new AccountStore({ dbPath, now: () => new Date('2026-06-01T00:00:00Z') });
  seed.importRecords([
    { brand: 'leiting', account: 'lapsed', password: 'p', official_site: 'https://www.68123836.com', expires_at: '2026-05-01', status: 'active', note: '' },
    { brand: 'leiting', account: 'live', password: 'p', official_site: 'https://www.68123836.com', expires_at: '2030-01-01', status: 'active', note: '' }
  ]);
  seed.close();

  // The first read (the one that opens the page) retires the lapse; the row it
  // just retired starts its own window then, so nothing is erased yet.
  const early = createServerRuntime({
    projectRoot: root,
    env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath, VPN_AUTOMATION_RUNTIME_ROOT: root },
    now: () => new Date('2026-06-02T00:00:00Z'),
    followLog: async function* () {}
  });
  try {
    const snapshot = await early.loadAccounts();
    assert.equal(snapshot.stats.total, 2, 'a lapse retired today is not purged today');
    assert.equal(snapshot.stats.expired, 1);
  } finally {
    await early.close?.();
  }

  // A month later the next page load clears it, with no cron and no timer.
  const later = createServerRuntime({
    projectRoot: root,
    env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath, VPN_AUTOMATION_RUNTIME_ROOT: root },
    now: () => new Date('2026-08-02T00:00:00Z'),
    followLog: async function* () {}
  });
  try {
    const snapshot = await later.loadAccounts();
    assert.equal(snapshot.stats.total, 1, 'the retired row is gone');
    assert.equal(snapshot.stats.expired, 0);
    assert.equal(snapshot.accounts.length, 1);
    assert.equal(snapshot.accounts[0].status, 'active');
  } finally {
    await later.close?.();
  }
});
