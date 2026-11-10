import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EgressSession,
  resolveEgressPolicy,
  classifyEgressFailure,
  isProxyUnreachable
} from '../../dist/pipeline/egress.js';

const okResponse = (text, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => text,
  body: { cancel: async () => {} }
});

test('the crawl defaults to the upstream proxy', () => {
  const policy = resolveEgressPolicy({});
  assert.equal(policy.mode, 'proxy');
  assert.equal(policy.proxyUrl, 'http://127.0.0.1:7897');
});

test('an explicit mode and url override the default', () => {
  assert.deepEqual(
    resolveEgressPolicy({ VPN_AUTOMATION_PROXY_MODE: 'direct', VPN_AUTOMATION_UPSTREAM_PROXY: 'http://127.0.0.1:1080' }),
    { mode: 'direct', proxyUrl: 'http://127.0.0.1:1080' }
  );
  assert.equal(resolveEgressPolicy({ VPN_AUTOMATION_PROXY_MODE: 'auto' }).mode, 'auto');
});

test('the legacy boolean still selects a transport', () => {
  assert.equal(resolveEgressPolicy({ VPN_AUTOMATION_USE_UPSTREAM_PROXY: '0' }).mode, 'direct');
  assert.equal(resolveEgressPolicy({ VPN_AUTOMATION_USE_UPSTREAM_PROXY: '1' }).mode, 'proxy');
  // The current mode knob wins over the legacy boolean.
  assert.equal(
    resolveEgressPolicy({ VPN_AUTOMATION_USE_UPSTREAM_PROXY: '0', VPN_AUTOMATION_PROXY_MODE: 'proxy' }).mode,
    'proxy'
  );
});

test('a disabled proxy url forces direct', () => {
  assert.deepEqual(
    resolveEgressPolicy({ VPN_AUTOMATION_UPSTREAM_PROXY: 'off' }),
    { mode: 'direct', proxyUrl: '' }
  );
});

test('standard proxy variables are a url fallback, not a mode switch', () => {
  const policy = resolveEgressPolicy({ HTTPS_PROXY: 'http://127.0.0.1:9999' });
  assert.equal(policy.mode, 'proxy');
  assert.equal(policy.proxyUrl, 'http://127.0.0.1:9999');
});

test('block classification reads status codes and body wording', () => {
  assert.equal(classifyEgressFailure({ status: 403 }), 'blocked');
  assert.equal(classifyEgressFailure({ status: 429 }), 'blocked');
  assert.equal(classifyEgressFailure({ status: 200, body: '您的IP已被封禁' }), 'blocked');
  assert.equal(classifyEgressFailure({ status: 200, body: 'Just a moment...' }), 'blocked');
  assert.equal(classifyEgressFailure({ status: 200, body: 'vmess://abc' }), 'fatal');
  assert.equal(classifyEgressFailure({ status: 404 }), 'transient');
  assert.equal(classifyEgressFailure({ error: new Error('connect ECONNRESET') }), 'transient');
});

test('proxy-unreachable is distinguished from a target failure', () => {
  assert.equal(isProxyUnreachable(new Error('connect ECONNREFUSED 127.0.0.1:7897')), true);
  assert.equal(isProxyUnreachable(new Error('UND_ERR_PROXY')), true);
  assert.equal(isProxyUnreachable(new Error('TLS handshake timeout')), false);
});

test('an injected fetch keeps the session off a real socket', async () => {
  const session = await EgressSession.open({}, { fetchImpl: async () => okResponse('hello') });
  assert.equal(session.transport, 'proxy');
  const result = await session.text('https://example.test/', 1000);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello');
  await session.close();
});

test('an unreachable proxy falls back to direct for the run', async () => {
  const seen = [];
  const session = await EgressSession.open(
    { VPN_AUTOMATION_PROXY_MODE: 'proxy' },
    {
      probe: async () => false,
      fetchImpl: async (url, init) => {
        seen.push(init?.dispatcher ?? null);
        return okResponse('direct-body');
      }
    }
  );
  assert.equal(session.transport, 'direct');
  const result = await session.text('https://example.test/', 1000);
  assert.equal(result.text, 'direct-body');
  assert.equal(result.transport, 'direct');
  await session.close();
});

test('a blocked direct response switches to the proxy and pins it', async () => {
  const transports = [];
  let call = 0;
  const session = await EgressSession.open(
    { VPN_AUTOMATION_PROXY_MODE: 'auto' },
    {
      fetchImpl: async () => {
        call += 1;
        transports.push(session.transport);
        // The first (direct) call is a block page; the retry rides the proxy.
        return call === 1 ? okResponse('access denied', 403) : okResponse('vmess://real');
      }
    }
  );
  assert.equal(session.transport, 'direct');
  const result = await session.text('https://example.test/', 1000);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'vmess://real');
  assert.equal(session.transport, 'proxy');
  assert.deepEqual(session.switches.map((s) => s.to), ['proxy']);
  assert.deepEqual(transports, ['direct', 'proxy']);
  await session.close();
});

test('direct mode never switches to a proxy even when blocked', async () => {
  const session = await EgressSession.open(
    { VPN_AUTOMATION_PROXY_MODE: 'direct' },
    { fetchImpl: async () => okResponse('access denied', 403) }
  );
  const result = await session.text('https://example.test/', 1000);
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(session.transport, 'direct');
  assert.equal(session.switches.length, 0);
  await session.close();
});

test('a non-OK body is cancelled so its socket is released', async () => {
  let cancelled = 0;
  const session = await EgressSession.open(
    { VPN_AUTOMATION_PROXY_MODE: 'direct' },
    {
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => 'server error',
        body: { cancel: async () => { cancelled += 1; } }
      })
    }
  );
  const result = await session.text('https://example.test/', 1000);
  assert.equal(result.ok, false);
  assert.equal(cancelled, 1);
  await session.close();
});

test('an empty sweep on direct escalates to the proxy once', async () => {
  const session = await EgressSession.open(
    { VPN_AUTOMATION_PROXY_MODE: 'auto' },
    { fetchImpl: async () => okResponse('') }
  );
  assert.equal(session.reportEmptySweep(), true);
  assert.equal(session.transport, 'proxy');
  // Sticky: a second empty sweep does not oscillate back.
  assert.equal(session.reportEmptySweep(), false);
  assert.equal(session.switches.length, 1);
  await session.close();
});
