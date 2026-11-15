import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountStore } from '../../dist/pool/account-store.js';
import {
  describeSharedPoolUrl,
  pullSharedPool,
  pushSharedPool,
  pruneSharedPool,
  resolveSharedPoolUrl
} from '../../dist/pool/pg-pool.js';

function tempStore(nowIso = '2026-11-09T00:00:00Z') {
  return new AccountStore({ dbPath: ':memory:', now: () => new Date(nowIso) });
}

function localRecord(overrides = {}) {
  return {
    brand: 'leiting',
    account: 'user-1',
    password: 'pass-1',
    official_site: 'https://www.68123836.com',
    expires_at: '',
    status: 'active',
    note: '',
    ...overrides
  };
}

function remoteRow(overrides = {}) {
  return {
    brand: 'leiting',
    account: 'user-1',
    password: 'pass-1',
    official_site: 'https://www.68123836.com',
    expires_at: '',
    status: 'active',
    status_reason: '',
    note: '',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-09T00:00:00Z',
    last_used_at: '',
    use_count: 0,
    success_count: 0,
    fail_count: 0,
    deleted_at: null,
    ...overrides
  };
}

test('the shared pool URL is read from the most specific name first', () => {
  assert.equal(resolveSharedPoolUrl({}), '');
  assert.equal(resolveSharedPoolUrl({ PGSQL: 'postgresql://a/b' }), 'postgresql://a/b');
  assert.equal(
    resolveSharedPoolUrl({ PGSQL: 'postgresql://a/b', AUTOVPN_ACCOUNTS_DB_URL: 'postgresql://c/d' }),
    'postgresql://c/d'
  );
  assert.equal(
    resolveSharedPoolUrl({ PGSQL: 'postgresql://a/b', VPN_AUTOMATION_ACCOUNTS_DB_URL: 'postgresql://e/f' }),
    'postgresql://e/f'
  );
  // Whitespace is not a configured database: a blank secret must not make the
  // CLI open a connection to nowhere.
  assert.equal(resolveSharedPoolUrl({ AUTOVPN_ACCOUNTS_DB_URL: '   ' }), '');
});

test('a pool URL is never printed with its password', () => {
  assert.equal(
    describeSharedPoolUrl('postgresql://autonet:s3cret@118.25.65.206:5432/autonet?sslmode=prefer'),
    '118.25.65.206:5432/autonet'
  );
  assert.equal(
    describeSharedPoolUrl('postgresql://autonet:s3cret@db.example/autonet'),
    'db.example:5432/autonet'
  );
  assert.equal(describeSharedPoolUrl('not a url'), 'postgres (unparsable url)');
});

test('a pull inserts rows the local copy has never seen, retired ones included', () => {
  const store = tempStore();
  const outcome = store.mergeRemoteRows([
    remoteRow(),
    remoteRow({
      account: 'user-2',
      status: 'invalid',
      status_reason: 'login rejected',
      deleted_at: '2026-11-02T00:00:00Z',
      use_count: 12,
      success_count: 3,
      fail_count: 2,
      last_used_at: '2026-11-02T00:00:00Z'
    })
  ]);
  assert.deepEqual(outcome, { inserted: 2, updated: 0, unchanged: 0, local_newer: 0, skipped: 0 });
  const rows = store.syncSnapshot();
  assert.equal(rows.length, 2);
  const retired = rows.find((row) => row.account === 'user-2');
  assert.equal(retired.status, 'invalid');
  assert.equal(retired.deleted_at, '2026-11-02T00:00:00Z');
  assert.equal(retired.use_count, 12);
  assert.equal(retired.success_count, 3);
  // A retired row never leases, so a pull that dropped `deleted_at` would put a
  // dead credential back into rotation.
  assert.equal(store.lease('leiting')?.account, 'user-1');
});

test('the fresher row wins a conflict, in both directions', () => {
  const store = tempStore('2026-11-10T00:00:00Z');
  store.importRecords([localRecord()]);
  // The local row was written at 2026-11-10; a remote row from an hour earlier
  // must not overwrite it.
  const stale = store.mergeRemoteRows([remoteRow({ password: 'old-pass', updated_at: '2026-11-09T23:00:00Z' })]);
  assert.equal(stale.local_newer, 1);
  assert.equal(stale.updated, 0);
  assert.equal(store.exportRecords()[0].password, 'pass-1');

  const fresh = store.mergeRemoteRows([remoteRow({ password: 'new-pass', updated_at: '2026-11-10T01:00:00Z' })]);
  assert.equal(fresh.updated, 1);
  assert.equal(store.exportRecords()[0].password, 'new-pass');
});

test('usage counters take the larger value across hosts', () => {
  const store = tempStore('2026-11-09T00:00:00Z');
  store.mergeRemoteRows([remoteRow({ use_count: 10, success_count: 8 })]);
  // The runner's night ran nine more logins but its row was written first; the
  // database's fresher row reports three. Keeping "the winner's" counter would
  // erase the runner's history, so the merge keeps the larger one.
  const outcome = store.mergeRemoteRows([remoteRow({ use_count: 3, success_count: 2, updated_at: '2026-11-09T05:00:00Z' })]);
  assert.equal(outcome.updated, 0);
  assert.equal(outcome.unchanged, 1);
  const row = store.syncSnapshot()[0];
  assert.equal(row.use_count, 10);
  assert.equal(row.success_count, 8);
});

test('an unusable remote row is skipped, not imported into rotation', () => {
  const store = tempStore();
  const outcome = store.mergeRemoteRows([
    remoteRow({ brand: 'not-a-brand' }),
    remoteRow({ account: '', password: 'x' }),
    remoteRow({ account: 'user-9', password: '' })
  ]);
  assert.deepEqual(outcome, { inserted: 0, updated: 0, unchanged: 0, local_newer: 0, skipped: 3 });
  assert.equal(store.syncSnapshot().length, 0);
});

test('a sync records when it ran, without a row payload', () => {
  const store = tempStore();
  store.recordSync('pull', '2026-11-09T00:00:00Z', { inserted: 3 });
  const state = store.syncState();
  assert.equal(state.last_pull_at, '2026-11-09T00:00:00Z');
  assert.deepEqual(state.last_pull_counts, { inserted: 3 });
  assert.equal(state.last_push_at, '');
});

/**
 * The round trip against a real server. Skipped unless the URL is supplied, so
 * the suite stays offline by default; CI runs the merge tests above and the
 * pipeline tests exercise the same code through the store.
 */
const TEST_URL = String(process.env.AUTOVPN_PG_TEST_URL ?? '').trim();

test('a row pushed to the shared pool comes back on another host', { skip: !TEST_URL }, async () => {
  const account = `sync-test-${process.pid}-${Date.now()}`;
  // Both sentinels are retired with a stamp past the retention window, so the
  // prune at the end removes every row this test wrote — the production table
  // is shared, and a test that leaves rows behind quietly grows the pool.
  const source = tempStore('2026-11-09T00:00:00Z');
  source.mergeRemoteRows([
    remoteRow({ account, status: 'invalid', status_reason: 'sync test', deleted_at: '2020-01-01T00:00:00Z' }),
    remoteRow({
      account: account + '-2',
      status: 'expired',
      status_reason: 'sync test',
      deleted_at: '2020-01-01T00:00:00Z',
      updated_at: '2020-01-01T00:00:00Z'
    })
  ]);
  const pushed = await pushSharedPool(source, { url: TEST_URL, now: () => new Date() });
  assert.equal(pushed.sent, 2);
  assert.equal(pushed.inserted, 2);

  const target = tempStore('2026-11-09T00:00:00Z');
  const pulled = await pullSharedPool(target, { url: TEST_URL, now: () => new Date() });
  assert.ok(pulled.inserted >= 2);
  assert.equal(target.syncSnapshot().find((row) => row.account === account).status, 'invalid');

  const pruned = await pruneSharedPool(target, 1, { url: TEST_URL, now: () => new Date() });
  assert.equal(pruned, 2);
});
