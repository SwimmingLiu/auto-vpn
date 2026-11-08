import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FingerprintStore, resolveFingerprintCacheDir } from '../../dist/pipeline/brand-cache.js';

const fingerprint = {
  apk_url: 'https://cdn.example/apks64/20261108_lt1.apk',
  package_name: 'com.leiting.lt1794098243',
  version_name: '3.17940.98243',
  cert_sha1: '0390D4D33CB1C0E52DEC94D26726249AF384D553',
  seed_domains: ['https://www.a.example:20000', 'https://www.b.example:20000'],
  protocol: 'v7',
  core_version: '5.12.1',
  lite_version: '5.29.4'
};

function tempStore(now = () => new Date('2026-11-08T00:00:00Z')) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-fp-'));
  return { store: new FingerprintStore({ cacheDir, now }), cacheDir };
}

test('a written fingerprint reads back unchanged', () => {
  const { store } = tempStore();
  store.write('雷霆', fingerprint);
  const loaded = store.read('雷霆');
  assert.equal(loaded?.package_name, fingerprint.package_name);
  assert.deepEqual(loaded?.seed_domains, fingerprint.seed_domains);
  assert.equal(loaded?.brand, '雷霆');
});

test('brands with non-ASCII names get distinct cache files', () => {
  const { store, cacheDir } = tempStore();
  store.write('雷霆', fingerprint);
  store.write('旋风', { ...fingerprint, package_name: 'com.network.xf893950854' });
  const files = fs.readdirSync(cacheDir).sort();
  assert.equal(files.length, 2);
  assert.notEqual(files[0], files[1]);
  assert.equal(store.read('雷霆')?.package_name, 'com.leiting.lt1794098243');
  assert.equal(store.read('旋风')?.package_name, 'com.network.xf893950854');
});

test('readFresh honours the trust window', () => {
  let current = new Date('2026-11-08T00:00:00Z');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-fp-'));
  const store = new FingerprintStore({ cacheDir, now: () => current, maxAgeMs: 60_000 });
  store.write('雷霆', fingerprint);

  assert.ok(store.readFresh('雷霆'));
  current = new Date('2026-11-08T00:01:30Z');
  assert.equal(store.readFresh('雷霆'), null);
  // A stale entry still carries the seeds, so `read` keeps working.
  assert.ok(store.read('雷霆'));
});

test('touch refreshes the verification time', () => {
  let current = new Date('2026-11-08T00:00:00Z');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-fp-'));
  const store = new FingerprintStore({ cacheDir, now: () => current, maxAgeMs: 60_000 });
  store.write('雷霆', fingerprint);
  current = new Date('2026-11-08T00:01:30Z');
  store.touch('雷霆');
  assert.ok(store.readFresh('雷霆'));
});

test('a corrupt cache file is treated as absent', () => {
  const { store, cacheDir } = tempStore();
  store.write('雷霆', fingerprint);
  for (const file of fs.readdirSync(cacheDir)) {
    fs.writeFileSync(path.join(cacheDir, file), '{not json', 'utf8');
  }
  assert.equal(store.read('雷霆'), null);
});

test('touch on a missing entry is a no-op', () => {
  const { store } = tempStore();
  assert.doesNotThrow(() => store.touch('不存在'));
});

test('the cache directory sits beside the profile under the runtime root', () => {
  assert.equal(
    resolveFingerprintCacheDir('/home/user/.auto-vpn'),
    path.join('/home/user/.auto-vpn', 'brand-fingerprints')
  );
});

test('a cache entry with malformed seed domains is rejected', () => {
  // A parseable but invalid entry used to reach `base.replace` and crash every
  // run before any network call, with no way to recover but deleting the file.
  const { store, cacheDir } = tempStore();
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'brand-x.json'), JSON.stringify({ brand: 'x', seed_domains: [12345] }), 'utf8');
  assert.equal(store.read('x'), null);
});

test('a cache entry missing a required field is rejected', () => {
  const { store, cacheDir } = tempStore();
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'brand-y.json'), JSON.stringify({ brand: 'y', seed_domains: ['https://a.example:20000'] }), 'utf8');
  assert.equal(store.read('y'), null);
});

test('clear drops the entry so the next run re-inspects', () => {
  const { store } = tempStore();
  store.write('雷霆', fingerprint);
  assert.ok(store.read('雷霆'));
  store.clear('雷霆');
  assert.equal(store.read('雷霆'), null);
});

test('clear on a missing entry is a no-op', () => {
  const { store } = tempStore();
  assert.doesNotThrow(() => store.clear('不存在'));
});

test('a write failure does not propagate', () => {
  // The cache is an optimisation; a read-only directory must not fail a run
  // that already holds a working fingerprint.
  const blocker = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-ro-'));
  const filePath = path.join(blocker, 'not-a-dir');
  fs.writeFileSync(filePath, 'x', 'utf8');
  const store = new FingerprintStore({ cacheDir: path.join(filePath, 'nested') });
  assert.doesNotThrow(() => store.write('雷霆', fingerprint));
  assert.equal(store.read('雷霆'), null);
});
