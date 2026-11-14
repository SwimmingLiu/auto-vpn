import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountStore, retiredRetentionDays } from '../../dist/pool/account-store.js';
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

test('the sweep probes the same host a run reaches, including the redirect', async () => {
  // The run rewrites a redirected row's official_site to the backend before any
  // request. The sweep used to probe the storefront instead — a host the run
  // never contacts, and one the deployment host cannot even resolve — so its
  // verdicts described a different account than the one the pool rotates.
  const { resolveExpiryProbeTargets, fingerprintKeyFor } = await import('../../dist/pipeline/credential-source.js');
  const targets = resolveExpiryProbeTargets({}, () => ({
    heidong: { mode: 'credential', official_site: 'https://www.heidongm.com', backend_brand: 'leiting' },
    mifeng: { mode: 'credential', official_site: 'https://www.mifengbuzz.com' }
  }));
  assert.equal(targets.get('heidong').backendBrand, 'leiting');
  assert.equal(targets.get('heidong').officialSite, 'https://www.heidongm.com');
  assert.equal(targets.get('mifeng').backendBrand, undefined);
  // A self-referential or unknown backend is not a redirect.
  const selfRef = resolveExpiryProbeTargets({}, () => ({
    leiting: { mode: 'credential', official_site: 'https://www.leitingku.com', backend_brand: 'leiting' },
    xuanfeng: { mode: 'credential', official_site: 'https://www.xfjsq9.com', backend_brand: 'not-a-vendor' }
  }));
  assert.equal(selfRef.get('leiting').backendBrand, undefined);
  assert.equal(selfRef.get('xuanfeng').backendBrand, undefined);
  // The APK cache key follows the data plane, so the sweep shares the entry the
  // run just wrote instead of re-downloading under the storefront's prefix.
  const runKey = fingerprintKeyFor('heidong', { brand_override: 'leiting' });
  const sweepKey = fingerprintKeyFor('heidong', {
    official_site: targets.get('heidong').officialSite,
    brand_override: targets.get('heidong').backendBrand
  });
  assert.equal(sweepKey, runKey);
  assert.equal(runKey, 'lt');
  // An unreadable profile leaves every brand on its own storefront.
  const empty = resolveExpiryProbeTargets({}, () => { throw new Error('no profile'); });
  assert.equal(empty.size, 0);
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

// --- Retired-row retention -------------------------------------------------

test('the retention sweep erases expired and invalid rows past the window', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const store = new AccountStore({ dbPath: ':memory:', now: clock.now });
  store.importRecords([
    record({ account: 'live', expires_at: '2030-01-01' }),
    record({ account: 'lapsed', expires_at: '2026-05-01' }),
    record({ account: 'bad-pass', expires_at: '2030-01-01', status: 'invalid' }),
    record({ account: 'paused', expires_at: '2030-01-01' })
  ]);
  store.disable('leiting', 'paused', 'operator pause');
  store.expireDue();

  // Nothing is old enough yet: the window is measured from the retirement
  // stamp, not from the membership date.
  assert.equal(store.purgeRetired(30), 0);
  clock.current = new Date('2026-07-15T00:00:00Z');
  assert.equal(store.countRetired(30).purgeable, 2, 'the lapsed and rejected rows are both past the window');

  assert.equal(store.purgeRetired(30), 2);
  const remaining = store.list({ status: 'all', includeDeleted: true }).map((row) => row.status);
  // `disabled` survives: it is an operator decision, not a verdict the pool
  // can withdraw, and re-enabling it is documented behaviour.
  assert.deepEqual(remaining.sort(), ['active', 'disabled']);
  store.close();
});

test('a purged row leaves no dangling history behind', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-purge-')), 'accounts.db');
  const store = new AccountStore({ dbPath, now: clock.now });
  store.importRecords([record({ account: 'gone', expires_at: '2026-05-01' })]);
  store.expireDue();
  assert.ok(store.history(1).length > 0, 'the expiry wrote an event');
  clock.current = new Date('2026-08-01T00:00:00Z');
  assert.equal(store.purgeRetired(30), 1);

  const raw = new AccountStore({ dbPath, readOnly: true });
  // The event table is the only place a password was never written, but a
  // surviving event would still name a row that no longer exists.
  assert.equal(raw.history(1).length, 0);
  raw.close();
  store.close();
});

test('a purge is all-or-nothing', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const store = new AccountStore({ dbPath: ':memory:', now: clock.now });
  store.importRecords([record({ account: 'a', expires_at: '2026-05-01' }), record({ account: 'b', expires_at: '2026-05-02' })]);
  store.expireDue();
  clock.current = new Date('2026-08-01T00:00:00Z');
  const db = store['db'];
  const before = db.prepare('SELECT COUNT(*) AS total FROM pool_events').get().total;
  assert.ok(before > 0, 'the expiry wrote events to roll back');

  // Fail on the *second* row, after the first row's events and row are already
  // deleted inside the transaction. Dropping the table instead would throw in
  // the scan before `BEGIN` and prove nothing; this trigger is what makes the
  // test fail if the transaction is removed.
  db.exec(`CREATE TABLE purge_guard (deletes INTEGER NOT NULL);
           INSERT INTO purge_guard (deletes) VALUES (0);`);
  db.exec(`CREATE TRIGGER purge_fails_on_second_row
           BEFORE DELETE ON accounts
           BEGIN
             UPDATE purge_guard SET deletes = deletes + 1;
             SELECT RAISE(ABORT, 'boom') WHERE (SELECT deletes FROM purge_guard) > 1;
           END;`);
  // Two guard rows (the seeded one plus the first delete) is fine; the second
  // delete pushes the count past it and aborts mid-transaction.
  assert.throws(() => store.purgeRetired(30), /boom/);
  const rows = db.prepare('SELECT COUNT(*) AS total FROM accounts').get().total;
  const events = db.prepare('SELECT COUNT(*) AS total FROM pool_events').get().total;
  assert.equal(rows, 2, 'both rows survived: the first delete was rolled back');
  assert.equal(events, before, 'both rows kept their events');
  store.close();
});

test('the once-per-window sweep runs at most once and is skipped by read-only stores', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-sweep-')), 'accounts.db');
  const store = new AccountStore({ dbPath, now: clock.now });
  store.importRecords([record({ account: 'x', expires_at: '2026-05-01' })]);
  store.expireDue();
  clock.current = new Date('2026-07-10T00:00:00Z');

  assert.equal(store.sweepRetired(30), 1, 'the first read past the window erases');
  assert.equal(store.sweepRetired(30), 0, 'a second read inside the window is a no-op');

  const readOnly = new AccountStore({ dbPath, readOnly: true, now: clock.now });
  clock.current = new Date('2026-09-01T00:00:00Z');
  assert.equal(readOnly.sweepRetired(30), 0, 'a preview never erases');
  readOnly.close();
  store.close();
});

test('a --days 0 purge keeps the rows and does not sweep on its own report', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-purge-zero-'));
  const dbPath = path.join(dir, 'accounts.db');
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const seed = new AccountStore({ dbPath, now: clock.now });
  seed.importRecords([record({ account: 'lapsed', expires_at: '2026-05-01' })]);
  seed.expireDue();
  seed.close();

  // Long past the default window: an ordinary read here would erase the row.
  const out = [];
  const code = await runAccountsCommand(['accounts', 'purge', '--days', '0'], {
    cwd: dir,
    env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath },
    now: () => new Date('2026-12-01T00:00:00Z'),
    io: { writeStdout: (text) => out.push(text), writeStderr: () => {} }
  });
  assert.equal(code, 0);
  const payload = JSON.parse(out.join(''));
  assert.equal(payload.erased, 0);
  assert.equal(payload.stats.total, 1, 'the report must not sweep with the default window');

  const after = new AccountStore({ dbPath, readOnly: true, now: () => new Date('2026-12-01T00:00:00Z') });
  assert.equal(after.list({ status: 'all', includeDeleted: true }).length, 1, 'the row is still there');
  after.close();
});

test('retention 0 keeps retired rows, and a negative window is refused', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  // The environment is the switch, because a read is what runs the sweep: a
  // caller passing 0 to one method would still lose the rows to the next read.
  const store = new AccountStore({
    dbPath: ':memory:',
    now: clock.now,
    env: { AUTOVPN_ACCOUNT_RETIRED_RETENTION_DAYS: '0' }
  });
  store.importRecords([record({ account: 'x', expires_at: '2026-05-01' })]);
  store.expireDue();
  clock.current = new Date('2030-01-01T00:00:00Z');
  assert.equal(store.purgeRetired(0), 0);
  assert.equal(store.purgeRetired(-5), 0);
  const rows = store.list({ status: 'all', includeDeleted: true });
  assert.equal(rows.length, 1, 'a read with retention 0 keeps the retired row');
  assert.equal(rows[0].status, 'expired');
  store.close();
});

test('the retention window comes from the environment and defaults to 30 days', async () => {
  const { retiredRetentionDays } = await import('../../dist/pool/account-store.js');
  assert.equal(retiredRetentionDays({}), 30);
  assert.equal(retiredRetentionDays({ AUTOVPN_ACCOUNT_RETIRED_RETENTION_DAYS: '7' }), 7);
  assert.equal(retiredRetentionDays({ AUTOVPN_ACCOUNT_RETIRED_RETENTION_DAYS: '0' }), 0);
  assert.equal(retiredRetentionDays({ AUTOVPN_ACCOUNT_RETIRED_RETENTION_DAYS: 'nonsense' }), 30);
  assert.equal(retiredRetentionDays({ AUTOVPN_ACCOUNT_RETIRED_RETENTION_DAYS: '-1' }), 30);
});

test('reading the pool is what triggers the sweep, so no daemon is required', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-maintain-')), 'accounts.db');
  const env = { VPN_AUTOMATION_ACCOUNTS_DB: dbPath, AUTOVPN_ACCOUNT_RETIRED_RETENTION_DAYS: '30' };
  const store = new AccountStore({ dbPath, env, now: clock.now });
  store.importRecords([record({ account: 'x', expires_at: '2026-05-01' })]);
  store.expireDue();
  assert.equal(store.stats().total, 1, 'the row is still there before the window passes');

  clock.current = new Date('2026-07-10T00:00:00Z');
  // A plain reader — the UI snapshot, `accounts list`, a run checking the pool —
  // is what does the erasing. No timer anywhere.
  const reader = new AccountStore({ dbPath, env, now: clock.now });
  const stats = reader.stats();
  assert.equal(stats.total, 0, 'the retired row is gone after a plain read');
  reader.close();
  store.close();
});

test('a live row is never purged, no matter how old its credential is', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const store = new AccountStore({ dbPath: ':memory:', now: clock.now });
  store.importRecords([record({ account: 'x', expires_at: '2030-01-01' })]);
  store.lease('leiting');
  clock.current = new Date('2030-06-01T00:00:00Z');
  // Only rows already retired carry a `deleted_at`, and only those are ever
  // erased. An account nobody has retired stays until its date lapses.
  assert.equal(store.purgeRetired(3650), 0);
  assert.equal(store.list({ status: 'all', includeDeleted: true }).length, 1);
  // Once the lapse sweep retires it, the window starts from that moment.
  store.expireDue();
  assert.equal(store.purgeRetired(30), 0, 'the window runs from the retirement, not the lease');
  clock.current = new Date('2030-08-01T00:00:00Z');
  assert.equal(store.purgeRetired(30), 1);
  store.close();
});

test('a purge leaves no password bytes behind in the file', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-purge-bytes-')), 'accounts.db');
  const store = new AccountStore({ dbPath, now: clock.now });
  store.importRecords([
    record({ account: 'one', password: 'SECRETONEsecret', expires_at: '2026-05-01' }),
    record({ account: 'two', password: 'SECRETTWOsecret', expires_at: '2026-05-02' })
  ]);
  store.expireDue();
  clock.current = new Date('2026-08-01T00:00:00Z');
  assert.equal(store.purgeRetired(30), 2);
  store.close();

  // `SELECT` returning nothing is not erasure: SQLite leaves the freed cell's
  // bytes in the page, so the credential is still in the file after a plain
  // DELETE. `secure_delete` is what makes the promise real.
  const bytes = fs.readFileSync(dbPath);
  assert.equal(bytes.includes(Buffer.from('SECRETONEsecret')), false, 'the first password is still on disk');
  assert.equal(bytes.includes(Buffer.from('SECRETTWOsecret')), false, 'the second password is still on disk');
});

test('an absurd retention window is clamped instead of breaking every read', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const store = new AccountStore({
    dbPath: ':memory:',
    now: clock.now,
    env: { AUTOVPN_ACCOUNT_RETIRED_RETENTION_DAYS: '1000000000' }
  });
  store.importRecords([record({ account: 'a', expires_at: '2030-01-01' })]);
  // `days * 86_400_000` overflows Date's range and toISOString throws; because
  // the sweep hangs off every read, that would take the whole pool down.
  assert.equal(store.purgeRetired(1e12), 0);
  assert.deepEqual(store.countRetired(1e12), { purgeable: 0, pendingLapse: 0 });
  assert.equal(store.stats().total, 1, 'a read still works with an absurd window');
  assert.equal(retiredRetentionDays({ AUTOVPN_ACCOUNT_RETIRED_RETENTION_DAYS: '1000000000' }), 36500);
  store.close();
});

test('housekeeping never fails a read on a pool it cannot write', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-purge-ro-')), 'accounts.db');
  const writer = new AccountStore({ dbPath, now: clock.now });
  writer.importRecords([record({ account: 'live', expires_at: '2030-01-01' })]);
  writer.close();

  fs.chmodSync(dbPath, 0o444);
  try {
    const reader = new AccountStore({ dbPath, now: clock.now });
    // The retention sweep cannot write here; the listing must still answer,
    // because `serve` and the desktop panel read through this path.
    assert.equal(reader.stats().total, 1);
    assert.equal(reader.list().length, 1);
    reader.close();
  } finally {
    fs.chmodSync(dbPath, 0o644);
  }
});

test('a row renewed before the sweep reaches it survives', () => {
  const clock = mutableClock(new Date('2026-06-01T00:00:00Z'));
  const store = new AccountStore({ dbPath: ':memory:', now: clock.now });
  store.importRecords([record({ account: 'renew', password: 'old', expires_at: '2026-05-01' })]);
  store.expireDue();
  clock.current = new Date('2026-08-01T00:00:00Z');
  // The operator re-imports with a fresh date and password. The sweep scans
  // and deletes inside one write lock, and the delete re-checks the predicate,
  // so a renewal cannot be erased by a scan that predates it.
  const outcome = store.importRecords([record({ account: 'renew', password: 'new', expires_at: '2027-01-01' })]);
  assert.equal(outcome.revived, 1);
  assert.equal(store.sweepRetired(30), 0, 'nothing is erased');
  const rows = store.list({ status: 'all', includeDeleted: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'active');
  store.close();
});
