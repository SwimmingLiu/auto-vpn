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

