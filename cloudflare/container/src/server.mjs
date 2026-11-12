#!/usr/bin/env node
/**
 * Container entrypoint.
 *
 * A Cloudflare Container is a full Linux VM, so the CLI runs here unmodified:
 * mihomo spawns, `node:sqlite` works, `mkdtemp` works, and wrangler deploys a
 * Pages bundle exactly as it does on the VPS. This process is only the thin
 * HTTP skin around that CLI — it starts a run, streams its JSONL back, and
 * reports status. Every stage stays the code that already works.
 *
 * Routes:
 *   GET  /health          readiness for the Durable Object's start loop
 *   GET  /status          current run + egress state
 *   POST /run             start a pipeline run (idempotent per run id)
 *   POST /stop            stop the current run
 *   GET  /events?after=N  JSONL events produced since byte offset N
 *   GET  /egress          current crawl egress
 *   POST /egress/refresh  rebuild the egress from the subscription
 *   POST /import-accounts import a CSV into the pool
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { EgressSupervisor, DEFAULT_PROBE_HOST } from './egress.mjs';

const PORT = Number(process.env.PORT || 8080);
const RUNTIME_ROOT = process.env.VPN_AUTOMATION_RUNTIME_ROOT || '/data/auto-vpn';
const PROJECT_ROOT = process.env.AUTOVPN_PROJECT_ROOT || '/opt/autovpn';
const CLI_ENTRY = process.env.AUTOVPN_CLI_ENTRY || '/usr/local/lib/node_modules/@swimmingliu/autovpn/bin/autovpn.mjs';
const NODE_BIN = process.env.AUTOVPN_NODE_BIN || process.execPath;
const RUN_LOG_DIR = path.join(RUNTIME_ROOT, 'container-runs');

/**
 * A Cloudflare Container scales to zero and restarts without warning, so the
 * run record has to survive the process. It is rewritten on every transition;
 * the Durable Object treats a `running` record it did not start as orphaned.
 */
const state = {
  runId: '',
  mode: 'run',
  phase: 'idle',
  pid: 0,
  startedAt: '',
  finishedAt: '',
  exitCode: null,
  artifactDir: '',
  error: '',
  logPath: '',
  stage: '',
  egress: {}
};

let child = null;
const egress = new EgressSupervisor();

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

async function persistState() {
  await mkdir(RUN_LOG_DIR, { recursive: true });
  await writeFile(path.join(RUNTIME_ROOT, 'container-state.json'), JSON.stringify(state, null, 2), 'utf8');
}

async function readJsonBody(request, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!total) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The profile lives on the mounted volume, not in the image. */
async function profilePath() {
  return process.env.VPN_AUTOMATION_PROFILE_PATH || path.join(RUNTIME_ROOT, 'profile.toml');
}

/**
 * Install the operator's profile.
 *
 * The profile carries the Cloudflare deploy token and the vendor account
 * passwords, so it is delivered as a Worker secret on every boot rather than
 * baked into the image or left on a volume a rollback could resurrect.
 *
 * `AUTOVPN_PROFILE_TOML` is authoritative: when it is set, it is written even
 * if the bytes match, because "the file on disk already looks the same" is how
 * a hand-edited volume silently keeps an operator's fix from landing. The
 * no-op path exists only when the secret is absent.
 */
async function installProfile(toml) {
  const text = String(toml ?? '');
  if (!text.trim()) return { written: false, reason: 'nosupply' };
  const target = path.join(RUNTIME_ROOT, 'profile.toml');
  await mkdir(RUNTIME_ROOT, { recursive: true });
  let previous = '';
  try {
    previous = await readFile(target, 'utf8');
  } catch {
    previous = '';
  }
  await writeFile(target, text, { encoding: 'utf8', mode: 0o600 });
  return { written: previous !== text, reason: previous === text ? 'unchanged' : 'updated' };
}

/**
 * Environment for a CLI child process.
 *
 * The deploy token arrives as its own Worker secret rather than inside the
 * profile: `resolveCloudflareCredentials()` falls back to `CLOUDFLARE_API_TOKEN`
 * when `[deploy].cloudflare_api_token` is empty, so the profile can stay
 * credential-free and be committed.
 */
function childEnv(extra = {}) {
  // A per-request token beats the process env: `container.start()` only runs
  // once per instance, so an operator rotating a Worker secret must reach the
  // next run without waiting for the platform to recycle the container.
  const secretToken = String(extra.AUTOVPN_CF_API_TOKEN ?? process.env.AUTOVPN_CF_API_TOKEN ?? '');
  return {
    ...process.env,
    VPN_AUTOMATION_RUNTIME_ROOT: RUNTIME_ROOT,
    VPN_AUTOMATION_PROFILE_PATH: path.join(RUNTIME_ROOT, 'profile.toml'),
    // Egress is the supervisor's business. The CLI's own default already
    // points at 127.0.0.1:7897, but pinning it here keeps a stray HTTPS_PROXY
    // in the container env from silently rerouting the crawl around the pool.
    VPN_AUTOMATION_PROXY_MODE: 'proxy',
    VPN_AUTOMATION_UPSTREAM_PROXY: 'http://127.0.0.1:7897',
    HOME: RUNTIME_ROOT,
    npm_config_cache: path.join(RUNTIME_ROOT, 'npm-cache'),
    ...(secretToken ? { CLOUDFLARE_API_TOKEN: secretToken } : {}),
    // Deploy defaults. The Durable Object passes these per run; the container
    // falls back to its own env so a bare `docker run` is still exercisable.
    SUBSCRIPTION_URL: process.env.SUBSCRIPTION_URL || '',
    EGRESS_PROBE_URL: process.env.EGRESS_PROBE_URL || DEFAULT_PROBE_HOST,
    ...extra
  };
}

function runArgs(mode, options) {
  const common = ['--project-root', PROJECT_ROOT, '--output', 'jsonl'];
  if (mode === 'run') {
    const args = ['run', ...common];
    if (options.skipDeploy !== false) args.push('--skip-deploy');
    if (options.skipVerify !== false) args.push('--skip-verify');
    return args;
  }
  if (mode === 'deploy') {
    return ['retry-stage', '--artifact-dir', String(options.artifactDir ?? ''), '--stage', 'deploy', ...common];
  }
  throw new Error(`unknown mode: ${mode}`);
}

/**
 * Build the egress before a measurement run.
 *
 * The crawl must not start on the Cloudflare egress range when a subscription
 * node can carry it, so this runs synchronously inside `/run` for `mode: 'run'`
 * and its outcome is part of the run's own record.
 */
async function prepareEgressForRun(options) {
  if (options.skipEgress === true) return { skipped: true };
  try {
    return await egress.prepare({
      subscriptionUrl: options.subscriptionUrl ?? process.env.SUBSCRIPTION_URL,
      subscriptionBody: options.subscriptionBody,
      probeUrl: options.probeUrl || DEFAULT_PROBE_HOST
    });
  } catch (error) {
    // A failed pool is not a failed run: degrade to direct and say so.
    return { mode: 'direct', nodes_total: 0, nodes_healthy: 0, last_error: `egress prepare failed: ${error.message}` };
  }
}

async function startRun(options) {
  if (child && state.phase === 'running') {
    return { started: false, reason: 'a run is already in progress', state };
  }
  const mode = String(options.mode ?? 'run');
  const args = runArgs(mode, options);

  // A run may only start with a profile in place; the deploy stage would
  // otherwise fail at the very end of an hour-long measurement.
  if (mode === 'deploy' || mode === 'run') {
    const installed = await installProfile(options.profileToml ?? process.env.AUTOVPN_PROFILE_TOML);
    if (installed.reason === 'nosupply') {
      const existing = await readFile(path.join(RUNTIME_ROOT, 'profile.toml'), 'utf8').catch(() => '');
      if (!existing.trim()) return { started: false, reason: 'no profile installed on the volume' };
    }
  }

  await mkdir(RUN_LOG_DIR, { recursive: true });

  const runId = String(options.runId ?? `run-${Date.now()}`);
  const logPath = path.join(RUN_LOG_DIR, `${runId}.jsonl`);
  // A retried run must not read the previous attempt's events as its own.
  await writeFile(logPath, '', 'utf8');

  // The pool is rebuilt per measurement run, never for a deploy retry: the
  // deploy stage talks to the Cloudflare API, which wants a stable address, and
  // routing it through a rotating vendor node would be strictly worse.
  const egressState = mode === 'run' ? await prepareEgressForRun(options) : { skipped: true };

  Object.assign(state, {
    runId,
    mode,
    phase: 'running',
    pid: 0,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    exitCode: null,
    artifactDir: String(options.artifactDir ?? ''),
    error: '',
    logPath,
    stage: '',
    egress: egressState
  });

  const stdoutStream = await import('node:fs').then((fs) => fs.createWriteStream(logPath, { flags: 'a' }));
  const proc = spawn(NODE_BIN, [CLI_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    env: childEnv({ AUTOVPN_CF_API_TOKEN: options.cloudflareApiToken }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child = proc;
  state.pid = proc.pid ?? 0;
  await persistState();

  const write = (chunk) => {
    stdoutStream.write(chunk);
  };
  proc.stdout?.on('data', write);
  proc.stderr?.on('data', (chunk) => {
    // The CLI writes human progress to stderr even in jsonl mode; keep it in
    // the same log so a failed run has one file to read.
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      stdoutStream.write(`${JSON.stringify({ type: 'stderr', line })}\n`);
    }
  });

  proc.on('error', async (error) => {
    state.error = error.message;
  });

  proc.on('close', async (code) => {
    stdoutStream.end();
    Object.assign(state, {
      phase: code === 0 ? 'succeeded' : 'failed',
      exitCode: code,
      finishedAt: new Date().toISOString(),
      error: state.error || (code === 0 ? '' : `cli exited with ${code}`)
    });
    child = null;
    await persistState();
  });

  return { started: true, runId, state };
}

async function stopRun() {
  if (!child || state.phase !== 'running') return { stopped: false, state };
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && child && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (child && child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  return { stopped: true, state };
}

/** Serve a run's log from a byte offset so a reconnecting DO never re-reads it. */
async function serveEvents(response, runId, offset) {
  const logPath = path.join(RUN_LOG_DIR, `${runId}.jsonl`);
  let size = 0;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return json(response, 200, { events: [], next: 0, size: 0, run_id: runId, phase: 'unknown' });
  }
  const start = Math.max(0, Math.min(offset, size));
  if (start === size) {
    return json(response, 200, { events: [], next: size, size, run_id: runId, phase: state.runId === runId ? state.phase : 'unknown' });
  }
  const events = [];
  const stream = createReadStream(logPath, { start, end: size - 1 });
  let buffer = '';
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          try {
            events.push(JSON.parse(line));
          } catch {
            events.push({ type: 'raw', line });
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  // `next` is the offset of the first *unread* byte; a trailing partial line is
  // left for the next poll so a JSON object is never split in half.
  const consumed = size - start - Buffer.byteLength(buffer, 'utf8');
  return json(response, 200, {
    events,
    next: start + consumed,
    size,
    run_id: runId,
    phase: state.runId === runId ? state.phase : 'idle'
  });
}

async function importAccounts(body) {
  const csv = String(body.csv ?? '');
  if (!csv.trim()) throw new Error('csv is required');
  await mkdir(RUNTIME_ROOT, { recursive: true });
  const target = path.join(RUNTIME_ROOT, `accounts-import-${Date.now()}.csv`);
  await writeFile(target, csv, { encoding: 'utf8', mode: 0o600 });
  const proc = spawn(NODE_BIN, [
    CLI_ENTRY, 'accounts', 'import', target,
    '--project-root', PROJECT_ROOT,
    '--format', String(body.format ?? 'auto'),
    '--output', 'jsonl'
  ], { cwd: PROJECT_ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise((resolve) => proc.on('close', resolve));
  const last = stdout.trim().split('\n').pop() ?? '';
  let parsed = {};
  try {
    parsed = JSON.parse(last);
  } catch {
    parsed = { ok: code === 0, raw: last.slice(0, 2000) };
  }
  return { exitCode: code, ...parsed, stderr: stderr.slice(-2000) };
}

async function route(request, response) {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    return json(response, 200, { ok: true, phase: state.phase, run_id: state.runId });
  }

  if (request.method === 'GET' && url.pathname === '/status') {
    return json(response, 200, { ...state, egress: egress.status() });
  }

  if (request.method === 'GET' && url.pathname === '/egress') {
    return json(response, 200, egress.status());
  }

  if (request.method === 'POST' && url.pathname === '/egress/refresh') {
    const body = await readJsonBody(request);
    const result = await egress.prepare({
      subscriptionUrl: body.subscriptionUrl,
      subscriptionBody: body.subscriptionBody,
      probeUrl: body.probeUrl || DEFAULT_PROBE_HOST
    });
    return json(response, 200, result);
  }

  if (request.method === 'POST' && url.pathname === '/run') {
    const body = await readJsonBody(request);
    const result = await startRun(body);
    return json(response, result.started ? 202 : 409, result);
  }

  if (request.method === 'POST' && url.pathname === '/stop') {
    return json(response, 200, await stopRun());
  }

  if (request.method === 'GET' && url.pathname === '/events') {
    const offset = Number(url.searchParams.get('after') ?? '0');
    const runId = url.searchParams.get('run_id') ?? state.runId;
    return serveEvents(response, runId, Number.isFinite(offset) ? offset : 0);
  }

  if (request.method === 'POST' && url.pathname === '/import-accounts') {
    const body = await readJsonBody(request, 32 * 1024 * 1024);
    return json(response, 200, await importAccounts(body));
  }

  return json(response, 404, { error: 'not found', path: url.pathname });
}

/**
 * Recover from a container restart.
 *
 * The platform kills and relaunches instances; a run whose process is gone
 * cannot be resumed mid-stage by this process, so it is reported as orphaned
 * and the Durable Object decides whether to start a fresh one.
 */
async function recoverState() {
  try {
    const text = await readFile(path.join(RUNTIME_ROOT, 'container-state.json'), 'utf8');
    const saved = JSON.parse(text);
    if (saved.phase === 'running') {
      state.runId = saved.runId ?? '';
      state.logPath = saved.logPath ?? '';
      state.phase = 'orphaned';
      state.error = 'container restarted while a run was in progress';
      state.startedAt = saved.startedAt ?? '';
    } else if (saved.runId) {
      Object.assign(state, saved);
    }
  } catch {
    // First boot on a fresh volume.
  }
  await persistState();
}

await mkdir(RUNTIME_ROOT, { recursive: true });
await recoverState();

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`autovpn container listening on :${PORT}\n`);
});

for (const signalName of ['SIGTERM', 'SIGINT']) {
  process.on(signalName, async () => {
    await stopRun();
    await egress.stop();
    server.close(() => process.exit(0));
    // Termination window is 15 minutes; do not hold it open.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
