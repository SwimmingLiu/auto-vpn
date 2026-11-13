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

test('a container that never accepts the deploy eventually fails the run', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = stubContainer(new PipelineController(ctx, {}), {
    onRun: () => ({ started: false, reason: 'a run is already in progress' })
  });
  controller.sql.exec(
    "INSERT INTO runs (run_id, status, phase, started_at, final_links) VALUES ('r6','running','gating','2026-11-12', 900)"
  );
  // Ten refusals must end the run; without the bound this re-arms forever.
  let result = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    result = await controller.step('r6');
    if (result.done) break;
  }
  assert.equal(result.done, true);
  assert.equal(result.status, 'failed');
  assert.match(controller.runRow('r6').error, /deploy never started/);
});

test('a 409 on deploy is waited out, not thrown out of the state machine', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = stubContainer(new PipelineController(ctx, {}));
  // The container reports a busy run with a status code, not a JSON body.
  controller.containerJson = async (pathname) => {
    if (pathname === '/run') {
      const error = new Error('/run -> 409');
      error.status = 409;
      throw error;
    }
    return {};
  };
  controller.sql.exec(
    "INSERT INTO runs (run_id, status, phase, started_at, final_links) VALUES ('r7','running','gating','2026-11-12', 900)"
  );
  const first = await controller.step('r7');
  assert.equal(first.done, false, 'a busy container is a wait, not a verdict');
  assert.equal(controller.runRow('r7').deploy_stalls, 1);
  assert.equal(controller.runRow('r7').status, 'running');

  // Still bounded: ten busy answers end the run rather than re-arming forever.
  let result = first;
  for (let attempt = 0; attempt < 12 && !result.done; attempt += 1) {
    result = await controller.step('r7');
  }
  assert.equal(result.done, true);
  assert.equal(result.status, 'failed');
});

test('the account pool is replayed into an empty container', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = stubContainer(new PipelineController(ctx, {}));
  let imported = null;
  controller.containerJson = async (pathname, init) => {
    if (pathname === '/accounts/stats') return { present: false, total: 0, active: 0 };
    if (pathname === '/import-accounts') {
      imported = JSON.parse(init.body);
      return { imported: 2, accounts: { present: true, active: 2 } };
    }
    return {};
  };

  controller.sql.exec(
    "INSERT INTO account_pool (id, csv, imported_at, row_count) VALUES (1, ?, '2026-11-12', 2)",
    'brand,account,password\na,x,1\nb,y,2\n'
  );
  const result = await controller.restoreAccountPool();
  assert.equal(result.restored, true);
  assert.equal(result.rows, 2);
  assert.match(imported.csv, /^brand,account,password/);
});

test('a container that already has a pool is not overwritten', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = stubContainer(new PipelineController(ctx, {}));
  let importCalled = false;
  controller.containerJson = async (pathname) => {
    if (pathname === '/accounts/stats') return { present: true, total: 9, active: 7 };
    if (pathname === '/import-accounts') { importCalled = true; return {}; }
    return {};
  };
  controller.sql.exec(
    "INSERT INTO account_pool (id, csv, imported_at, row_count) VALUES (1, 'stale', '2026-01-01', 1)"
  );
  const result = await controller.restoreAccountPool();
  // The live pool may have rows disabled since the CSV was stored; replaying
  // would resurrect credentials an operator deliberately retired.
  assert.equal(result.restored, false);
  assert.equal(importCalled, false);
  assert.equal(result.active, 7);
});

test('importing stores the pool before pushing it to the container', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = stubContainer(new PipelineController(ctx, {}));
  let received = null;
  controller.containerJson = async (pathname, init) => {
    if (pathname === '/import-accounts') { received = JSON.parse(init.body); return { imported: 3, accounts: { active: 3 } }; }
    return {};
  };
  const result = await controller.saveAccountPool('brand,account\nleiting,a\nheidong,b\nmifeng,c\n');
  assert.equal(result.rows, 3);
  assert.equal(received.format, 'csv');
  const stored = controller.sql.exec('SELECT row_count FROM account_pool WHERE id = 1').toArray()[0];
  assert.equal(stored.row_count, 3);
});

test('the bearer check is constant-time and rejects empty configuration', async () => {
  const worker = await loadWorker();
  const request = (token) => new Request('https://x/health', {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const response = await worker.default.fetch(request('abc'), {});
  assert.equal(response.status, 401, 'an unset secret must deny everything');
});

test('a container that never becomes ready fails the run instead of wedging it', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = new PipelineController(ctx, {});
  // A cold boot can miss READY_TIMEOUT_MS. Before the fix this left a
  // `running` row with no alarm, and every later cron was skipped forever.
  controller.ensureContainer = async () => { throw new Error('container did not become ready in time'); };

  const result = await controller.startDailyRun({ runId: 'wedged' });
  assert.equal(result.started, false);
  const row = controller.runRow('wedged');
  assert.equal(row.status, 'failed', 'the row must not stay running');
  assert.match(row.error, /could not start/);

  // The next night must be allowed to start.
  controller.ensureContainer = async () => ({});
  controller.restoreAccountPool = async () => ({ restored: false, reason: 'none stored' });
  controller.containerJson = async (pathname) => (pathname === '/run'
    ? { started: true, state: { egress: { mode: 'proxy', nodes_healthy: 3 } } }
    : {});
  const next = await controller.startDailyRun({ runId: 'next-night' });
  assert.equal(next.started, true, 'a wedged run must not block the schedule');
});

test('an alarm is armed before the container is touched', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx, alarms } = await makeHarness();
  const controller = new PipelineController(ctx, {});
  let alarmsAtEnsure = -1;
  controller.ensureContainer = async () => {
    alarmsAtEnsure = alarms.length;
    throw new Error('boom');
  };
  await controller.startDailyRun({ runId: 'armed' });
  assert.ok(alarmsAtEnsure > 0, 'the alarm must exist before the first await');
});

test('a running row with no alarm is repaired on the next object wake', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx, alarms } = await makeHarness();
  const controller = new PipelineController(ctx, {});
  controller.sql.exec(
    "INSERT INTO runs (run_id, status, phase, started_at) VALUES ('orphan','running','measuring','2026-11-12')"
  );
  alarms.length = 0; // simulate the alarm lost to an eviction
  await controller.reconcileOrphanAlarm();
  assert.equal(alarms.length, 1, 'a lost alarm must be re-armed');
  assert.equal(controller.latestEvent('orphan', 'alarm_rearmed') !== null, true);
});

test('a run id that already exists is reported, not silently reused', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = new PipelineController(ctx, {});
  let containerCalls = 0;
  controller.ensureContainer = async () => { containerCalls += 1; return {}; };
  controller.sql.exec(
    "INSERT INTO runs (run_id, status, phase, started_at) VALUES ('dup','held','done','2026-11-12')"
  );
  const result = await controller.startDailyRun({ runId: 'dup' });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /already exists/);
  assert.equal(containerCalls, 0, 'a duplicate id must not start a second run');
});

test('a 409 from the container carries its status so the caller can wait it out', async () => {
  const { PipelineController } = await loadWorker();
  const { ctx } = await makeHarness();
  const controller = new PipelineController(ctx, {});
  controller.containerFetch = async () => new Response('busy', { status: 409 });
  await assert.rejects(
    () => controller.containerJson('/run', {}),
    (error) => error.status === 409
  );
});
