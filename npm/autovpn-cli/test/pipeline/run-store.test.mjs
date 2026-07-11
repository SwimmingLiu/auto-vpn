import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunStore } from '../../dist/pipeline/run-store.js';

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
    ctx.store.setStageStatus('extract', 'running');
    ctx.store.setStageStatus('extract', 'success');

    const db = new DatabaseSync(ctx.dbPath);
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      for (const table of ['runs', 'stage_events', 'source_progress', 'raw_observations', 'pipeline_nodes']) {
        assert.ok(tables.includes(table), `missing ${table}`);
      }
      assert.deepEqual({ ...db.prepare('SELECT status FROM runs ORDER BY run_id DESC LIMIT 1').get() }, { status: 'running' });
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
    ctx.store.recordSpeedResult({ link, reachable: true, average_download_mb_s: 2.5, latency_ms: 42, error: '' });
    ctx.store.markAvailabilityRunning(link);
    const providers = { subscription: { provider: 'subscription', passed: true, reason: 'ok', status_code: 200, final_url: 'https://example.test', matched_phrase: '' } };
    ctx.store.recordAvailabilityResult({ link, all_passed: true, provider_results: providers, error: '' });

    assert.deepEqual(ctx.store.speedResults(), [{ link, reachable: true, average_download_mb_s: 2.5, latency_ms: 42, error: '', status: 'success' }]);
    assert.deepEqual(ctx.store.availabilityResults(), [{ link, all_passed: true, provider_results: providers, error: '', status: 'success' }]);
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
    ctx.store.recordSpeedResult({ link: first, reachable: true, average_download_mb_s: 1, latency_ms: 10, error: '' });
    ctx.store.markSpeedRunning(first);
    ctx.store.markSpeedRunning(second);
    ctx.store.markAvailabilityRunning(first);

    ctx.store.close();
    ctx.store = RunStore.open(ctx.dbPath);
    assert.deepEqual(ctx.store.resetInterruptedRunning(), { speed: [second], availability: [first] });
    assert.deepEqual(ctx.store.speedResults(), [
      { link: first, reachable: true, average_download_mb_s: 1, latency_ms: 10, error: '', status: 'success' },
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
