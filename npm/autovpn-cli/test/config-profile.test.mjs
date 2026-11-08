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
