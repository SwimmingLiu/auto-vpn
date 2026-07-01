import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMihomoRuntimeConfig,
  parseVmessLink,
  stripProxyEnv
} from '../../dist/pipeline/proxy-runtime.js';

function vmessLink(payload) {
  return `vmess://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

test('Node proxy runtime builds Python-compatible Mihomo config for websocket TLS vmess links', () => {
  const link = vmessLink({
    v: '2',
    ps: 'sample',
    add: 'edge.example.com',
    port: '443',
    id: '11111111-2222-3333-4444-555555555555',
    aid: '0',
    scy: 'auto',
    net: 'ws',
    type: 'none',
    host: 'cdn.example.com',
    path: '/api/ws',
    tls: 'tls',
    sni: 'sni.example.com'
  });

  const payload = parseVmessLink(link);
  const config = buildMihomoRuntimeConfig(payload, {
    mixedPort: 12345,
    controllerPort: 23456
  });

  assert.deepEqual(config, {
    'mixed-port': 12345,
    'allow-lan': false,
    mode: 'global',
    'log-level': 'silent',
    ipv6: false,
    'external-controller': '127.0.0.1:23456',
    dns: { enable: false },
    proxies: [{
      name: 'runtime-node',
      type: 'vmess',
      server: 'edge.example.com',
      port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
      alterId: 0,
      cipher: 'auto',
      udp: false,
      network: 'ws',
      tls: true,
      'skip-cert-verify': true,
      servername: 'sni.example.com',
      'ws-opts': {
        path: '/api/ws',
        headers: { Host: 'cdn.example.com' }
      }
    }],
    'proxy-groups': [{
      name: 'GLOBAL',
      type: 'select',
      proxies: ['runtime-node']
    }],
    rules: ['MATCH,GLOBAL']
  });
});

test('Node proxy runtime strips inherited proxy environment variables before starting Mihomo', () => {
  const env = stripProxyEnv({
    PATH: '/usr/bin',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7890',
    http_proxy: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    all_proxy: 'socks5://127.0.0.1:7890',
    NO_PROXY: 'localhost',
    no_proxy: 'localhost'
  });

  assert.deepEqual(env, { PATH: '/usr/bin' });
});
