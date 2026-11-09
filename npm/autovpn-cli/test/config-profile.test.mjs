import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { profileSummary } from '../dist/config/profile.js';

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
