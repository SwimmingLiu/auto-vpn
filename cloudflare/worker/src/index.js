/**
 * AutoVPN on Cloudflare — control plane.
 *
 * One Worker, one Durable Object class. The DO owns a container instance, keys
 * every run through it, and holds the run index in SQLite so a restart never
 * loses "what happened last night". The Worker itself is stateless routing and
 * auth, because a Cloudflare Container is only reachable from the DO that owns
 * it.
 *
 * Scheduling is a Cron Trigger; orchestration is the DO alarm. A run outlives
 * any single request, and `monitor()` is capped at 15 minutes (see
 * docs/cloudflare-migration-feasibility.md §5.2), so the alarm re-arms itself
 * every observation window until the run reaches a terminal state.
 */

import { DurableObject } from 'cloudflare:workers';

const CONTAINER_PORT = 8080;
/** Platform maximum for an idle instance. */
const INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** One alarm observation window; `monitor()` resolves or rejects inside this. */
const OBSERVE_MS = 14 * 60 * 1000;
const READY_TIMEOUT_MS = 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  min_final_nodes: 50,
  source_runtime_seconds: 900,
  probe_url: 'https://www.16863988.com/'
};
/** A run moves through these phases; `step()` is driven entirely by this. */
const PHASES = ['measuring', 'gating', 'deploying', 'verifying', 'done'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function constantTimeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export class PipelineController extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.schema();
    // A DO restart drops the in-memory timeout while the container keeps
    // running; re-arm it or the instance dies at the platform's default.
    this.ctx.blockConcurrencyWhile(async () => {
      if (this.ctx.container?.running) {
        await this.ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      }
    });
  }

  schema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'measuring',
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT '',
        final_links INTEGER NOT NULL DEFAULT 0,
        artifact_dir TEXT NOT NULL DEFAULT '',
        measure_offset INTEGER NOT NULL DEFAULT 0,
        deploy_run_id TEXT NOT NULL DEFAULT '',
        deploy_offset INTEGER NOT NULL DEFAULT 0,
        deploy_status TEXT NOT NULL DEFAULT 'pending',
        error TEXT NOT NULL DEFAULT '',
        egress_mode TEXT NOT NULL DEFAULT '',
        egress_nodes INTEGER NOT NULL DEFAULT 0,
        alarm_failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  settings() {
    const rows = this.sql.exec('SELECT key, value FROM settings').toArray();
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  putSettings(patch) {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      this.sql.exec(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        JSON.stringify(value)
      );
    }
    return this.settings();
  }

  recordEvent(runId, type, payload) {
    this.sql.exec('INSERT INTO events (run_id, type, payload) VALUES (?, ?, ?)', runId, type, JSON.stringify(payload));
    // The DO is the long-lived log; keep it bounded so a busy month cannot push
    // the object toward its 10 GB ceiling.
    this.sql.exec('DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - 200000');
  }

  runRow(runId) {
    return this.sql.exec('SELECT * FROM runs WHERE run_id = ?', runId).toArray()[0] ?? null;
  }

  latestRun() {
    return this.sql.exec('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').toArray()[0] ?? null;
  }

  /** Start the container if needed and wait until it answers /health. */
  async ensureContainer() {
    const container = this.ctx.container;
    if (!container) throw new Error('no container binding on this Durable Object');
    if (!container.running) {
      container.start({
        image: container.images?.autovpn,
        enableInternet: true,
        instance: 'standard-1',
        env: {
          VPN_AUTOMATION_RUNTIME_ROOT: '/data/auto-vpn',
          AUTOVPN_PROJECT_ROOT: '/opt/autovpn',
          EGRESS_DIR: '/data/egress',
          EGRESS_MAX_CANDIDATES: '40',
          // The deploy stage reads this through `resolveCloudflareCredentials`'
          // env fallback, so the profile itself stays credential-free.
          ...(this.env.CLOUDFLARE_API_TOKEN ? { AUTOVPN_CF_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN } : {}),
          ...(this.env.SUBSCRIPTION_URL ? { SUBSCRIPTION_URL: this.env.SUBSCRIPTION_URL } : {})
        }
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    const port = container.getTcpPort(CONTAINER_PORT);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const response = await port.fetch('http://container/health', {
          signal: AbortSignal.timeout(2000)
        });
        await response.body?.cancel();
        if (response.ok) return port;
      } catch {
        // not listening yet
      }
      await scheduler.wait(500);
    }
    throw new Error('container did not become ready in time');
  }

  async containerFetch(pathname, init = {}) {
    const port = await this.ensureContainer();
    return port.fetch(`http://container${pathname}`, init);
  }

  async containerJson(pathname, init = {}) {
    const response = await this.containerFetch(pathname, init);
    if (!response.ok) throw new Error(`${pathname} -> ${response.status}`);
    return response.json();
  }

  /** Rebuild the crawl egress from the published subscription. */
  async refreshEgress(settings = this.settings()) {
    try {
      return await this.containerJson('/egress/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscriptionUrl: this.env.SUBSCRIPTION_URL, probeUrl: settings.probe_url })
      });
    } catch (error) {
      return { mode: 'unknown', nodes_healthy: 0, last_error: `egress refresh failed: ${error.message}` };
    }
  }

  /** Read a run's log since `offset` and store what it found. */
  async drain(runId, offset) {
    const payload = await this.containerJson(`/events?after=${offset}&run_id=${encodeURIComponent(runId)}`);
    for (const event of payload.events ?? []) {
      this.recordEvent(runId, String(event.type ?? 'event'), event);
    }
    return payload;
  }

  async containerStatus() {
    try {
      return await this.containerJson('/status');
    } catch {
      return null;
    }
  }

  async startDailyRun({ runId, trigger = 'api' } = {}) {
    const settings = this.settings();
    if (!settings.enabled) return { skipped: true, reason: 'disabled in settings' };

    const active = this.sql.exec(
      "SELECT run_id FROM runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1"
    ).toArray()[0];
    if (active) return { skipped: true, reason: `run ${active.run_id} still running` };

    const id = String(runId || new Date().toISOString().replace(/[:.]/g, '-'));
    this.sql.exec(
      `INSERT INTO runs (run_id, status, phase, started_at) VALUES (?, 'running', 'measuring', ?)
       ON CONFLICT(run_id) DO NOTHING`,
      id,
      new Date().toISOString()
    );
    this.recordEvent(id, 'run_requested', { run_id: id, trigger });

    await this.ensureContainer();

    // The container builds the egress pool itself as the first step of the run,
    // so the pool it uses is the pool that run recorded. The DO only hands over
    // where the subscription lives.
    const started = await this.containerJson('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: id,
        mode: 'run',
        skipDeploy: true,
        skipVerify: true,
        subscriptionUrl: this.env.SUBSCRIPTION_URL,
        probeUrl: settings.probe_url,
        // Delivered on every start: an operator edits one Worker secret and the
        // next run uses it, with no image rebuild and no volume edit.
        profileToml: this.env.AUTOVPN_PROFILE_TOML,
        cloudflareApiToken: this.env.CLOUDFLARE_API_TOKEN
      })
    });
    if (!started.started) {
      this.recordEvent(id, 'run_rejected', started);
      this.sql.exec(
        'UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE run_id = ?',
        'failed',
        String(started.reason ?? ''),
        new Date().toISOString(),
        id
      );
      return { runId: id, ...started };
    }
    const egress = started.state?.egress ?? {};
    this.recordEvent(id, 'egress_ready', egress);
    this.sql.exec(
      'UPDATE runs SET egress_mode = ?, egress_nodes = ? WHERE run_id = ?',
      String(egress.mode ?? ''),
      Number(egress.nodes_healthy ?? 0),
      id
    );

    await this.ctx.storage.setAlarm(Date.now() + OBSERVE_MS);
    return { runId: id, started: true, egress };
  }

  /**
   * Advance a run one step.
   *
   * `measuring` -> `gating` -> `deploying` -> `verifying` -> `done`. Each
   * transition is recorded before the action, so a DO restart mid-step repeats
   * the action rather than skipping it — every action here is idempotent.
   */
  async step(runId) {
    const row = this.runRow(runId);
    if (!row) return { done: true, reason: 'unknown run' };
    if (row.status !== 'running') return { done: true, status: row.status };

    const settings = this.settings();
    const status = await this.containerStatus();
    if (!status) {
      this.finish(runId, 'failed', 'container unreachable');
      return { done: true, status: 'failed' };
    }

    if (row.phase === 'measuring') {
      const drained = await this.drain(runId, row.measure_offset);
      this.sql.exec('UPDATE runs SET measure_offset = ? WHERE run_id = ?', drained.next, runId);

      if (status.phase === 'orphaned') {
        this.finish(runId, 'failed', 'container restarted mid-run');
        return { done: true, status: 'failed' };
      }
      if (status.phase === 'running') {
        await this.ctx.storage.setAlarm(Date.now() + OBSERVE_MS);
        return { done: false, phase: 'measuring' };
      }
      if (status.phase === 'failed') {
        this.finish(runId, 'failed', String(status.error ?? 'measurement failed'));
        return { done: true, status: 'failed' };
      }

      const summary = this.latestEvent(runId, 'summary');
      if (!summary) {
        this.finish(runId, 'failed', 'measurement produced no summary event');
        return { done: true, status: 'failed' };
      }
      if (summary.run_status && summary.run_status !== 'success') {
        this.finish(runId, 'failed', `measurement run_status=${summary.run_status}`);
        return { done: true, status: 'failed' };
      }
      const finalLinks = Number(summary.counts?.final_links ?? 0);
      const artifactDir = String(summary.artifact_dir ?? '');
      if (!artifactDir) {
        this.finish(runId, 'failed', 'measurement produced no artifact_dir');
        return { done: true, status: 'failed' };
      }

      this.sql.exec(
        'UPDATE runs SET phase = ?, final_links = ?, artifact_dir = ? WHERE run_id = ?',
        'gating',
        finalLinks,
        artifactDir,
        runId
      );
      this.recordEvent(runId, 'measurement_done', { final_links: finalLinks, artifact_dir: artifactDir });
      // Fall through to the gate in the same step so a short run does not wait
      // an extra fourteen minutes for nothing.
      return this.step(runId);
    }

    if (row.phase === 'gating') {
      // Mirrors `daily-run.sh`: publish only when the node count clears the
      // threshold, so a thin sweep never replaces a working subscription.
      if (row.final_links <= settings.min_final_nodes) {
        this.recordEvent(runId, 'deploy_held', {
          final_links: row.final_links,
          min_final_nodes: settings.min_final_nodes
        });
        this.finish(runId, 'held', '');
        return { done: true, status: 'held', final_links: row.final_links };
      }
      const deployRunId = `${runId}-deploy`;
      const started = await this.containerJson('/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: deployRunId,
          mode: 'deploy',
          artifactDir: row.artifact_dir,
          profileToml: this.env.AUTOVPN_PROFILE_TOML,
          cloudflareApiToken: this.env.CLOUDFLARE_API_TOKEN
        })
      });
      if (!started.started) {
        // The previous step's deploy is still winding down; wait it out.
        await this.ctx.storage.setAlarm(Date.now() + 60000);
        return { done: false, phase: 'gating', detail: started.reason };
      }
      this.sql.exec(
        'UPDATE runs SET phase = ?, deploy_run_id = ?, deploy_status = ? WHERE run_id = ?',
        'deploying',
        deployRunId,
        'running',
        runId
      );
      await this.ctx.storage.setAlarm(Date.now() + OBSERVE_MS);
      return { done: false, phase: 'deploying' };
    }

    if (row.phase === 'deploying') {
      // The deploy run has its own id and its own log, so its summary never
      // overwrites the measurement's.
      const drained = await this.drain(row.deploy_run_id, row.deploy_offset);
      this.sql.exec('UPDATE runs SET deploy_offset = ? WHERE run_id = ?', drained.next, runId);

      if (status.phase === 'running' && status.runId === row.deploy_run_id) {
        await this.ctx.storage.setAlarm(Date.now() + OBSERVE_MS);
        return { done: false, phase: 'deploying' };
      }
      const summary = this.latestEvent(row.deploy_run_id, 'summary');
      const ok = String(summary?.run_status ?? '') === 'success';
      this.sql.exec(
        'UPDATE runs SET phase = ?, deploy_status = ? WHERE run_id = ?',
        'verifying',
        ok ? 'succeeded' : 'failed',
        runId
      );
      if (!ok) {
        this.recordEvent(runId, 'deploy_failed', { summary: summary ?? null });
        this.finish(runId, 'failed', 'deploy stage failed');
        return { done: true, status: 'failed' };
      }
      return this.step(runId);
    }

    if (row.phase === 'verifying') {
      // `retry-stage --stage deploy` already runs the deploy *and* the verify
      // stage against the freshly published bundle, so a successful deploy
      // summary means the subscription served the payload this run built.
      this.finish(runId, 'succeeded', '');
      return { done: true, status: 'succeeded' };
    }

    this.finish(runId, 'failed', `unknown phase ${row.phase}`);
    return { done: true, status: 'failed' };
  }

  latestEvent(runId, type) {
    const row = this.sql.exec(
      'SELECT payload FROM events WHERE run_id = ? AND type = ? ORDER BY seq DESC LIMIT 1',
      runId,
      type
    ).toArray()[0];
    return row ? JSON.parse(row.payload) : null;
  }

  finish(runId, status, error) {
    this.sql.exec(
      'UPDATE runs SET status = ?, phase = ?, error = ?, finished_at = ? WHERE run_id = ?',
      status,
      'done',
      String(error ?? ''),
      new Date().toISOString(),
      runId
    );
    this.recordEvent(runId, 'run_finished', { status, error: String(error ?? '') });
  }

  async alarm() {
    const run = this.sql.exec(
      "SELECT run_id FROM runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1"
    ).toArray()[0];
    if (!run) return;
    let result;
    try {
      result = await this.step(run.run_id);
    } catch (error) {
      // A transient container/network failure must not kill a run whose data is
      // still on disk; retry inside the window, and only give up after a day.
      const row = this.runRow(run.run_id);
      const attempts = Number(row?.alarm_failures ?? 0) + 1;
      this.sql.exec('UPDATE runs SET alarm_failures = ? WHERE run_id = ?', attempts, run.run_id);
      this.recordEvent(run.run_id, 'alarm_error', { message: error.message, attempt: attempts });
      if (attempts >= 8) {
        this.finish(run.run_id, 'failed', `repeated alarm failures: ${error.message}`);
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + OBSERVE_MS);
      return;
    }
    if (!result.done) {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null) await this.ctx.storage.setAlarm(Date.now() + OBSERVE_MS);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/do/settings') {
      if (request.method === 'GET') return json(this.settings());
      return json(this.putSettings(await request.json().catch(() => ({}))));
    }
    if (path === '/do/run' && request.method === 'POST') {
      return json(await this.startDailyRun(await request.json().catch(() => ({}))));
    }
    if (path === '/do/runs') {
      return json({
        runs: this.sql.exec('SELECT * FROM runs ORDER BY started_at DESC LIMIT 50').toArray()
      });
    }
    if (path === '/do/runs/latest') {
      return json({ run: this.latestRun() });
    }
    if (path === '/do/status') {
      return json({ run: this.latestRun(), settings: this.settings(), container: await this.containerStatus() });
    }
    if (path === '/do/events') {
      const runId = url.searchParams.get('run_id') ?? '';
      const after = Number(url.searchParams.get('after') ?? '0');
      const rows = this.sql.exec(
        'SELECT seq, type, payload FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500',
        runId,
        Number.isFinite(after) ? after : 0
      ).toArray();
      return json({ events: rows.map((row) => ({ seq: row.seq, type: row.type, ...JSON.parse(row.payload) })) });
    }
    if (path === '/do/step' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return json(await this.step(String(body.runId ?? '')));
    }
    if (path === '/do/stop' && request.method === 'POST') {
      return json(await this.containerJson('/stop', { method: 'POST' }).catch((error) => ({ error: error.message })));
    }
    if (path === '/do/import-accounts' && request.method === 'POST') {
      return json(await this.containerJson('/import-accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await request.json())
      }));
    }
    if (path === '/do/egress/refresh' && request.method === 'POST') {
      return json(await this.refreshEgress());
    }
    return json({ error: 'not found', path }, 404);
  }
}

function authorized(request, env) {
  const expected = String(env.AUTOVPN_API_TOKEN ?? '');
  if (!expected) return false;
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  return constantTimeEqual(presented, expected);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Auth before anything else, including the liveness probe: an unauthenticated
    // caller should not be able to tell a misconfigured deployment (no token set,
    // so every request is denied) from a healthy one.
    if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/health') return json({ ok: true });

    const stub = env.PIPELINE.get(env.PIPELINE.idFromName('daily'));
    const routes = [
      ['/api/settings', '/do/settings'],
      ['/api/run', '/do/run'],
      ['/api/runs/latest', '/do/runs/latest'],
      ['/api/runs', '/do/runs'],
      ['/api/events', '/do/events'],
      ['/api/step', '/do/step'],
      ['/api/status', '/do/status'],
      ['/api/stop', '/do/stop'],
      ['/api/accounts/import', '/do/import-accounts'],
      ['/api/egress/refresh', '/do/egress/refresh']
    ];
    for (const [prefix, target] of routes) {
      if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
        const forwarded = new URL(request.url);
        forwarded.pathname = target + url.pathname.slice(prefix.length);
        return stub.fetch(new Request(forwarded, request));
      }
    }
    return json({ error: 'not found' }, 404);
  },

  /**
   * Cron only *emits*. A Cron Trigger has a 15-minute wall clock and a run can
   * take an hour, so the DO alarm carries the run once it starts.
   */
  async scheduled(event, env, ctx) {
    const stub = env.PIPELINE.get(env.PIPELINE.idFromName('daily'));
    ctx.waitUntil(stub.fetch('http://do/do/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trigger: 'cron',
        runId: `cron-${new Date(event.scheduledTime).toISOString().replace(/[:.]/g, '-')}`
      })
    }));
  }
};
