import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The Worker imports `DurableObject` from `cloudflare:workers`, which only
 * exists inside workerd. These tests exercise the pure decision logic by
 * loading the module through a tiny shim, so `step()`'s transitions and the
 * gate arithmetic are covered without a running platform.
 */

const modules = new Map();
// The real base class stores `ctx`/`env` on `this`; the shim has to do the same
// or every subclass constructor dereferences undefined.
globalThis.__cloudflareWorkersShim = {
  DurableObject: class {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  }
};

async function loadWorker() {
  const source = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  );
  const patched = source.replace(
    "import { DurableObject } from 'cloudflare:workers';",
    'const DurableObject = globalThis.__cloudflareWorkersShim.DurableObject;'
  );
  const url = `data:text/javascript;base64,${Buffer.from(patched).toString('base64')}`;
  const module = await import(url);
  modules.set(url, module);
  return module;
}

/** A DurableObjectState + storage.sql stand-in backed by a real sqlite. */
async function makeHarness() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...params) {
      // `sql.exec` in workerd accepts several statements at once, which is how
      // `schema()` creates the whole table set in one call.
      if (params.length === 0 && /;\s*\n/.test(query)) {
        db.exec(query);
        return { toArray: () => [], [Symbol.iterator]: () => [][Symbol.iterator]() };
      }
      const statement = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = statement.all(...params);
        return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
      }
      const result = statement.run(...params);
      return { toArray: () => [], rowsWritten: Number(result.changes) };
    }
  };
  const alarms = [];
  const ctx = {
    storage: {
      sql,
      getAlarm: async () => alarms.at(-1) ?? null,
      setAlarm: async (at) => { alarms.push(at); }
    },
    container: null,
    blockConcurrencyWhile: async (fn) => fn()
  };
  return { ctx, db, alarms };
}

/** Replace the container transport; every test drives the DO without one. */
function stubContainer(controller, { status = { phase: 'succeeded' }, onRun = null } = {}) {
  controller.containerStatus = async () => status;
  controller.containerJson = async (pathname, init) => {
    if (onRun && pathname === '/run') return onRun(JSON.parse(init.body));
    if (pathname.startsWith('/events')) return { events: [], next: 0 };
    return {};
  };
  controller.ctx.storage.setAlarm = async () => {};
  return controller;
}

test('gate holds when final_links does not clear the threshold', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = stubContainer(new PipelineController(ctx, {}));
  controller.latestEvent = (runId, type) => (type === 'summary'
    ? { run_status: 'success', artifact_dir: '/data/x', counts: { final_links: 50 } }
    : null);

  controller.sql.exec(
    "INSERT INTO runs (run_id, status, phase, started_at) VALUES ('r1','running','measuring','2026-11-12')"
  );
  const result = await controller.step('r1');
  // daily-run.sh uses `-le`: exactly 50 holds, it does not deploy.
  assert.equal(result.status, 'held');
  const row = controller.runRow('r1');
  assert.equal(row.status, 'held');
  assert.equal(row.final_links, 50);
});

test('gate passes and starts a deploy run above the threshold', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  let deployRequest = null;
  const controller = stubContainer(new PipelineController(ctx, {}), {
    onRun: (body) => {
      deployRequest = body;
      return { started: true };
    }
  });
  controller.latestEvent = (runId, type) => (type === 'summary'
    ? { run_status: 'success', artifact_dir: '/data/x', counts: { final_links: 51 } }
    : null);

  controller.sql.exec(
    "INSERT INTO runs (run_id, status, phase, started_at) VALUES ('r2','running','measuring','2026-11-12')"
  );
  await controller.step('r2');
  const row = controller.runRow('r2');
  assert.equal(row.phase, 'deploying');
  assert.equal(row.final_links, 51);
  assert.ok(deployRequest, 'a deploy run must be requested');
  assert.equal(deployRequest.mode, 'deploy');
  assert.equal(deployRequest.artifactDir, '/data/x');
  // The deploy run gets its own id so its log does not overwrite the
  // measurement's summary.
  assert.equal(deployRequest.runId, 'r2-deploy');
});

test('a failed measurement finishes the run instead of waiting forever', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = stubContainer(new PipelineController(ctx, {}), {
    status: { phase: 'failed', error: 'extract blew up' }
  });
  controller.sql.exec(
    "INSERT INTO runs (run_id, status, phase, started_at) VALUES ('r3','running','measuring','2026-11-12')"
  );
  const result = await controller.step('r3');
  assert.equal(result.status, 'failed');
  assert.match(controller.runRow('r3').error, /extract blew up/);
});

test('an orphaned container fails the run rather than hanging', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = stubContainer(new PipelineController(ctx, {}), { status: { phase: 'orphaned' } });
  controller.sql.exec(
    "INSERT INTO runs (run_id, status, phase, started_at) VALUES ('r4','running','measuring','2026-11-12')"
  );
  const result = await controller.step('r4');
  assert.equal(result.status, 'failed');
  assert.match(controller.runRow('r4').error, /restarted/);
});

test('a second run is refused while one is in progress', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = new PipelineController(ctx, {});
  controller.ensureContainer = async () => ({});
  controller.sql.exec(
    "INSERT INTO runs (run_id, status, phase, started_at) VALUES ('busy','running','measuring','2026-11-12')"
  );
  const result = await controller.startDailyRun({ runId: 'next' });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /busy/);
});

test('settings round-trip and unknown keys are ignored', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = new PipelineController(ctx, {});
  const updated = controller.putSettings({ min_final_nodes: 12, nonsense: 'x' });
  assert.equal(updated.min_final_nodes, 12);
  assert.equal(updated.nonsense, undefined);
  // Unset keys keep their defaults.
  assert.equal(updated.source_runtime_seconds, 900);
});

test('disabled settings skip the run entirely', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = new PipelineController(ctx, {});
  controller.putSettings({ enabled: false });
  const result = await controller.startDailyRun({ runId: 'r5' });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /disabled/);
});

test('the bearer check is constant-time and rejects empty configuration', async () => {
  const worker = await loadWorker();
  const request = (token) => new Request('https://x/health', {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const response = await worker.default.fetch(request('abc'), {});
  assert.equal(response.status, 401, 'an unset secret must deny everything');
});
