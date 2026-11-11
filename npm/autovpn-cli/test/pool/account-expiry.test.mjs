import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountStore } from '../../dist/pool/account-store.js';
import { createAutoVpnServer } from '../../dist/server/http.js';

/** The store compares membership dates against the operator's LOCAL day. */
function localDay(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shifted(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

function record(overrides = {}) {
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

function mutableClock(start) {
  const clock = { current: start, now: () => clock.current };
  return clock;
}

function captureIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: { writeStdout: (text) => out.push(text), writeStderr: (text) => err.push(text) }
  };
}

test('expiry_unknown counts live rows with no date, per brand and in total', () => {
  const store = new AccountStore({ dbPath: ':memory:', now: () => new Date('2026-11-09T00:00:00Z') });
  store.importRecords([
    record({ account: 'known', expires_at: '2027-01-01' }),
    record({ account: 'unknown-1' }),
    record({ account: 'unknown-2' }),
    record({ brand: 'heidong', account: 'unknown-3' })
  ]);
  // A retired row's unknown date is history, not a live gap.
  store.disable('leiting', 'unknown-2', 'test');

  const stats = store.stats();
  assert.equal(stats.expiry_unknown, 2);
  assert.equal(stats.total, 4);
  const byBrand = new Map(stats.by_brand.map((item) => [item.brand, item]));
  assert.equal(byBrand.get('leiting').expiry_unknown, 1);
  assert.equal(byBrand.get('heidong').expiry_unknown, 1);
  assert.equal(byBrand.get('leiting').total, 3);
  assert.equal(byBrand.get('leiting').disabled, 1);

  // Existing fields keep their order; new keys are appended.
  assert.deepEqual(Object.keys(stats), [
    'total', 'active', 'disabled', 'expired', 'invalid', 'deleted', 'expiring_soon', 'by_brand', 'db_path', 'expiry_unknown'
  ]);
  assert.deepEqual(Object.keys(stats.by_brand[0]), [
    'brand', 'total', 'active', 'disabled', 'expired', 'invalid', 'expiry_unknown'
  ]);
  store.close();
});

test('the expiry day itself is still leaseable; the next local day retires it', () => {
  const start = new Date('2026-11-09T12:00:00Z');
  const clock = mutableClock(start);
  const store = new AccountStore({ dbPath: ':memory:', now: clock.now });
  store.importRecords([record({ account: 'boundary', expires_at: localDay(start) })]);
  assert.equal(store.stats().active, 1);
  assert.equal(store.lease('leiting')?.account, 'boundary');

  clock.current = shifted(start, 1);
  const stats = store.stats();
  assert.equal(stats.expired, 1);
  assert.equal(stats.active, 0);
  assert.equal(store.lease('leiting'), null);
  const [row] = store.list({ status: 'all', includeDeleted: true });
  assert.equal(row.status, 'expired');
  assert.equal(row.status_reason, 'membership expired');
  assert.equal(row.deleted, true);
  store.close();
});

test('renewing a lapsed account revives exactly that retirement, not an invalid or disabled one', () => {
  const start = new Date('2026-11-09T12:00:00Z');
  const clock = mutableClock(start);
  const store = new AccountStore({ dbPath: ':memory:', now: clock.now });
  store.importRecords([
    record({ account: 'lapsed', expires_at: localDay(shifted(start, -3)) }),
    record({ account: 'lapsed-too', expires_at: localDay(shifted(start, -3)) }),
    record({ account: 'bad' }),
    record({ account: 'off' })
  ]);
  store.stats(); // sweep retires both lapsed rows
  store.markInvalid(3, 'login rejected');
  store.disable('leiting', 'off', 'disabled by operator');

  const future = localDay(shifted(start, 30));
  assert.equal(store.setExpiryById(1, future), true);
  const byId = new Map(store.list({ status: 'all', includeDeleted: true }).map((row) => [row.id, row]));
  assert.equal(byId.get(1).status, 'active');
  assert.equal(byId.get(1).status_reason, '');
  assert.equal(byId.get(1).deleted, false);
  assert.equal(byId.get(1).expires_at, future);
  assert.ok(store.history(1).some((event) => event.kind === 'revived'));

  // Invalid and operator-disabled rows keep their retirement: a new date says
  // nothing about a rejected credential or an explicit disable.
  assert.equal(store.setExpiryById(3, future), true);
  assert.equal(store.setExpiryById(4, future), true);
  const after = new Map(store.list({ status: 'all', includeDeleted: true }).map((row) => [row.id, row]));
  assert.equal(after.get(3).status, 'invalid');
  assert.equal(after.get(3).deleted, true);
  assert.equal(after.get(4).status, 'disabled');
  assert.equal(after.get(4).deleted, true);

  // A cleared date never revives anything.
  assert.equal(store.setExpiryById(2, ''), true);
  assert.equal(store.list({ status: 'all', includeDeleted: true }).find((row) => row.id === 2).status, 'expired');

  // A date that is still in the past is accepted but leaves the row retired.
  assert.equal(store.setExpiryById(2, localDay(shifted(start, -1))), true);
  assert.equal(store.list({ status: 'all', includeDeleted: true }).find((row) => row.id === 2).status, 'expired');
  store.close();
});

test('markExpired soft-deletes with the same shape as the date sweep', () => {
  const clock = mutableClock(new Date('2026-11-09T12:00:00Z'));
  const store = new AccountStore({ dbPath: ':memory:', now: clock.now });
  store.importRecords([record({ account: 'a1' })]);
  store.markExpired(1);
  const [row] = store.list({ status: 'all', includeDeleted: true });
  assert.equal(row.status, 'expired');
  assert.equal(row.status_reason, 'membership expired');
  assert.equal(row.deleted, true);
  assert.equal(store.lease('leiting'), null);
  assert.ok(store.history(1).some((event) => event.kind === 'expired' && event.detail === 'membership expired'));

  // The pipeline's reason is kept, and a learnt date still revives the row.
  store.markExpired(1, 'vendor says membership ended');
  assert.equal(store.list({ status: 'all', includeDeleted: true })[0].status_reason, 'vendor says membership ended');
  store.setExpiryById(1, localDay(shifted(clock.current, 10)));
  assert.equal(store.list({ status: 'all', includeDeleted: true })[0].status, 'expired');
  store.close();
});

test('the CLI list footer reports retired rows the default view hides', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-footer-'));
  const dbPath = path.join(dir, 'accounts.db');
  const store = new AccountStore({ dbPath, now: () => new Date('2026-11-09T00:00:00Z') });
  store.importRecords([record({ account: 'live' }), record({ account: 'gone' }), record({ account: 'gone-2' })]);
  store.disable('leiting', 'gone', 'test');
  store.markInvalid(3, 'login rejected');

  const { out, io } = captureIo();
  const context = { cwd: dir, env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath }, io, store };
  out.length = 0;
  await runAccountsCommand(['accounts', 'list', '--output', 'human'], context);
  const human = out.join('');
  assert.match(human, /^brand\s+account/);
  assert.match(human, /2 retired row\(s\) hidden; use --all to show them/);

  out.length = 0;
  await runAccountsCommand(['accounts', 'list', '--all', '--output', 'human'], context);
  assert.doesNotMatch(out.join(''), /hidden; use --all/);

  // JSON stays backward compatible: no footer key, same envelope.
  out.length = 0;
  await runAccountsCommand(['accounts', 'list'], context);
  const payload = JSON.parse(out.join(''));
  assert.deepEqual(Object.keys(payload), ['ok', 'count', 'accounts']);
  assert.equal(payload.count, 1);
  store.close();
});

test('the CLI stats view reports expiry_unknown without dropping existing lines', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-stats-'));
  const dbPath = path.join(dir, 'accounts.db');
  const store = new AccountStore({ dbPath, now: () => new Date('2026-11-09T00:00:00Z') });
  store.importRecords([record({ account: 'no-date' })]);

  const { out, io } = captureIo();
  await runAccountsCommand(['accounts', 'stats', '--output', 'human'], { cwd: dir, env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath }, io, store });
  const human = out.join('');
  assert.match(human, /expiring within 7 days: 0/);
  assert.match(human, /expiry unknown: 1/);
  assert.match(human, /unknown=1/);

  out.length = 0;
  await runAccountsCommand(['accounts', 'stats'], { cwd: dir, env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath }, io, store });
  assert.equal(JSON.parse(out.join('')).expiry_unknown, 1);
  store.close();
});

test('accounts refresh-expiry validates its flags before touching the pool', async () => {
  const { validateAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  assert.throws(() => validateAccountsCommand(['accounts', 'refresh-expiry', '--limit', 'abc']), /non-negative integer/);
  assert.throws(() => validateAccountsCommand(['accounts', 'refresh-expiry', '--concurrency', '0']), /positive integer/);
  assert.throws(() => validateAccountsCommand(['accounts', 'refresh-expiry', '--brand', 'nope']), /--brand must be one of/);
  assert.doesNotThrow(() => validateAccountsCommand(['accounts', 'refresh-expiry', '--brand', 'leiting', '--limit', '10', '--concurrency', '2']));
});

test('accounts refresh-expiry fails gracefully when no worker is available', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-refresh-none-'));
  const dbPath = path.join(dir, 'accounts.db');
  const store = new AccountStore({ dbPath });
  const { out, err, io } = captureIo();
  const code = await runAccountsCommand(['accounts', 'refresh-expiry'], {
    cwd: dir, env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath }, io, store, refreshExpiry: null
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(out.join('')), { ok: false, error: 'refresh_expiry_unavailable' });
  assert.match(err.join(''), /no expiry refresh worker/);
  store.close();
});

test('accounts refresh-expiry passes defaults and renders the worker result', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-refresh-'));
  const dbPath = path.join(dir, 'accounts.db');
  const store = new AccountStore({ dbPath, now: () => new Date('2026-11-09T00:00:00Z') });
  store.importRecords([record({ account: 'a1' }), record({ account: 'a2' })]);

  const calls = [];
  const worker = async (input) => {
    calls.push(input);
    return {
      checked: 2,
      updated: 1,
      expired: 1,
      failed: 0,
      results: [
        { brand: 'leiting', account_masked: 'a1', expires_at: '2027-01-01', status: 'updated' },
        { brand: 'leiting', account_masked: 'a2', expires_at: '2026-01-01', status: 'expired' }
      ]
    };
  };

  const { out, io } = captureIo();
  const context = { cwd: dir, env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath }, io, store, refreshExpiry: worker, now: () => new Date('2026-11-09T00:00:00Z') };

  const code = await runAccountsCommand(['accounts', 'refresh-expiry'], context);
  assert.equal(code, 0);
  const payload = JSON.parse(out.join(''));
  assert.equal(payload.checked, 2);
  assert.equal(payload.updated, 1);
  assert.equal(payload.expired, 1);
  assert.equal(payload.failed, 0);
  assert.equal(payload.results.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 0);
  assert.equal(calls[0].concurrency, 3);
  assert.equal(calls[0].brand, undefined);
  assert.equal(calls[0].store, store);

  calls.length = 0;
  out.length = 0;
  const code2 = await runAccountsCommand(
    ['accounts', 'refresh-expiry', '--brand', 'leiting', '--limit', '5', '--concurrency', '2', '--output', 'human'],
    context
  );
  assert.equal(code2, 0);
  assert.equal(calls[0].brand, 'leiting');
  assert.equal(calls[0].limit, 5);
  assert.equal(calls[0].concurrency, 2);
  const human = out.join('');
  assert.match(human, /leiting\s+a1\s+2027-01-01\s+updated/);
  assert.match(human, /checked=2 updated=1 expired=1 retired=0 failed=0/);

  // A failed login is a non-zero exit but still a rendered result.
  out.length = 0;
  const failing = async () => ({
    checked: 1,
    updated: 0,
    expired: 0,
    failed: 1,
    results: [{ brand: 'leiting', account_masked: 'a1', expires_at: '', status: 'failed', error: 'login rejected' }]
  });
  const code3 = await runAccountsCommand(['accounts', 'refresh-expiry', '--output', 'human'], { ...context, refreshExpiry: failing });
  assert.equal(code3, 1);
  assert.match(out.join(''), /failed\s+login rejected/);
  store.close();
});

test('the membership sweep retires free-tier and rejected rows, not just lapsed ones', async () => {
  // The sweep passes explicit credentials, so the run path's leased-row
  // retirement never fires for it. A free-tier account reports a date years
  // ahead and would otherwise stay in rotation forever.
  const { classifyMembershipRefresh } = await import('../../dist/pipeline/credential-source.js');
  const today = '2026-11-12';
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: true, membership_expires_at: '2027-06-07', membership_level: 2 }, today),
    { status: 'updated', reason: '' }
  );
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: true, membership_expires_at: '2026-01-01', membership_level: 2 }, today),
    { status: 'expired', reason: 'membership expired' }
  );
  // Free tier with a future date: retired, and the reason names the real cause.
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: true, membership_expires_at: '2027-06-07', membership_level: 1 }, today),
    { status: 'retired', reason: 'no paid membership' }
  );
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: true, membership_expires_at: '2027-06-07', membership_level: 0, route_count: 0 }, today),
    { status: 'retired', reason: 'no paid membership' }
  );
  // A paid row the vendor misreports as level 1 keeps its place when it produced.
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: true, membership_expires_at: '2027-06-07', membership_level: 1, produced_links: 3 }, today),
    { status: 'updated', reason: '' }
  );
  // Routes are not proof: the table is filtered by flags, not by the account's
  // grade, so a free row can list 12 paid-looking areas and still get nothing.
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: true, membership_expires_at: '2027-06-07', membership_level: 0, route_count: 12 }, today),
    { status: 'retired', reason: 'no paid membership' }
  );
  // A redirected row is graded by its own storefront, not the backend it reads.
  // Retiring on that grade would discard the accounts the rotation hunts for.
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: true, membership_expires_at: '2027-06-07', membership_level: 0, redirected: true }, today),
    { status: 'updated', reason: '' }
  );
  // The exemption is about the grade only: a lapsed date still retires.
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: true, membership_expires_at: '2026-01-01', membership_level: 0, redirected: true }, today),
    { status: 'expired', reason: 'membership expired' }
  );
  // An unreported level is not evidence of a free account.
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: true, membership_expires_at: '2027-06-07' }, today),
    { status: 'updated', reason: '' }
  );
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: false, membership_expired: true }, today),
    { status: 'expired', reason: 'membership expired' }
  );
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: false, credential_rejected: true }, today),
    { status: 'retired', reason: 'login rejected' }
  );
  // A throttle or a transport failure is neither: the row must survive it.
  assert.deepEqual(
    classifyMembershipRefresh({ login_ok: false }, today),
    { status: 'failed', reason: '' }
  );
});

test('POST /api/accounts/expiry routes {id, expires_at} to the runtime', async () => {
  const calls = [];
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '', password: '', maxAttempts: 5 },
    runtime: {
      loadState: async () => ({ profile: { sources: {} }, runState: 'idle' }),
      setAccountExpiry: async (input) => {
        calls.push(input);
        return { ok: true, id: input.id, expires_at: input.expires_at };
      }
    }
  });
  try {
    const response = await fetch(`${service.origin}/api/accounts/expiry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 7, expires_at: '2027-03-01' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, id: 7, expires_at: '2027-03-01' });
    assert.deepEqual(calls[0], { id: 7, brand: '', account: '', expires_at: '2027-03-01' });

    const missing = await fetch(`${service.origin}/api/accounts/expiry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 7 })
    });
    assert.equal(missing.status, 200);
    assert.equal(calls[1].expires_at, undefined);
  } finally {
    await service.close();
  }
});

test('the server runtime sets an expiry by id and by brand/account', async () => {
  const { createServerRuntime } = await import('../../dist/server/runtime.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-runtime-'));
  const env = { VPN_AUTOMATION_ACCOUNTS_DB: path.join(dir, 'accounts.db') };
  const store = new AccountStore({ dbPath: env.VPN_AUTOMATION_ACCOUNTS_DB, now: () => new Date('2026-11-09T00:00:00Z') });
  store.importRecords([record({ account: 'lapsed', expires_at: '2026-01-01' }), record({ account: 'a2' })]);
  store.close();

  const runtime = createServerRuntime({ projectRoot: dir, env, now: () => new Date('2026-11-09T00:00:00Z') });
  try {
    const byId = await runtime.setAccountExpiry({ id: 1, expires_at: '2027/3/1' });
    assert.deepEqual(byId, { ok: true, id: 1, expires_at: '2027-03-01' });
    const byAccount = await runtime.setAccountExpiry({ brand: 'leiting', account: 'a2', expires_at: '2027-04-02' });
    assert.deepEqual(byAccount, { ok: true, brand: 'leiting', expires_at: '2027-04-02' });

    assert.deepEqual(await runtime.setAccountExpiry({ id: 1, expires_at: 'soon' }), { ok: false, error: 'invalid_date', id: 1 });
    assert.deepEqual(await runtime.setAccountExpiry({ id: 99, expires_at: '2027-01-01' }), { ok: false, error: 'account_not_found' });
    assert.deepEqual(await runtime.setAccountExpiry({ id: 1 }), { ok: false, error: 'expires_at_required' });
    assert.deepEqual(await runtime.setAccountExpiry({}), { ok: false, error: 'id_or_brand_and_account_required' });

    const snapshot = await runtime.loadAccounts();
    const lapsed = snapshot.accounts.find((row) => row.id === 1);
    assert.equal(lapsed.status, 'active', 'renewing the date revives a lapsed row through the API too');
    assert.equal(lapsed.expires_at, '2027-03-01');
    assert.equal(snapshot.stats.expiry_unknown, 0);
  } finally {
    await runtime.close?.();
  }
});
