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
    resolve: async (hostname) => { resolved.push(hostname); return [{ address: '2606:4700:4700::1001', family: 6 }, { address: '1.1.1.8', family: 4 }]; },
    fetch: async () => response(200, { success: true, country_code: 'JP' })
  });
  assert.equal(await lookup('node.example'), 'JP');
  assert.deepEqual(resolved, ['node.example']);
});

test('tries resolved addresses in stable order until one has a country', async () => {
  const requested = [];
  const lookup = createGeoIpLookup({
    resolve: async () => [
      { address: '10.0.0.8', family: 4 },
      { address: '1.1.1.31', family: 4 },
      { address: '2606:4700:4700::1031', family: 6 }
    ],
    fetch: async (url) => {
      requested.push(url);
      if (url.includes('1.1.1.31')) return response(503, {});
      if (url.includes('2606%3A4700%3A4700%3A%3A1031')) return response(200, { success: true, country_code: 'CA' });
      return response(503, {});
    }
  });
  assert.equal(await lookup('multi.example'), 'CA');
  assert.equal(requested.some((url) => url.includes('10.0.0.8')), false);
  assert.deepEqual(requested.map((url) => new URL(url).hostname), ['ipwho.is', 'ipapi.co', 'ipwho.is']);
});

test('honors bounded Retry-After before using fallback provider', async () => {
  const sleeps = [];
  let calls = 0;
  const lookup = createGeoIpLookup({
    now: () => 0,
    fetch: async () => ++calls === 1
      ? response(429, {}, { 'retry-after': '30' })
      : response(200, { country_code: 'SG' }),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    maxRetryAfterMs: 1500
  });
  assert.equal(await lookup('1.1.1.10'), 'SG');
  assert.deepEqual(sleeps, [1500]);
});

test('bounds concurrent provider requests across many unique IPs', async () => {
  let active = 0;
  let maximum = 0;
  const releases = [];
  const lookup = createGeoIpLookup({
    providerConcurrency: 4,
    fetch: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return response(200, { success: true, country_code: 'CA' });
    }
  });
  const pending = Array.from({ length: 12 }, (_, index) => lookup(`8.8.4.${index + 1}`));
  while (releases.length < 4) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 4);
  while (releases.length) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await Promise.all(pending), Array(12).fill('CA'));
  assert.equal(maximum, 4);
});

test('shares Retry-After cooldown with queued unique-IP lookups and then recovers', async () => {
  let currentTime = 0;
  const sleeps = [];
  const requested = [];
  let calls = 0;
  const lookup = createGeoIpLookup({
    providerConcurrency: 1,
    now: () => currentTime,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); currentTime += milliseconds; },
    fetch: async (url) => {
      requested.push(url);
      calls += 1;
      if (calls === 1) return response(429, {}, { 'retry-after': '1' });
      return response(200, url.includes('ipwho.is')
        ? { success: true, country_code: 'JP' }
        : { country_code: 'SG' });
    }
  });
  assert.deepEqual(await Promise.all([lookup('8.8.8.1'), lookup('8.8.8.2')]), ['SG', 'JP']);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(requested.map((url) => new URL(url).hostname), ['ipwho.is', 'ipwho.is', 'ipapi.co']);
  assert.equal(await lookup('8.8.8.3'), 'JP');
});

test('parses HTTP-date Retry-After using the injected clock and clamps it', async () => {
  const sleeps = [];
  let calls = 0;
  const now = Date.parse('2026-07-12T00:00:00.000Z');
  const lookup = createGeoIpLookup({
    now: () => now,
    fetch: async () => ++calls === 1
      ? response(429, {}, { 'retry-after': 'Sun, 12 Jul 2026 00:00:10 GMT' })
      : response(200, { country_code: 'SG' }),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    maxRetryAfterMs: 1200
  });
  assert.equal(await lookup('1.1.1.32'), 'SG');
  assert.deepEqual(sleeps, [1200]);
});

test('rejects unsafe provider builder URLs without fetching them', async () => {
  for (const unsafeUrl of ['http://ipwho.is/1.1.1.1', 'https://evil.example/1.1.1.1']) {
    let calls = 0;
    const lookup = createGeoIpLookup({
      primaryUrl: () => unsafeUrl,
      fallbackUrl: () => unsafeUrl,
      fetch: async () => { calls += 1; return response(200, { success: true, country_code: 'US' }); }
    });
    assert.equal(await lookup('1.1.1.1'), 'US');
    assert.equal(calls, 0);
  }
});

test('rejects malformed primary schema and falls back', async () => {
  let calls = 0;
  const lookup = createGeoIpLookup({
    fetch: async () => ++calls === 1
      ? response(200, { success: true, country_code: 'Australia' })
      : response(200, { country_code: 'NZ' })
  });
  assert.equal(await lookup('1.1.1.11'), 'NZ');
});

test('rejects alphabetic non-ISO provider country codes and falls back to US', async () => {
  let calls = 0;
  const lookup = createGeoIpLookup({
    fetch: async () => ++calls === 1
      ? response(200, { success: true, country_code: 'QQ' })
      : response(200, { country_code: 'XX' })
  });
  assert.equal(await lookup('1.1.1.14'), 'US');
  assert.equal(calls, 2);
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
  assert.equal(await lookup('1.1.1.12'), 'GB');
});

test('falls back to US on dual failure and uses a short negative cache TTL', async () => {
  let now = 0;
  let calls = 0;
  const lookup = createGeoIpLookup({
    fetch: async () => { calls += 1; return response(503, {}); },
    now: () => now,
    negativeTtlMs: 100
  });
  assert.equal(await lookup('1.1.1.13'), 'US');
  assert.equal(await lookup('1.1.1.13'), 'US');
  assert.equal(calls, 2);
  now = 101;
  assert.equal(await lookup('1.1.1.13'), 'US');
  assert.equal(calls, 4);
});

test('deduplicates concurrent provider requests by resolved IP', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const lookup = createGeoIpLookup({
    resolve: async () => [{ address: '1.1.1.20', family: 4 }],
    fetch: async () => { calls += 1; await gate; return response(200, { success: true, country_code: 'FR' }); }
  });
  const first = lookup('one.example');
  const second = lookup('two.example');
  await Promise.resolve();
  release();
  assert.deepEqual(await Promise.all([first, second]), ['FR', 'FR']);
  assert.equal(calls, 1);
});

test('canonicalizes equivalent native IPv6 spellings for inflight and positive cache keys', async () => {
  const variants = [
    '2606:4700:4700::abcd',
    '2606:4700:4700:0:0:0:0:ABCD',
    '2606:4700:4700:0000:0000:0000:0000:abcd'
  ];
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const lookup = createGeoIpLookup({
    fetch: async (url) => {
      calls += 1;
      assert.match(url, /2606%3A4700%3A4700%3A%3Aabcd/);
      await gate;
      return response(200, { success: true, country_code: 'DE' });
    }
  });
  const pending = variants.map((address) => lookup(address));
  await Promise.resolve();
  release();
  assert.deepEqual(await Promise.all(pending), ['DE', 'DE', 'DE']);
  assert.equal(calls, 1);
  for (const address of variants) assert.equal(await lookup(address), 'DE');
  assert.equal(calls, 1);
});

test('falls back to US for empty addresses and resolver failure', async () => {
  const lookup = createGeoIpLookup({ resolve: async () => { throw new Error('dns'); }, fetch: async () => { throw new Error('unused'); } });
  assert.equal(await lookup(''), 'US');
  assert.equal(await lookup('missing.example'), 'US');
});

test('rejects non-global IPv4 and IPv6 addresses without provider fetches', async () => {
  const rejected = [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '2001::1', '2001:db8::1', '3fff::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.0.2.1'
  ];
  let fetches = 0;
  const lookup = createGeoIpLookup({ fetch: async () => { fetches += 1; return response(200, { success: true, country_code: 'US' }); } });
  for (const address of rejected) assert.equal(await lookup(address), 'US', address);
  assert.equal(fetches, 0);
});

test('allows globally routable IPv4 and IPv6 addresses', async () => {
  const requested = [];
  const lookup = createGeoIpLookup({
    fetch: async (url) => { requested.push(url); return response(200, { success: true, country_code: 'AU' }); }
  });
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(await lookup(address), 'AU', address);
  }
  assert.equal(requested.length, 4);
});
