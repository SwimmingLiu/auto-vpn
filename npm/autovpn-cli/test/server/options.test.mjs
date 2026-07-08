import assert from 'node:assert/strict';
import test from 'node:test';

import { parseServeOptions } from '../../dist/server/options.js';

test('serve defaults to loopback with token auth enabled', () => {
  const options = parseServeOptions(['serve'], {
    cwd: '/repo',
    env: {},
    randomToken: () => 'generated-token'
  });

  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 8765);
  assert.equal(options.projectRoot, '/repo');
  assert.equal(options.auth.enabled, true);
  assert.equal(options.auth.token, 'generated-token');
});

test('serve rejects non-loopback hosts without explicit auth decision', () => {
  assert.throws(
    () => parseServeOptions(['serve', '--host', '0.0.0.0'], {
      cwd: '/repo',
      env: {},
      randomToken: () => 'generated-token'
    }),
    /serve requires --token or --no-auth when binding to non-loopback host/
  );
});

test('serve accepts non-loopback host with token', () => {
  const options = parseServeOptions(['serve', '--host', '0.0.0.0', '--token', 'secret'], {
    cwd: '/repo',
    env: {},
    randomToken: () => 'unused'
  });

  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.auth.enabled, true);
  assert.equal(options.auth.token, 'secret');
});

test('serve accepts explicit no-auth and marks auth disabled', () => {
  const options = parseServeOptions(['serve', '--host', '0.0.0.0', '--no-auth'], {
    cwd: '/repo',
    env: {},
    randomToken: () => 'unused'
  });

  assert.equal(options.auth.enabled, false);
  assert.equal(options.auth.token, '');
});

test('serve proxy is opt-in and supports an explicit proxy url', () => {
  const disabled = parseServeOptions(['serve'], {
    cwd: '/repo',
    env: {},
    randomToken: () => 'generated-token'
  });
  const auto = parseServeOptions(['serve', '--proxy'], {
    cwd: '/repo',
    env: {},
    randomToken: () => 'generated-token'
  });
  const explicit = parseServeOptions(['serve', '--proxy', 'http://127.0.0.1:7897'], {
    cwd: '/repo',
    env: {},
    randomToken: () => 'generated-token'
  });

  assert.equal(disabled.proxy.enabled, false);
  assert.equal(auto.proxy.enabled, true);
  assert.equal(auto.proxy.url, '');
  assert.equal(explicit.proxy.enabled, true);
  assert.equal(explicit.proxy.url, 'http://127.0.0.1:7897');
});
