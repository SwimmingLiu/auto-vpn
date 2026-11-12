import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConfig,
  decodeSubscriptionPayload,
  parseVmess,
  toMihomoProxy
} from '../src/egress.mjs';

/** A real link from a published artifact, verbatim shape. */
const SAMPLE_LINK = 'vmess://eyJ2IjoyLCJwcyI6MjA5MiwiYWRkIjoiMjExLjc2LjE3Ny4xMCIsInBvcnQiOiIzMDAwMCIsImlkIjoiNDE4MDQ4YWYtYTI5My00Yjk5LTliMGMtOThjYTM1ODBkZDI0IiwiYWlkIjoiMCIsInNjeSI6Im5vbmUiLCJuZXQiOiJ3cyIsInR5cGUiOiJkdGxzIiwiaG9zdCI6Ind3dy41ODI2NDg0NC54eXoiLCJwYXRoIjoiL3BhdGgvMzIxOTEyMzMyMDAyIiwidGxzIjoidGxzIiwic25pIjoid3d3LjU4MjY0ODQ0Lnh5eiJ9';

test('decodes a base64 subscription payload into vmess links', () => {
  const body = Buffer.from(`${SAMPLE_LINK}\n${SAMPLE_LINK}\n`, 'utf8').toString('base64');
  const links = decodeSubscriptionPayload(body);
  assert.equal(links.length, 2);
  assert.ok(links[0].startsWith('vmess://'));
});

test('rejects the random bytes the worker returns for a wrong key', () => {
  // Exactly what a wrong `serect_key` produces: btoa() of random bytes. It is
  // valid base64 but never decodes to vmess links.
  const noise = Buffer.from([0x91, 0x23, 0x44, 0x1f, 0x00, 0x7a, 0xff, 0x10]).toString('base64');
  assert.deepEqual(decodeSubscriptionPayload(noise), []);
  assert.deepEqual(decodeSubscriptionPayload(''), []);
  assert.deepEqual(decodeSubscriptionPayload('not base64 at all!'), []);
});

test('parses a vmess payload without padding', () => {
  const payload = parseVmess(SAMPLE_LINK);
  assert.equal(payload.add, '211.76.177.10');
  assert.equal(payload.port, '30000');
  assert.equal(payload.net, 'ws');
  assert.equal(payload.tls, 'tls');
  assert.equal(payload.sni, 'www.58264844.xyz');
});

test('builds a mihomo proxy that skips certificate verification', () => {
  const { name, proxy } = toMihomoProxy(SAMPLE_LINK, 3);
  assert.equal(name, 'n3');
  assert.equal(proxy.type, 'vmess');
  assert.equal(proxy.server, '211.76.177.10');
  assert.equal(proxy.port, 30000);
  // The pool is served from bare IPs; a verified chain would drop most of it.
  assert.equal(proxy['skip-cert-verify'], true);
  assert.equal(proxy.servername, 'www.58264844.xyz');
  assert.deepEqual(proxy['ws-opts'], {
    path: '/path/321912332002',
    headers: { Host: 'www.58264844.xyz' }
  });
});

test('the egress listener is the port the CLI already defaults to', () => {
  const config = buildConfig([toMihomoProxy(SAMPLE_LINK, 0).proxy]);
  // `egress.ts` hardcodes http://127.0.0.1:7897 as its default upstream. If
  // this changes, the crawl silently goes direct and the whole pool is unused.
  assert.equal(config['mixed-port'], 7897);
  assert.equal(config['allow-lan'], false);
});

test('the proxy group is fallback, not url-test', () => {
  const config = buildConfig([toMihomoProxy(SAMPLE_LINK, 0).proxy, toMihomoProxy(SAMPLE_LINK, 1).proxy]);
  const group = config['proxy-groups'][0];
  // `url-test` re-ranks on latency every interval. The crawl would then change
  // exit IP mid-run, which is the single most suspicious thing an account can
  // do in front of a vendor's risk engine.
  assert.equal(group.type, 'fallback');
  assert.deepEqual(group.proxies, ['n0', 'n1']);
  assert.equal(group.interval, 120);
});

test('an empty pool degrades to a direct config, not a crash', () => {
  const config = buildConfig([]);
  assert.deepEqual(config.proxies, []);
  assert.deepEqual(config['proxy-groups'], [{ name: 'EGRESS', type: 'select', proxies: ['DIRECT'] }]);
  assert.deepEqual(config.rules, ['MATCH,EGRESS']);
});

test('a malformed link is skipped rather than aborting the whole pool', () => {
  const links = decodeSubscriptionPayload(Buffer.from([
    'vmess://not-valid-base64-json',
    SAMPLE_LINK
  ].join('\n')).toString('base64'));
  assert.equal(links.length, 2, 'decode keeps both lines; validation happens later');
  const entries = links.map((link, index) => {
    try {
      return toMihomoProxy(link, index);
    } catch {
      return null;
    }
  }).filter(Boolean);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].proxy.server, '211.76.177.10');
});

test('url-safe base64 payloads decode too', () => {
  const body = Buffer.from(`${SAMPLE_LINK}\n`).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  assert.equal(decodeSubscriptionPayload(body).length, 1);
});

test('a double-wrapped payload decodes', () => {
  // A share project whose `SUB` env var points at another worker returns the
  // inner body's text wrapped in base64 again. Callers cannot know the depth,
  // so the decoder peels until it sees links.
  const inner = Buffer.from(`${SAMPLE_LINK}\n`, 'utf8').toString('base64');
  const outer = Buffer.from(inner, 'utf8').toString('base64');
  const links = decodeSubscriptionPayload(outer);
  assert.equal(links.length, 1);
  assert.ok(links[0].startsWith('vmess://'));
});

test('random bytes from a wrong key never decode into links', () => {
  // 54 bytes of random data is what a wrong `serect_key` produces.
  const noise = Buffer.from(Array.from({ length: 54 }, (_, i) => (i * 37 + 11) % 256)).toString('base64');
  assert.deepEqual(decodeSubscriptionPayload(noise), []);
});
