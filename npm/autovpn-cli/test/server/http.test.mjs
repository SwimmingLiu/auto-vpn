import assert from 'node:assert/strict';
import test from 'node:test';

import { createAutoVpnServer } from '../../dist/server/http.js';

test('health requires bearer token when auth is enabled', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: true, token: 'secret' },
    runtime: {
      loadState: async () => ({ profile: { sources: {} }, runState: 'idle' })
    }
  });

  try {
    const denied = await fetch(`${service.origin}/api/health`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${service.origin}/api/health`, {
      headers: { Authorization: 'Bearer secret' }
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).status, 'ok');
  } finally {
    await service.close();
  }
});

test('state response is redacted before leaving API', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: {
            demo: {
              url: 'https://example.test/sub?token=secret-token',
              key: 'source-key'
            }
          },
          deploy: {
            cloudflare_api_token: 'cloudflare-secret'
          }
        },
        runState: 'idle'
      })
    }
  });

  try {
    const response = await fetch(`${service.origin}/api/state`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /secret-token|source-key|cloudflare-secret/);
    assert.match(text, /redacted/i);
  } finally {
    await service.close();
  }
});

test('run and stop routes delegate to runtime', async () => {
  const calls = [];
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({ profile: {}, runState: 'idle' }),
      startRun: async (options) => {
        calls.push(['start', options]);
        return { ok: true, runId: 'run-1' };
      },
      stopRun: async () => {
        calls.push(['stop']);
        return { ok: true, requested: true };
      }
    }
  });

  try {
    const start = await fetch(`${service.origin}/api/runs`, {
      method: 'POST',
      body: JSON.stringify({ skipDeploy: true, skipVerify: true, resumeLatest: false })
    });
    assert.equal(start.status, 202);
    assert.deepEqual(await start.json(), { ok: true, runId: 'run-1' });

    const stop = await fetch(`${service.origin}/api/runs/current/stop`, { method: 'POST' });
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), { ok: true, requested: true });

    assert.deepEqual(calls, [
      ['start', { skipDeploy: true, skipVerify: true, resumeLatest: false }],
      ['stop']
    ]);
  } finally {
    await service.close();
  }
});

test('events route streams redacted server-sent events', async () => {
  let subscriber;
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({ profile: {}, runState: 'idle' }),
      subscribe: (handler) => {
        subscriber = handler;
        return () => {
          subscriber = undefined;
        };
      }
    }
  });

  try {
    const response = await fetch(`${service.origin}/api/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    subscriber({ type: 'log', message: 'Bearer secret-token and vmess://abcdef' });
    const reader = response.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(value);

    assert.match(text, /^data: /);
    assert.doesNotMatch(text, /secret-token|vmess:\/\/abcdef/);
    assert.match(text, /redacted/i);
  } finally {
    await service.close();
  }
});

test('root serves renderer html with web adapter before app script', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({ profile: {}, runState: 'idle' })
    }
  });

  try {
    const response = await fetch(`${service.origin}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const html = await response.text();
    assert.match(html, /web-adapter\.js/);
    assert.ok(html.indexOf('/web-adapter.js') < html.indexOf('./app.js'));
  } finally {
    await service.close();
  }
});

test('web adapter installs browser vpnAutomation api', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({ profile: {}, runState: 'idle' })
    }
  });

  try {
    const response = await fetch(`${service.origin}/web-adapter.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
    const script = await response.text();
    assert.match(script, /window\.vpnAutomation/);
    assert.match(script, /EventSource/);
    assert.match(script, /\/api\/runs/);
  } finally {
    await service.close();
  }
});
