import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { profilePayload, profileSummary, saveProfilePayload } from '../dist/config/profile.js';

function summaryFor(toml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-profile-'));
  const profilePath = path.join(root, 'profile.toml');
  fs.writeFileSync(profilePath, toml, 'utf8');
  return profileSummary(root, { VPN_AUTOMATION_PROFILE_PATH: profilePath });
}

test('a credential source without a key is still a configured source', () => {
  // The control-plane key is discovered from the APK, so the doctor check must
  // not require one; otherwise a healthy credential profile fails `doctor`.
  const summary = summaryFor(`
[sources.leiting]
mode = "credential"
enabled = true
official_site = "https://site.example"
account = "acct"
password = "pw"
`);
  const source = summary.sources.leiting;
  assert.equal(source.url, 'set');
  assert.equal(source.key, 'set');
  assert.equal(source.mode, 'credential');
});

test('a url source without a key is reported missing', () => {
  const summary = summaryFor(`
[sources.legacy]
enabled = true
url = "https://provider.example/list"
`);
  assert.equal(summary.sources.legacy.url, 'set');
  assert.equal(summary.sources.legacy.key, 'missing');
});

test('a canonical brand row wins over a legacy alias of the same vendor', () => {
  // Losing the canonical row would replace the configured site with a stale
  // alias copy, or let a legacy row's 10000-URL-round budget leak into
  // credential mode.
  const summary = summaryFor(`
[sources.xuanfeng]
mode = "credential"
official_site = "https://canonical.example"
max_iterations = 4

[sources.xuanfeng-all-area]
mode = "url"
url = "https://legacy.example/list"
key = "k"
max_iterations = 10000
`);
  const source = summary.sources.xuanfeng;
  assert.equal(source.mode, 'credential');
  assert.equal(source.url, 'set');
});

test('two alias rows for one vendor collapse without looping in the other\'s rounds', async () => {
  const { normalizeOfficialSources } = await import('../dist/config/profile.js');
  const out = normalizeOfficialSources({
    'xuanfeng-area': { mode: 'credential', official_site: 'https://a.example', max_iterations: 10000, min_iterations: 10000 },
    'xuanfeng-all-area': { mode: 'url', url: 'https://b.example', key: 'k', max_iterations: 10000 }
  });
  // The first alias is the surviving row, and its URL-mode floor is dropped.
  assert.equal(out.xuanfeng.official_site, 'https://a.example');
  assert.equal(out.xuanfeng.max_iterations, 10000);
  assert.equal(out.xuanfeng.min_iterations, 10000);
});

test('max_areas survives normalization because the credential flow still reads it', async () => {
  const { normalizeOfficialSources } = await import('../dist/config/profile.js');
  const out = normalizeOfficialSources({ leiting: { mode: 'credential', official_site: 'https://s.example', max_areas: 3 } });
  assert.equal(out.leiting.max_areas, 3);
});

test('backend_brand survives normalization so 黑洞 can read the 雷霆 data plane', async () => {
  const { normalizeOfficialSources } = await import('../dist/config/profile.js');
  const out = normalizeOfficialSources({
    heidong: { mode: 'credential', official_site: 'https://www.67986457.com', backend_brand: '雷霆' }
  });
  assert.equal(out.heidong.backend_brand, 'leiting');
  // The storefront's own row is untouched: the account pool still leases 黑洞.
  assert.equal(out.heidong.official_site, 'https://www.67986457.com');
});

test('an unknown or self-referential backend_brand is dropped', async () => {
  const { normalizeOfficialSources } = await import('../dist/config/profile.js');
  const out = normalizeOfficialSources({
    heidong: { mode: 'credential', official_site: 'https://www.67986457.com', backend_brand: 'not-a-vendor' },
    leiting: { mode: 'credential', official_site: 'https://www.68123836.com', backend_brand: 'leiting' }
  });
  assert.equal(out.heidong.backend_brand, undefined);
  assert.equal(out.leiting.backend_brand, undefined);
});

test('account_retry_limit survives normalization and a save on a redirected row', async () => {
  // A thin backend pool needs a wider hunt than the default 24 leases. The
  // operator sets it in the profile; a drawer save must not silently drop it
  // back to the default and re-break the source.
  const { normalizeOfficialSources, saveProfilePayload } = await import('../dist/config/profile.js');
  const row = {
    mode: 'credential',
    official_site: 'https://www.heidongm.com',
    backend_brand: 'leiting',
    account_retry_limit: 120,
    max_iterations: 1000,
    plateau_limit: 50
  };
  assert.equal(normalizeOfficialSources({ heidong: row }).heidong.account_retry_limit, 120);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-retry-limit-'));
  const profilePath = path.join(root, 'profile.toml');
  const env = { VPN_AUTOMATION_PROFILE_PATH: profilePath };
  saveProfilePayload(root, { sources: { heidong: row } }, env);
  const written = fs.readFileSync(profilePath, 'utf8');
  assert.match(written, /account_retry_limit = 120/);
  assert.match(written, /backend_brand = "leiting"/);
});

test('lap keys survive normalization and a save, and the legacy keys stay beside them', async () => {
  const { normalizeOfficialSources, saveProfilePayload } = await import('../dist/config/profile.js');
  const row = {
    mode: 'credential',
    official_site: 'https://s.example',
    max_laps: 50,
    dry_laps: 13,
    min_laps: 2,
    max_iterations: 1000,
    plateau_limit: 50,
    areas_per_round: 8,
    area_concurrency: 4,
    max_runtime_seconds: 900
  };
  const out = normalizeOfficialSources({ leiting: row });
  assert.equal(out.leiting.max_laps, 50);
  assert.equal(out.leiting.dry_laps, 13);
  assert.equal(out.leiting.min_laps, 2);
  // Nothing is deleted: the legacy policy must survive for a row that later
  // drops its lap keys, and daily-run.sh still rewrites max_runtime_seconds.
  assert.equal(out.leiting.max_iterations, 1000);
  assert.equal(out.leiting.plateau_limit, 50);
  assert.equal(out.leiting.areas_per_round, 8);
  assert.equal(out.leiting.max_runtime_seconds, 900);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-lap-save-'));
  const profilePath = path.join(root, 'profile.toml');
  const env = { VPN_AUTOMATION_PROFILE_PATH: profilePath };
  saveProfilePayload(root, { sources: { leiting: row } }, env);
  const written = fs.readFileSync(profilePath, 'utf8');
  assert.match(written, /max_laps = 50/);
  assert.match(written, /dry_laps = 13/);
  assert.match(written, /min_laps = 2/);
  assert.match(written, /areas_per_round = 8/);
  assert.match(written, /max_runtime_seconds = 900/);
  // A legacy row without lap keys is not converted on save.
  saveProfilePayload(root, { sources: { heidong: { mode: 'credential', official_site: 'https://h.example', max_iterations: 200 } } }, env);
  const legacyWritten = fs.readFileSync(profilePath, 'utf8');
  assert.doesNotMatch(legacyWritten, /max_laps|dry_laps|min_laps/);
});

test('the static-exit section defaults the twin mode and keeps addresses verbatim', () => {
  // A profile written before [static_exit] existed must not gain an empty
  // egress list: an absent address is what keeps the share Worker untouched.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-static-exit-'));
  const profilePath = path.join(root, 'profile.toml');
  const env = { VPN_AUTOMATION_PROFILE_PATH: profilePath };
  fs.writeFileSync(profilePath, '[deploy]\nproject_name = "sub-nodes"\n', 'utf8');

  saveProfilePayload(root, { deploy: { project_name: 'sub-nodes' } }, env);
  const written = fs.readFileSync(profilePath, 'utf8');
  assert.match(written, /\[static_exit\]/);
  assert.match(written, /twins = "entrance"/);
  assert.match(written, /exit = ""/);

  const summary = profileSummary(root, env);
  assert.equal(summary.static_exit.exit, 'missing');
  assert.equal(summary.static_exit.twins, 'entrance');

  const payload = profilePayload(root, env);
  assert.equal(payload.static_exit.exit, '');
});

test('the static-exit section keeps a configured address and rejects an unknown twin mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-static-exit-set-'));
  const profilePath = path.join(root, 'profile.toml');
  const env = { VPN_AUTOMATION_PROFILE_PATH: profilePath };

  saveProfilePayload(root, {
    static_exit: { exit: 'socks5://user:p%40ss@198.51.100.10:1080#香港静态IP', twins: 'nonsense' }
  }, env);

  const written = fs.readFileSync(profilePath, 'utf8');
  assert.match(written, /香港静态IP/);
  assert.match(written, /twins = "entrance"/);
  assert.equal(profileSummary(root, env).static_exit.exit, 'set');
});
