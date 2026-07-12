import assert from 'node:assert/strict';
import test from 'node:test';

import { createGeoIpLookup } from '../../dist/pipeline/geoip.js';

function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

test('looks up IPv4 and caches a successful primary result', async () => {
  const calls = [];
  const lookup = createGeoIpLookup({
    fetch: async (url) => { calls.push(url); return response(200, { success: true, country_code: 'AU' }); }
  });
  assert.equal(await lookup('1.1.1.1'), 'AU');
  assert.equal(await lookup('1.1.1.1'), 'AU');
  assert.equal(calls.length, 1);
});

test('supports IPv6 literals', async () => {
  const calls = [];
  const lookup = createGeoIpLookup({
    fetch: async (url) => { calls.push(url); return response(200, { success: true, country_code: 'DE' }); }
  });
  assert.equal(await lookup('2001:4860:4860::8888'), 'DE');
  assert.match(calls[0], /2001%3A4860%3A4860%3A%3A8888/);
});

test('resolves domains using injected A and AAAA resolver results', async () => {
  const resolved = [];
  const lookup = createGeoIpLookup({
    resolve: async (hostname) => { resolved.push(hostname); return [{ address: '2001:db8::1', family: 6 }, { address: '203.0.113.8', family: 4 }]; },
    fetch: async () => response(200, { success: true, country_code: 'JP' })
  });
  assert.equal(await lookup('node.example'), 'JP');
  assert.deepEqual(resolved, ['node.example']);
});

test('honors bounded Retry-After before using fallback provider', async () => {
  const sleeps = [];
  let calls = 0;
  const lookup = createGeoIpLookup({
    fetch: async () => ++calls === 1
      ? response(429, {}, { 'retry-after': '30' })
      : response(200, { country_code: 'SG' }),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    maxRetryAfterMs: 1500
  });
  assert.equal(await lookup('203.0.113.10'), 'SG');
  assert.deepEqual(sleeps, [1500]);
});

test('rejects malformed primary schema and falls back', async () => {
  let calls = 0;
  const lookup = createGeoIpLookup({
    fetch: async () => ++calls === 1
      ? response(200, { success: true, country_code: 'Australia' })
      : response(200, { country_code: 'NZ' })
  });
  assert.equal(await lookup('203.0.113.11'), 'NZ');
});

test('times out primary requests and uses fallback', async () => {
  let calls = 0;
  const lookup = createGeoIpLookup({
    fetch: async (_url, init) => {
      calls += 1;
      if (calls > 1) return response(200, { country_code: 'GB' });
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
    clearTimeout: () => {}
  });
  assert.equal(await lookup('203.0.113.12'), 'GB');
});

test('returns ZZ on dual failure and uses a short negative cache TTL', async () => {
  let now = 0;
  let calls = 0;
  const lookup = createGeoIpLookup({
    fetch: async () => { calls += 1; return response(503, {}); },
    now: () => now,
    negativeTtlMs: 100
  });
  assert.equal(await lookup('203.0.113.13'), 'ZZ');
  assert.equal(await lookup('203.0.113.13'), 'ZZ');
  assert.equal(calls, 2);
  now = 101;
  assert.equal(await lookup('203.0.113.13'), 'ZZ');
  assert.equal(calls, 4);
});

test('deduplicates concurrent provider requests by resolved IP', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const lookup = createGeoIpLookup({
    resolve: async () => [{ address: '203.0.113.20', family: 4 }],
    fetch: async () => { calls += 1; await gate; return response(200, { success: true, country_code: 'FR' }); }
  });
  const first = lookup('one.example');
  const second = lookup('two.example');
  await Promise.resolve();
  release();
  assert.deepEqual(await Promise.all([first, second]), ['FR', 'FR']);
  assert.equal(calls, 1);
});

test('returns ZZ for empty addresses and resolver failure', async () => {
  const lookup = createGeoIpLookup({ resolve: async () => { throw new Error('dns'); }, fetch: async () => { throw new Error('unused'); } });
  assert.equal(await lookup(''), 'ZZ');
  assert.equal(await lookup('missing.example'), 'ZZ');
});
