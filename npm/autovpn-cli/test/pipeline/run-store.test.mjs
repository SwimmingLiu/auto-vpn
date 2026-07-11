import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunStore, readLatestStageStatuses, readRunStatus } from '../../dist/pipeline/run-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function vmessLink(name, address = '1.1.1.1', port = '443') {
  return `vmess://${Buffer.from(JSON.stringify({
    v: '2', ps: name, add: address, port, id: 'uuid', net: 'ws', host: address,
    path: '/ws', tls: 'tls', sni: ''
  })).toString('base64')}`;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autovpn-run-store-'));
  const dbPath = path.join(root, 'run.sqlite3');
  const context = { root, dbPath, store: RunStore.open(dbPath), cleanup: async () => {} };
  context.cleanup = async () => { context.store.close(); await rm(root, { recursive: true, force: true }); };
  return context;
}

test('creates the run-local WAL schema and remains compatible with current readers', async () => {
  const ctx = await fixture();
  try {
    const runId = ctx.store.initializeRun('running');
    assert.equal(ctx.store.busyTimeout(), 5000);
    ctx.store.setStageStatus('extract', 'running');
    ctx.store.setStageStatus('extract', 'success');
    ctx.store.setRunStatus('success');

    const db = new DatabaseSync(ctx.dbPath);
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      for (const table of ['runs', 'stage_events', 'source_progress', 'raw_observations', 'pipeline_nodes']) {
        assert.ok(tables.includes(table), `missing ${table}`);
      }
      assert.deepEqual({ ...db.prepare('SELECT status FROM runs ORDER BY run_id DESC LIMIT 1').get() }, { status: 'success' });
      assert.deepEqual(db.prepare('SELECT stage_name,status FROM stage_events ORDER BY rowid ASC').all().map((row) => ({ ...row })), [
        { stage_name: 'extract', status: 'running' },
        { stage_name: 'extract', status: 'success' }
      ]);
      assert.equal(runId, 1);
    } finally {
      db.close();
    }
  } finally {
    await ctx.cleanup();
  }
});

test('preserves raw observations while deduping canonical vmess endpoints in discovery order', async () => {
  const ctx = await fixture();
  try {
    ctx.store.initializeRun();
    const first = vmessLink('first');
    const duplicate = vmessLink('renamed');
    const second = vmessLink('second', '2.2.2.2');

    assert.deepEqual(ctx.store.recordExtractedNode('source-a', first), { inserted: true, sequence: 1 });
    assert.deepEqual(ctx.store.recordExtractedNode('source-b', duplicate), { inserted: false, sequence: 1 });
    assert.deepEqual(ctx.store.recordExtractedNode('source-a', second), { inserted: true, sequence: 2 });
    assert.deepEqual(ctx.store.rawLinks(), [first, duplicate, second]);
    assert.deepEqual(ctx.store.dedupedLinks(), [first, second]);
    assert.deepEqual(ctx.store.counts(), {
      raw: 3, deduped: 2, probes: 0, speed: 0, availability: 0
    });

    ctx.store.recordSourceProgress('source-a', { processed: 3, total: 4, status: 'running' });
    ctx.store.recordSourceProgress('source-a', { processed: 4, total: 4, status: 'success' });
    assert.deepEqual(ctx.store.sourceProgress(), [{ source: 'source-a', processed: 4, total: 4, status: 'success', error: '' }]);
  } finally {
    await ctx.cleanup();
  }
});

test('roundtrips speed and availability results and redacts errors before persistence', async () => {
  const ctx = await fixture();
  try {
    ctx.store.initializeRun();
    const link = vmessLink('node');
    ctx.store.recordExtractedNode('source', link);
    ctx.store.markSpeedRunning(link);
    ctx.store.recordProbe({ link, reachable: false, latency_ms: 0, error: 'token=SECRET vmess://abcdef' });
    ctx.store.recordSpeedResult({ link, reachable: true, average_download_mb_s: 2.5, latency_ms: 42, error: '' }, true);
    ctx.store.markAvailabilityRunning(link);
    const providers = { subscription: { provider: 'subscription', passed: true, reason: 'ok', status_code: 200, final_url: 'https://example.test', matched_phrase: '' } };
    ctx.store.recordAvailabilityResult({ link, all_passed: true, provider_results: providers, error: '' });

    assert.deepEqual(ctx.store.speedResults(), [{ link, reachable: true, average_download_mb_s: 2.5, latency_ms: 42, error: '', status: 'speed_passed' }]);
    assert.deepEqual(ctx.store.availabilityResults(), [{ link, all_passed: true, provider_results: providers, error: '', status: 'availability_passed' }]);
    assert.equal(ctx.store.probeResults()[0].error, 'token=<redacted> vmess://<redacted>');
    assert.deepEqual(ctx.store.counts(), { raw: 1, deduped: 1, probes: 1, speed: 1, availability: 1 });
  } finally {
    await ctx.cleanup();
  }
});

test('keeps terminal states monotonic and transactionally resets interrupted work for resume', async () => {
  const ctx = await fixture();
  try {
    ctx.store.initializeRun();
    const first = vmessLink('first', '1.1.1.1');
    const second = vmessLink('second', '2.2.2.2');
    ctx.store.recordExtractedNode('source', first);
    ctx.store.recordExtractedNode('source', second);

    ctx.store.markSpeedRunning(first);
    ctx.store.recordSpeedResult({ link: first, reachable: true, average_download_mb_s: 1, latency_ms: 10, error: '' }, true);
    ctx.store.markSpeedRunning(first);
    ctx.store.markSpeedRunning(second);
    ctx.store.markAvailabilityRunning(first);

    ctx.store.close();
    ctx.store = RunStore.open(ctx.dbPath);
    assert.deepEqual(ctx.store.resetInterruptedRunning(), { speed: [second], availability: [first] });
    assert.deepEqual(ctx.store.speedResults(), [
      { link: first, reachable: true, average_download_mb_s: 1, latency_ms: 10, error: '', status: 'speed_passed' },
      { link: second, reachable: false, average_download_mb_s: 0, latency_ms: 0, error: '', status: 'pending' }
    ]);
    assert.deepEqual(ctx.store.availabilityResults(), [
      { link: first, all_passed: false, provider_results: {}, error: '', status: 'pending' }
    ]);
    assert.deepEqual(ctx.store.dedupedLinks(), [first, second]);
  } finally {
    await ctx.cleanup();
  }
});

test('openOrImport creates run.db from legacy artifacts in discovery order and is idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autovpn-run-import-'));
  const first = vmessLink('first', '1.1.1.1');
  const duplicate = vmessLink('duplicate', '1.1.1.1');
  const second = vmessLink('second', '2.2.2.2');
  try {
    await writeFile(path.join(root, 'vpn_node_raw.txt'), `${first}\n${duplicate}\n${second}\n`);
    await writeFile(path.join(root, 'vpn_node_deduped.txt'), `${first}\n${second}\n`);
    await writeFile(path.join(root, 'vpn_node_speedtest_report.json'), JSON.stringify([
      { link: first, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' }
    ]));
    await writeFile(path.join(root, 'vpn_node_availability_report.json'), JSON.stringify([
      { link: first, all_passed: true, provider_results: { site: { passed: true } }, error: '' }
    ]));

    let store = RunStore.openOrImport(root);
    assert.deepEqual(store.rawLinks(), [first, duplicate, second]);
    assert.deepEqual(store.dedupedLinks(), [first, second]);
    assert.equal(store.speedResults()[0].status, 'speed_passed');
    assert.equal(store.availabilityResults()[0].status, 'availability_passed');
    store.close();

    store = RunStore.openOrImport(root);
    assert.deepEqual(store.counts(), { raw: 3, deduped: 2, probes: 0, speed: 1, availability: 1 });
    store.close();
    assert.equal(readRunStatus(path.join(root, 'run.db')), 'running');
    assert.deepEqual(readLatestStageStatuses(path.join(root, 'run.db')), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy import never promotes unreachable speed report rows to winners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autovpn-run-import-failed-'));
  const winner = vmessLink('winner', '1.1.1.1');
  const unreachable = vmessLink('unreachable', '2.2.2.2');
  try {
    await writeFile(path.join(root, 'vpn_node_raw.txt'), `${winner}\n${unreachable}\n`);
    await writeFile(path.join(root, 'vpn_node_deduped.txt'), `${winner}\n${unreachable}\n`);
    await writeFile(path.join(root, 'vpn_node_speedtest_report.json'), JSON.stringify([
      { link: winner, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' },
      { link: unreachable, reachable: false, average_download_mb_s: 9, latency_ms: 0, error: 'timeout' }
    ]));
    const store = RunStore.openOrImport(root);
    assert.deepEqual(store.speedResults().map(({ link, status }) => ({ link, status })), [
      { link: winner, status: 'speed_passed' },
      { link: unreachable, status: 'speed_failed' }
    ]);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('safe status readers return undefined state for malformed databases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autovpn-run-reader-'));
  const dbPath = path.join(root, 'run.db');
  try {
    await writeFile(dbPath, 'not sqlite');
    assert.equal(readRunStatus(dbPath), undefined);
    assert.deepEqual(readLatestStageStatuses(dbPath), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('seedRetry preserves only terminal node inputs before the retry boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autovpn-run-retry-seed-'));
  const sourceDir = path.join(root, 'source');
  const speedDir = path.join(root, 'speed');
  const availabilityDir = path.join(root, 'availability');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(speedDir, { recursive: true });
  await mkdir(availabilityDir, { recursive: true });
  const first = vmessLink('first', '1.1.1.1');
  const second = vmessLink('second', '2.2.2.2');
  try {
    const source = RunStore.open(path.join(sourceDir, 'run.db'));
    source.initializeRun();
    source.recordExtractedNode('source', first);
    source.recordExtractedNode('source', second);
    for (const link of [first, second]) {
      source.recordProbe({ link, reachable: true, latency_ms: 10, error: '' });
      source.recordSpeedResult({ link, reachable: true, average_download_mb_s: 2, latency_ms: 10, error: '' }, true);
      source.recordAvailabilityResult({ link, all_passed: true, provider_results: {}, error: '' });
    }
    source.close();

    let seeded = RunStore.seedRetry(sourceDir, speedDir, 'speedtest');
    assert.deepEqual(seeded.dedupedLinks(), [first, second]);
    assert.deepEqual(seeded.speedResults(), []);
    assert.deepEqual(seeded.availabilityResults(), []);
    seeded.close();

    seeded = RunStore.seedRetry(sourceDir, availabilityDir, 'availability');
    assert.deepEqual(seeded.speedResults().map(({ status }) => status), ['speed_passed', 'speed_passed']);
    assert.deepEqual(seeded.availabilityResults(), []);
    seeded.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists explicit speed and availability failure terminal states', async () => {
  const ctx = await fixture();
  try {
    ctx.store.initializeRun();
    const unreachable = vmessLink('unreachable', '3.3.3.3');
    const belowThreshold = vmessLink('slow', '4.4.4.4');
    ctx.store.recordExtractedNode('source', unreachable);
    ctx.store.recordExtractedNode('source', belowThreshold);

    ctx.store.markSpeedRunning(unreachable);
    ctx.store.recordSpeedResult({ link: unreachable, reachable: false, average_download_mb_s: 0, latency_ms: 0, error: 'probe failed' }, false);
    ctx.store.markSpeedRunning(belowThreshold);
    ctx.store.recordSpeedResult({ link: belowThreshold, reachable: true, average_download_mb_s: 0.25, latency_ms: 80, error: '' }, false);
    ctx.store.markAvailabilityRunning(belowThreshold);
    ctx.store.recordAvailabilityResult({ link: belowThreshold, all_passed: false, provider_results: {}, error: 'token=SECRET' });

    assert.deepEqual(ctx.store.speedResults().map(({ link, reachable, status }) => ({ link, reachable, status })), [
      { link: unreachable, reachable: false, status: 'speed_failed' },
      { link: belowThreshold, reachable: true, status: 'speed_failed' }
    ]);
    assert.deepEqual(ctx.store.availabilityResults(), [{
      link: belowThreshold,
      all_passed: false,
      provider_results: {},
      error: 'token=<redacted>',
      status: 'availability_failed'
    }]);
  } finally {
    await ctx.cleanup();
  }
});

test('keeps run and stage terminal states monotonic across two connections', async () => {
  const ctx = await fixture();
  let second;
  try {
    ctx.store.initializeRun();
    second = RunStore.open(ctx.dbPath);
    ctx.store.setRunStatus('success');
    second.setRunStatus('running');
    ctx.store.setStageStatus('speed', 'running');
    second.setStageStatus('speed', 'success');
    ctx.store.setStageStatus('speed', 'running');

    const db = new DatabaseSync(ctx.dbPath);
    try {
      assert.equal(db.prepare('SELECT status FROM runs ORDER BY run_id DESC LIMIT 1').get().status, 'success');
      assert.deepEqual(db.prepare("SELECT status FROM stage_events WHERE stage_name='speed' ORDER BY rowid").all().map((row) => row.status), ['running', 'success']);
    } finally {
      db.close();
    }
  } finally {
    second?.close();
    await ctx.cleanup();
  }
});

test('rejects invalid and stale source progress updates', async () => {
  const ctx = await fixture();
  try {
    ctx.store.initializeRun();
    assert.throws(() => ctx.store.recordSourceProgress('source', { processed: -1, total: 2, status: 'running' }), /processed/);
    assert.throws(() => ctx.store.recordSourceProgress('source', { processed: 3, total: 2, status: 'running' }), /processed/);
    ctx.store.recordSourceProgress('source', { processed: 2, total: 10, status: 'running' });
    ctx.store.recordSourceProgress('source', { processed: 2, total: 3, status: 'running' });
    ctx.store.recordSourceProgress('source', { processed: 3, total: 4, status: 'running' });
    assert.deepEqual(ctx.store.sourceProgress(), [{ source: 'source', processed: 2, total: 10, status: 'running', error: '' }]);
    ctx.store.recordSourceProgress('source', { processed: 1, total: 10, status: 'running' });
    ctx.store.recordSourceProgress('source', { processed: 10, total: 10, status: 'success' });
    ctx.store.recordSourceProgress('source', { processed: 9, total: 10, status: 'running' });
    assert.deepEqual(ctx.store.sourceProgress(), [{ source: 'source', processed: 10, total: 10, status: 'success', error: '' }]);
  } finally {
    await ctx.cleanup();
  }
});

test('rejects result writes for unknown nodes without changing counts', async () => {
  const ctx = await fixture();
  try {
    ctx.store.initializeRun();
    const unknown = vmessLink('unknown', '9.9.9.9');
    assert.throws(() => ctx.store.recordProbe({ link: unknown, reachable: false, latency_ms: 0 }), /unknown pipeline node/);
    assert.throws(() => ctx.store.markSpeedRunning(unknown), /unknown pipeline node/);
    assert.throws(() => ctx.store.recordSpeedResult({ link: unknown, reachable: false, average_download_mb_s: 0, latency_ms: 0 }, false), /unknown pipeline node/);
    assert.throws(() => ctx.store.markAvailabilityRunning(unknown), /unknown pipeline node/);
    assert.throws(() => ctx.store.recordAvailabilityResult({ link: unknown, all_passed: false, provider_results: {} }), /unknown pipeline node/);
    assert.deepEqual(ctx.store.counts(), { raw: 0, deduped: 0, probes: 0, speed: 0, availability: 0 });
    assert.deepEqual(ctx.store.speedResults(), []);
    assert.deepEqual(ctx.store.availabilityResults(), []);
  } finally {
    await ctx.cleanup();
  }
});

test('safely falls back for corrupt or non-object provider JSON', async () => {
  const ctx = await fixture();
  try {
    ctx.store.initializeRun();
    const first = vmessLink('first', '5.5.5.5');
    const second = vmessLink('second', '6.6.6.6');
    ctx.store.recordExtractedNode('source', first);
    ctx.store.recordExtractedNode('source', second);
    ctx.store.recordAvailabilityResult({ link: first, all_passed: true, provider_results: { ok: true } });
    ctx.store.recordAvailabilityResult({ link: second, all_passed: true, provider_results: { ok: true } });
    const db = new DatabaseSync(ctx.dbPath);
    try {
      db.prepare('UPDATE availability_results SET provider_results = ? WHERE canonical_key = ?').run('{broken', JSON.stringify(['5.5.5.5', '443', 'uuid', 'ws', '5.5.5.5', '/ws', 'tls', '']));
      db.prepare('UPDATE availability_results SET provider_results = ? WHERE canonical_key = ?').run('[]', JSON.stringify(['6.6.6.6', '443', 'uuid', 'ws', '6.6.6.6', '/ws', 'tls', '']));
    } finally {
      db.close();
    }
    assert.deepEqual(ctx.store.availabilityResults().map((row) => row.provider_results), [{}, {}]);
  } finally {
    await ctx.cleanup();
  }
});

test('rejects invalid persisted state names', async () => {
  const ctx = await fixture();
  try {
    ctx.store.initializeRun();
    assert.throws(() => ctx.store.setRunStatus('whatever'), /constraint failed/i);
    assert.throws(() => ctx.store.setStageStatus('extract', 'whatever'), /constraint failed/i);
    assert.throws(() => ctx.store.recordSourceProgress('source', { processed: 0, total: 1, status: 'whatever' }), /constraint failed/i);
  } finally {
    await ctx.cleanup();
  }
});
