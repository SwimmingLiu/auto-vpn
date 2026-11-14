import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountStore } from '../../dist/pool/account-store.js';
import { normalizeBrand, brandFromSite, BRANDS } from '../../dist/pool/brands.js';
import { parseAccountCsv, parseLegacyAccountFile, parseAccountFile, stringifyCsv, normalizeExpiry, normalizeStatus } from '../../dist/pool/csv.js';

function tempStore(nowIso = '2026-11-09T00:00:00Z') {
  return new AccountStore({ dbPath: ':memory:', now: () => new Date(nowIso) });
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

test('a brand is resolved from every spelling a profile or a file may use', () => {
  for (const value of ['leiting', '雷霆', '雷霆加速器', 'LT', 'www.68123836.com', '雷霆加速器 #12', 'leiting_ios']) {
    assert.equal(normalizeBrand(value), 'leiting', value);
  }
  assert.equal(normalizeBrand('xuanfeng-area'), 'xuanfeng');
  assert.equal(normalizeBrand('xuanfeng-all-area'), 'xuanfeng');
  assert.equal(normalizeBrand('旋风加速器'), 'xuanfeng');
  assert.equal(normalizeBrand('blackhole'), 'heidong');
  assert.equal(normalizeBrand('unknown-brand'), null);
  assert.equal(normalizeBrand(''), null);
  assert.equal(brandFromSite('https://www.16863988.com/login'), 'xuanfeng');
  assert.equal(brandFromSite('www.86933221.com'), 'mifeng');
  assert.equal(brandFromSite('https://elsewhere.example'), null);
  assert.equal(BRANDS.length, 4);
});

test('the CSV reader handles quotes, embedded commas and CRLF', () => {
  const text = 'brand,account,password\r\n'
    + 'leiting,"user,1","pa""ss"\r\n'
    + 'heidong,solo,"multi\nline"\r\n';
  const parsed = parseAccountCsv(text);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].account, 'user,1');
  assert.equal(parsed.records[0].password, 'pa"ss');
  assert.equal(parsed.records[1].password, 'multi\nline');
});

test('the CSV reader accepts Chinese headers and rejects a row with no header', () => {
  const parsed = parseAccountCsv('品牌,账号,密码\n雷霆,a1,p1\n');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].brand, 'leiting');
  const wrong = parseAccountCsv('name,value\na,b\n');
  assert.equal(wrong.records.length, 0);
  assert.match(wrong.issues[0].message, /header is missing/);
});

test('a missing header never echoes the first row back, so a password cannot leak', () => {
  // A password-manager export whose first line is data, not a header: the
  // rejected file must not quote that line, because one of its cells is the
  // password and the message reaches stdout, JSON and the panel.
  const wrong = parseAccountCsv('leiting,alice,S3cretCellPw,https://x.example,,active,\n');
  assert.equal(wrong.records.length, 0);
  assert.equal(wrong.issues.length, 1);
  assert.doesNotMatch(wrong.issues[0].message, /S3cretCellPw/);
  assert.doesNotMatch(wrong.issues[0].message, /alice/);
  // A header that recognises some columns names them, still without echoing.
  const partial = parseAccountCsv('brand,account,token\nleiting,alice,S3cretCellPw\n');
  assert.equal(partial.records.length, 0);
  assert.match(partial.issues[0].message, /missing password/);
  assert.match(partial.issues[0].message, /recognised columns: brand, account/);
  assert.doesNotMatch(partial.issues[0].message, /S3cretCellPw/);
});

test('bad rows are reported and skipped without losing the good ones', () => {
  const parsed = parseAccountCsv([
    'brand,account,password,official_site,expires_at,status',
    'leiting,ok,pass,,2026-12-31,active',
    'nope,ok,pass,,,',
    'leiting,,pass,,,',
    'heidong,bad-date,pass,,31/31/2026,',
    'mifeng,bad-status,pass,,,whenever',
    'leiting,other-brand,pass,https://www.16863988.com,,',
    ''
  ].join('\n'));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].account, 'ok');
  assert.equal(parsed.issues.length, 5);
  assert.deepEqual(parsed.issues.map((issue) => issue.line), [3, 4, 5, 6, 7]);
});

test('optional columns fall back to the brand site and active status', () => {
  const parsed = parseAccountCsv('brand,account,password\nleiting,a1,p1\n');
  assert.deepEqual(parsed.records[0], {
    brand: 'leiting',
    account: 'a1',
    password: 'p1',
    official_site: 'https://www.68123836.com',
    expires_at: '',
    status: 'active',
    note: ''
  });
});

test('expiry and status accept the spellings a spreadsheet produces', () => {
  assert.equal(normalizeExpiry('2026/1/5'), '2026-01-05');
  assert.equal(normalizeExpiry('2026-01-05 00:00:00'), '2026-01-05');
  assert.equal(normalizeExpiry(''), '');
  assert.equal(normalizeExpiry('2026-02-31'), null);
  assert.equal(normalizeExpiry('soon'), null);
  assert.equal(normalizeStatus('正常'), 'active');
  assert.equal(normalizeStatus('停用'), 'disabled');
  assert.equal(normalizeStatus('密码错误'), 'invalid');
  assert.equal(normalizeStatus(''), 'active');
  assert.equal(normalizeStatus('someday'), null);
});

test('the legacy account file is read with its index-suffixed headings', () => {
  const parsed = parseLegacyAccountFile([
    '[雷霆加速器]',
    '官网：https://www.68123836.com',
    '账号: a1',
    '密码: p1',
    '',
    '[旋风加速器 #2]',
    '官网：https://www.16863988.com',
    '账号：a2',
    '密码：p2',
    ''
  ].join('\n'));
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.records.map((item) => [item.brand, item.account, item.password]), [
    ['leiting', 'a1', 'p1'],
    ['xuanfeng', 'a2', 'p2']
  ]);
});

test('the format is detected from the first meaningful line', () => {
  assert.equal(parseAccountFile('[雷霆加速器]\n账号: a\n密码: p\n').records.length, 1);
  assert.equal(parseAccountFile('brand,account,password\nleiting,a,p\n').records.length, 1);
  assert.equal(parseAccountFile('brand,account,password\nleiting,a,p\n', 'legacy').records.length, 0);
});

test('a re-import updates, rotates and revives without duplicating', () => {
  const store = tempStore();
  const first = store.importRecords([record()]);
  assert.deepEqual([first.inserted, first.updated, first.rotated, first.revived], [1, 0, 0, 0]);
  const same = store.importRecords([record()]);
  assert.equal(same.unchanged, 1);
  const rotated = store.importRecords([record({ password: 'pass-2' })]);
  assert.deepEqual([rotated.updated, rotated.rotated], [1, 1]);
  store.markInvalid(1, 'login rejected');
  assert.equal(store.list().length, 0);
  const revived = store.importRecords([record({ password: 'pass-3' })]);
  assert.deepEqual([revived.revived, revived.rotated], [1, 1]);
  assert.equal(store.stats().total, 1);
  assert.equal(store.stats().active, 1);
  assert.equal(store.exportRecords()[0].password, 'pass-3');
  store.close();
});

test('an account past its expiry date is retired before the next read', () => {
  const store = tempStore('2026-11-09T00:00:00Z');
  store.importRecords([record({ account: 'soon', expires_at: '2026-11-01' }), record({ account: 'later', expires_at: '2027-01-01' })]);
  const rows = store.list({ brand: 'leiting' });
  assert.deepEqual(rows.map((row) => [row.account_masked.slice(0, 2), row.status]), [['la', 'active']]);
  const stats = store.stats();
  assert.equal(stats.expired, 1);
  assert.equal(stats.active, 1);
  assert.equal(store.lease('leiting')?.account, 'later');
  store.close();
});

test('the pool hands out least-recently-used accounts first', () => {
  const store = tempStore();
  store.importRecords([record({ account: 'a1' }), record({ account: 'a2' })]);
  assert.equal(store.lease('leiting')?.account, 'a1');
  assert.equal(store.lease('leiting')?.account, 'a2');
  assert.equal(store.lease('leiting')?.account, 'a1');
  assert.equal(store.lease('heidong'), null);
  store.close();
});

test('a login rejection retires the row, an outage does not', () => {
  const store = tempStore();
  store.importRecords([record({ account: 'a1' }), record({ account: 'a2' }), record({ account: 'a3' })]);
  store.markSuccess(1);
  store.markInvalid(1, 'login rejected');
  const rows = store.list({ includeDeleted: true });
  const byAccount = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byAccount.get(1).status, 'invalid');
  assert.equal(byAccount.get(1).deleted, true);
  assert.equal(byAccount.get(1).success_count, 1);
  assert.equal(byAccount.get(2).status, 'active');
  // The other rows keep their place in rotation.
  assert.deepEqual([store.lease('leiting')?.account, store.lease('leiting')?.account], ['a2', 'a3']);
  store.close();
});

test('operator disable and enable work by id and by credentials', () => {
  const store = tempStore();
  store.importRecords([record({ account: 'a1' }), record({ account: 'a2' })]);
  assert.equal(store.disable('leiting', 'a1'), true);
  assert.equal(store.list().length, 1);
  assert.equal(store.enableById(1), true);
  assert.equal(store.list().length, 2);
  assert.equal(store.disableById(999), false);
  assert.equal(store.disable('leiting', 'missing'), false);
  store.close();
});

test('no listing or snapshot carries a password', () => {
  const store = tempStore();
  store.importRecords([record({ account: 'visible-account', password: 'super-secret' })]);
  const serialized = JSON.stringify({ list: store.list({ includeDeleted: true }), stats: store.stats() });
  assert.doesNotMatch(serialized, /super-secret/);
  assert.doesNotMatch(serialized, /visible-account/);
  assert.match(serialized, /vi\*{6}nt/);
  store.close();
});

test('a lease is the only shape that carries the password', () => {
  const store = tempStore();
  store.importRecords([record()]);
  const leased = store.lease('leiting');
  assert.equal(leased.password, 'pass-1');
  assert.equal(leased.use_count, 1);
  store.close();
});

test('the exported CSV round-trips through the importer', () => {
  const store = tempStore();
  store.importRecords([record({ account: 'a,1', note: 'quoted "note"' }), record({ account: 'a2', expires_at: '2027-01-01' })]);
  const csv = stringifyCsv(store.exportRecords());
  const parsed = parseAccountCsv(csv);
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.records.map((item) => [item.account, item.password, item.note]), [
    ['a,1', 'pass-1', 'quoted "note"'],
    ['a2', 'pass-1', '']
  ]);
  store.close();
});

test('the pool survives reopening the same database file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-'));
  const dbPath = path.join(dir, 'accounts.db');
  const first = new AccountStore({ dbPath });
  first.importRecords([record()]);
  first.close();
  const second = new AccountStore({ dbPath });
  assert.equal(second.stats().total, 1);
  assert.equal(second.lease('leiting')?.password, 'pass-1');
  second.close();
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
});
test('the WAL and SHM sidecars are owner-only too, not just the main file', () => {
  // `chmod` on accounts.db alone left `-wal` at the process umask, and the WAL
  // holds plaintext credentials while the pool is open.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-perm-'));
  const dbPath = path.join(dir, 'accounts.db');
  const store = new AccountStore({ dbPath });
  store.importRecords([record()]);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!fs.existsSync(file)) continue;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
  }
  store.close();
});

test('a read-only store previews an import without changing a row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-dry-'));
  const dbPath = path.join(dir, 'accounts.db');
  const writable = new AccountStore({ dbPath, now: () => new Date('2026-11-09T00:00:00Z') });
  writable.importRecords([record({ account: 'stale', expires_at: '2020-01-01' }), record({ account: 'fresh' })]);
  writable.close();

  // Capture the state through a read-only connection so the snapshot itself
  // cannot run the expiry sweep that the preview is being tested for.
  const snapshot = new AccountStore({ dbPath, readOnly: true, now: () => new Date('2026-11-09T00:00:00Z') });
  const before = snapshot.list({ status: 'all', includeDeleted: true });
  assert.equal(snapshot.stats().expired, 0, 'the sweep must be suppressed on a read-only store');
  snapshot.close();

  const preview = new AccountStore({ dbPath, readOnly: true, now: () => new Date('2026-11-09T00:00:00Z') });
  const outcome = preview.importRecords([record({ account: 'new-one' }), record({ account: 'fresh', password: 'rotated' })]);
  assert.equal(outcome.inserted, 1);
  assert.equal(outcome.updated, 1);
  assert.equal(outcome.rotated, 1);
  preview.close();

  const after = new AccountStore({ dbPath, readOnly: true });
  assert.deepEqual(after.list({ status: 'all', includeDeleted: true }), before);
  after.close();
});

test('the account CLI lists retired rows with --all and tightens an existing export', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-cli-'));
  const dbPath = path.join(dir, 'accounts.db');
  const store = new AccountStore({ dbPath, now: () => new Date('2026-11-09T00:00:00Z') });
  store.importRecords([record({ account: 'keep' }), record({ account: 'gone' })]);
  assert.equal(store.disable('leiting', 'gone', 'test'), true);

  const out = [];
  const io = { writeStdout: (text) => out.push(text), writeStderr: () => {} };
  const context = { cwd: dir, env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath }, io, store };

  // `--all` means "including retired": the default active-only filter must not
  // be combined with it, or the command returns nothing.
  out.length = 0;
  await runAccountsCommand(['accounts', 'list', '--all'], context);
  const all = JSON.parse(out.join(''));
  assert.equal(all.count, 2);
  assert.ok(all.accounts.some((row) => row.status === 'disabled'));

  out.length = 0;
  await runAccountsCommand(['accounts', 'list'], context);
  assert.equal(JSON.parse(out.join('')).count, 1);

  // An existing backup file must end up owner-only, not inherit its old mode.
  const backup = path.join(dir, 'backup.csv');
  fs.writeFileSync(backup, 'old', { mode: 0o644 });
  fs.chmodSync(backup, 0o644);
  out.length = 0;
  await runAccountsCommand(['accounts', 'export', '--file', backup], context);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(backup, 'utf8'), /brand,account,password/);
  store.close();
});

test('accounts import --dry-run previews without writing', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-dryrun-'));
  const dbPath = path.join(dir, 'accounts.db');
  const seed = new AccountStore({ dbPath, now: () => new Date('2026-11-09T00:00:00Z') });
  seed.importRecords([record({ account: 'stale', expires_at: '2020-01-01' })]);
  seed.close();

  const file = path.join(dir, 'in.csv');
  fs.writeFileSync(file, 'brand,account,password\nleiting,brand-new,pw\n', 'utf8');
  const out = [];
  const io = { writeStdout: (text) => out.push(text), writeStderr: () => {} };
  const code = await runAccountsCommand(['accounts', 'import', file, '--dry-run'], {
    cwd: dir, env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath }, io, now: () => new Date('2026-11-09T00:00:00Z')
  });
  assert.equal(code, 0);
  const payload = JSON.parse(out.join(''));
  assert.equal(payload.dry_run, true);
  assert.equal(payload.inserted, 1);

  const after = new AccountStore({ dbPath, readOnly: true, now: () => new Date('2026-11-09T00:00:00Z') });
  const rows = after.list({ status: 'all', includeDeleted: true });
  assert.equal(rows.length, 1, 'the preview must not insert the new row');
  assert.equal(rows[0].status, 'active', 'the preview must not run the expiry sweep');
  after.close();
});

test('a bare host without www still resolves to its brand', () => {
  // The cross-brand site guard exists to catch a row pointed at another
  // vendor's domain; a missing `www.` must not slip past it.
  assert.equal(brandFromSite('https://68123836.com'), 'leiting');
  assert.equal(brandFromSite('68123836.com'), 'leiting');
  assert.equal(brandFromSite('www.68123836.com:443'), 'leiting');
  assert.equal(brandFromSite('WWW.68123836.COM.'), 'leiting');
});

test('a ragged CSV row is reported instead of silently truncating a password', () => {
  // `leiting,alice,pa,ss` is an unquoted comma inside the password: taking the
  // first three cells would store `pa` and the next login would retire the account.
  const parsed = parseAccountCsv('brand,account,password\nleiting,alice,pa,ss\nleiting,ok,pw\n');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].account, 'ok');
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0].message, /4 cells but the header has 3/);
});

test('issue line numbers are physical lines, not row indices', () => {
  const text = [
    'brand,account,password',   // 1
    '',                                     // 2 blank
    'leiting,a1,pw',                        // 3
    '"leiting","a2","multi',                // 4 quoted newline
    'line"',
    'nope,a3,pw'                            // 6
  ].join('\n');
  const parsed = parseAccountCsv(text);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[1].password, 'multi\nline');
  assert.equal(parsed.issues.length, 1);
  assert.equal(parsed.issues[0].line, 6, 'the bad row starts on physical line 6');
});

test('the legacy reader applies the same cross-brand site guard', () => {
  const legacy = ['[旋风加速器 #1]', '官网：https://www.68123836.com', '账号：a1', '密码：pw', ''].join('\n');
  const parsed = parseAccountFile(legacy, 'legacy');
  assert.equal(parsed.records.length, 0);
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0].message, /official_site belongs to leiting, not xuanfeng/);
});

test('auto-detection skips a comment line before the first section', () => {
  const legacy = ['# snapshot 2026-11-09', '[雷霆加速器 #1]', '官网：https://www.68123836.com', '账号：a1', '密码：pw', ''].join('\n');
  const parsed = parseAccountFile(legacy);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].brand, 'leiting');
});

test('a 3-column re-import keeps a stored expiry and note instead of erasing them', () => {
  // The template advertises exactly this shape. Treating the empty optional
  // cells as "clear" would wipe the known expiry, so the row could never be
  // retired again.
  const store = tempStore('2026-11-09T00:00:00Z');
  store.importRecords([record({ account: 'a1', expires_at: '2027-05-01', note: '备用' })]);
  store.importRecords([record({ account: 'a1', password: 'rotated', expires_at: '', note: '' })]);
  const [row] = store.list({ status: 'all', includeDeleted: true });
  assert.equal(row.expires_at, '2027-05-01');
  assert.equal(row.note, '备用');
  assert.equal(row.status, 'active');
  store.close();
});

test('a re-import cannot revive an account whose membership date passed', () => {
  const store = tempStore('2026-11-09T00:00:00Z');
  store.importRecords([record({ account: 'a1', expires_at: '2026-01-01' })]);
  const outcome = store.importRecords([record({ account: 'a1', password: 'new-pw' })]);
  assert.equal(outcome.revived, 0);
  const [row] = store.list({ status: 'all', includeDeleted: true });
  assert.equal(row.status, 'expired');
  assert.equal(row.deleted, true);
  store.close();
});

test('an expiry date is normalized on write and a bad one is refused', () => {
  const store = tempStore('2026-11-09T00:00:00Z');
  store.importRecords([record({ account: 'a1' })]);
  const id = store.list({ status: 'all' })[0].id;
  assert.equal(store.setExpiryById(id, '2026/1/5'), true);
  const [normalized] = store.list({ status: 'all', includeDeleted: true });
  assert.equal(normalized.expires_at, '2026-01-05');
  // 2026-01-05 already passed, so the sweep retires it.
  assert.equal(normalized.status, 'expired');
  assert.equal(store.setExpiryById(id, 'next tuesday'), null);
  store.close();
});

test('enabling a lapsed account is refused instead of silently undone', () => {
  const store = tempStore('2026-11-09T00:00:00Z');
  store.importRecords([record({ account: 'a1', expires_at: '2026-01-01' })]);
  const id = store.list({ status: 'all', includeDeleted: true })[0].id;
  assert.equal(store.enableById(id), null);
  assert.equal(store.list({ status: 'all', includeDeleted: true })[0].status, 'expired');
  // Extending the date first makes it enableable.
  assert.equal(store.setExpiryById(id, '2027-01-01'), true);
  assert.equal(store.enableById(id), true);
  assert.equal(store.list({ status: 'all' })[0].status, 'active');
  store.close();
});

test('retired status filters imply includeDeleted, and a bad limit is a usage error', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-status-'));
  const dbPath = path.join(dir, 'accounts.db');
  const store = new AccountStore({ dbPath, now: () => new Date('2026-11-09T00:00:00Z') });
  store.importRecords([record({ account: 'live' }), record({ account: 'dead' })]);
  assert.equal(store.disable('leiting', 'dead', 'test'), true);

  const out = [];
  const io = { writeStdout: (text) => out.push(text), writeStderr: () => {} };
  await runAccountsCommand(['accounts', 'list', '--status', 'disabled'], { cwd: dir, env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath }, io, store });
  assert.equal(JSON.parse(out.join('')).count, 1, 'a retired status must not be filtered out by deleted_at');
  await assert.rejects(
    runAccountsCommand(['accounts', 'list', '--limit', 'Infinity'], { cwd: dir, env: { VPN_AUTOMATION_ACCOUNTS_DB: dbPath }, io, store }),
    /positive integer/
  );
  store.close();
});

test('Hong Kong, Taiwan and Macau routes survive the mainland filter', async () => {
  const { isChinaRoute } = await import('../../dist/pipeline/brand-protocol.js');
  // The vendor spells these `中国香港` / `中国台湾`; a bare `中国` rule dropped exactly
  // the routes the filter documents as kept.
  for (const [name, region] of [['香港 中国香港', '香港'], ['中国台湾', '中国台湾'], ['中国澳门', '澳门'], ['香港 HK', '香港 HK']]) {
    assert.equal(isChinaRoute({ name, region }), false, `${name} must be kept`);
  }
  for (const [name, region] of [['中国 上海', '中国 上海'], ['回国 专线', '回国 专线']]) {
    assert.equal(isChinaRoute({ name, region }), true, `${name} must be dropped`);
  }
});

test('accounts purge reports, previews, and erases retired rows', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-purge-'));
  const dbPath = path.join(dir, 'accounts.db');
  const seed = new AccountStore({ dbPath, now: () => new Date('2026-06-01T00:00:00Z') });
  seed.importRecords([
    record({ account: 'lapsed', expires_at: '2026-05-01' }),
    record({ account: 'fresh', expires_at: '2030-01-01' })
  ]);
  seed.close();

  const later = () => new Date('2026-08-01T00:00:00Z');
  const env = { VPN_AUTOMATION_ACCOUNTS_DB: dbPath };
  const run = async (argv) => {
    const out = [];
    const code = await runAccountsCommand(argv, { cwd: dir, env, io: { writeStdout: (text) => out.push(text), writeStderr: () => {} }, now: later });
    return { code, payload: JSON.parse(out.join('')) };
  };

  // An insert does not evaluate the date, so at this point the row is still
  // `active` and no read has retired it. The preview says so instead of
  // promising an erase the window cannot support: retiring it now would stamp
  // `deleted_at` with today, and the 30-day clock starts there.
  const dry = await run(['accounts', 'purge', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.equal(dry.payload.dry_run, true);
  assert.equal(dry.payload.would_erase, 0);
  assert.equal(dry.payload.pending_lapse, 1);
  assert.equal(dry.payload.erased, 0);
  // A preview writes nothing at all: not a purge, not even the lapse sweep.
  const afterDry = new AccountStore({ dbPath, readOnly: true, now: later });
  assert.deepEqual(afterDry.list({ status: 'all', includeDeleted: true }).map((row) => row.status), ['active', 'active']);
  afterDry.close();

  // The real run retires the lapse first (reporting it), and the row it just
  // retired is inside the window, so nothing is erased this time either.
  const first = await run(['accounts', 'purge']);
  assert.equal(first.code, 0);
  assert.equal(first.payload.lapsed, 1);
  assert.equal(first.payload.erased, 0);
  assert.equal(first.payload.retired_retention_days, 30);

  // A month later the same command erases it.
  const monthLater = async (argv) => {
    const out = [];
    const code = await runAccountsCommand(argv, {
      cwd: dir, env, io: { writeStdout: (text) => out.push(text), writeStderr: () => {} },
      now: () => new Date('2026-09-15T00:00:00Z')
    });
    return { code, payload: JSON.parse(out.join('')) };
  };
  const real = await monthLater(['accounts', 'purge']);
  assert.equal(real.code, 0);
  assert.equal(real.payload.erased, 1);
  assert.equal(real.payload.stats.total, 1, 'only the live row remains');

  const afterReal = new AccountStore({ dbPath, readOnly: true, now: later });
  const rows = afterReal.list({ status: 'all', includeDeleted: true });
  assert.deepEqual(rows.map((row) => row.status), ['active']);
  afterReal.close();
});

test('accounts purge refuses a window that is negative or not a whole day', async () => {
  const { runAccountsCommand } = await import('../../dist/cli/accounts-commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-pool-purge-bad-'));
  const run = (value) => runAccountsCommand(['accounts', 'purge', '--days', value], {
    cwd: dir,
    env: { VPN_AUTOMATION_ACCOUNTS_DB: path.join(dir, 'accounts.db') },
    io: { writeStdout: () => {}, writeStderr: () => {} }
  });
  // A bare `--days` (no value at all) would otherwise silently use the
  // environment default instead of the window the operator meant to type.
  await assert.rejects(
    () => runAccountsCommand(['accounts', 'purge', '--days'], {
      cwd: dir,
      env: { VPN_AUTOMATION_ACCOUNTS_DB: path.join(dir, 'accounts.db') },
      io: { writeStdout: () => {}, writeStderr: () => {} }
    }),
    /--days/
  );
  for (const value of ['-1', '1.5', 'soon', '', '2d']) {
    // A fractional window would have to be rounded somewhere anyway, and the
    // answer would not be the one the operator typed.
    await assert.rejects(() => run(value), /--days/, `--days ${JSON.stringify(value)} must be refused`);
  }
});
