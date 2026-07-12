import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildMihomoRuntimeConfig,
  openMihomoRuntime,
  parseVmessLink,
  probeMihomoProxyDelay,
  selectMihomoProxy,
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

test('Node proxy runtime opens Mihomo with a temp config and cleans it on close', async () => {
  const link = vmessLink({
    add: 'edge.example.com',
    port: '443',
    id: '11111111-2222-3333-4444-555555555555',
    aid: '0',
    net: 'ws',
    tls: 'tls'
  });
  const spawns = [];
  const waitedPorts = [];
  const selected = [];

  const runtime = await openMihomoRuntime(link, {
    runtimePath: '/opt/bin/mihomo',
    mixedPort: 10001,
    controllerPort: 10002,
    env: {
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://127.0.0.1:7890'
    },
    spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => {
        child.exitCode = 0;
        child.emit('close', 0, signal);
        return true;
      };
      spawns.push({ command, args, options, child });
      return child;
    },
    waitForPort: async (port) => {
      waitedPorts.push(port);
    },
    selectProxy: async (controllerUrl, proxyName, timeoutSeconds) => {
      selected.push({ controllerUrl, proxyName, timeoutSeconds });
    }
  });

  assert.equal(spawns[0].command, '/opt/bin/mihomo');
  assert.deepEqual(spawns[0].args, ['-f', runtime.configPath]);
  assert.equal(spawns[0].options.env.PATH, '/usr/bin');
  assert.equal(spawns[0].options.env.HTTP_PROXY, undefined);
  assert.deepEqual(waitedPorts, [10001, 10002]);
  assert.deepEqual(selected, [{
    controllerUrl: 'http://127.0.0.1:10002',
    proxyName: 'runtime-node',
    timeoutSeconds: 5
  }]);
  assert.deepEqual(runtime.proxies, {
    http: 'http://127.0.0.1:10001',
    https: 'http://127.0.0.1:10001'
  });
  assert.equal(JSON.parse(await readFile(runtime.configPath, 'utf8')).proxies[0].server, 'edge.example.com');

  await runtime.close();
  await assert.rejects(() => access(runtime.configPath));
});

test('Node proxy runtime resolves Mihomo for orchestrator runtime directories', async () => {
  const link = vmessLink({
    add: 'edge.example.com',
    port: '443',
    id: '11111111-2222-3333-4444-555555555555'
  });
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-runtime-dir-'));
  const runtimeDir = path.join(runtimeRoot, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const spawns = [];

  const runtime = await openMihomoRuntime(link, {
    runtimePath: runtimeDir,
    mixedPort: 10003,
    controllerPort: 10004,
    spawn: (command, args) => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => {
        child.exitCode = 0;
        child.emit('close', 0, signal);
        return true;
      };
      spawns.push({ command, args });
      return child;
    },
    waitForPort: async () => {},
    selectProxy: async () => {}
  });

  assert.equal(path.basename(spawns[0].command), 'mihomo');
  await runtime.close();
});

test('Node proxy runtime discovers Mihomo installed under the user clashctl directory', async () => {
  const link = vmessLink({
    add: 'edge.example.com',
    port: '443',
    id: '11111111-2222-3333-4444-555555555555'
  });
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'autovpn-home-'));
  const mihomoPath = path.join(homeDir, 'clashctl', 'bin', 'mihomo');
  await mkdir(path.dirname(mihomoPath), { recursive: true });
  await writeFile(mihomoPath, '#!/bin/sh\n', 'utf8');
  await chmod(mihomoPath, 0o755);
  const spawns = [];

  const runtime = await openMihomoRuntime(link, {
    env: { HOME: homeDir, PATH: '/usr/bin' },
    mixedPort: 10005,
    controllerPort: 10006,
    spawn: (command, args) => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => {
        child.exitCode = 0;
        child.emit('close', 0, signal);
        return true;
      };
      spawns.push({ command, args });
      return child;
    },
    waitForPort: async () => {},
    selectProxy: async () => {}
  });

  assert.equal(spawns[0].command, mihomoPath);
  await runtime.close();
});

test('Node proxy runtime rejects spawn errors instead of leaving them unhandled', async () => {
  const link = vmessLink({
    add: 'edge.example.com',
    port: '443',
    id: '11111111-2222-3333-4444-555555555555'
  });

  await assert.rejects(() => openMihomoRuntime(link, {
    runtimePath: '/definitely/missing/mihomo',
    mixedPort: 10007,
    controllerPort: 10008,
    spawn: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => {
        child.exitCode = 0;
        child.emit('close', 0, 'SIGTERM');
        return true;
      };
      process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    },
    waitForPort: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    selectProxy: async () => {}
  }), /spawn ENOENT/);
});

test('Node proxy runtime tags its startup port timeout for bounded transient retries', async () => {
  const link = vmessLink({
    add: 'edge.example.com',
    port: '443',
    id: '11111111-2222-3333-4444-555555555555'
  });

  await assert.rejects(() => openMihomoRuntime(link, {
    runtimePath: '/opt/bin/mihomo',
    mixedPort: 10009,
    controllerPort: 10010,
    spawn: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => {
        child.exitCode = 0;
        child.emit('close', 0, signal);
        return true;
      };
      return child;
    },
    waitForPort: async (port) => {
      throw new Error(`proxy port ${port} did not open in time`);
    },
    selectProxy: async () => {}
  }), (error) => {
    assert.equal(error.message, 'proxy port 10009 did not open in time');
    assert.equal(error.code, 'AUTOVPN_INTERNAL_TIMEOUT');
    return true;
  });
});

test('Node proxy runtime allocates local ports when callers do not provide them', async () => {
  const link = vmessLink({
    add: 'edge.example.com',
    port: '443',
    id: '11111111-2222-3333-4444-555555555555'
  });
  const waitedPorts = [];

  const runtime = await openMihomoRuntime(link, {
    runtimePath: '/opt/bin/mihomo',
    spawn: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => {
        child.exitCode = 0;
        child.emit('close', 0, signal);
        return true;
      };
      return child;
    },
    waitForPort: async (port) => {
      waitedPorts.push(port);
    },
    selectProxy: async () => {}
  });

  assert.equal(waitedPorts.length, 2);
  assert.ok(waitedPorts.every((port) => Number.isInteger(port) && port > 0));
  assert.notEqual(waitedPorts[0], waitedPorts[1]);
  assert.equal(runtime.proxies.http, `http://127.0.0.1:${waitedPorts[0]}`);
  assert.equal(runtime.controllerUrl, `http://127.0.0.1:${waitedPorts[1]}`);

  await runtime.close();
});

test('concurrent Mihomo runtimes reserve distinct automatically allocated ports', async () => {
  const link = vmessLink({ add: 'edge.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555' });
  const candidates = [12001, 12001, 12002, 12001, 12002, 12003, 12004];
  const makeChild = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = (signal) => { child.exitCode = 0; child.emit('close', 0, signal); return true; };
    return child;
  };
  const options = {
    runtimePath: '/opt/bin/mihomo',
    allocatePort: async () => candidates.shift(),
    spawn: makeChild,
    waitForPort: async () => {},
    selectProxy: async () => {}
  };
  const [first, second] = await Promise.all([openMihomoRuntime(link, options), openMihomoRuntime(link, options)]);
  const ports = [
    Number(new URL(first.proxies.http).port),
    Number(new URL(first.controllerUrl).port),
    Number(new URL(second.proxies.http).port),
    Number(new URL(second.controllerUrl).port)
  ];
  assert.equal(new Set(ports).size, 4);
  assert.deepEqual([...ports].sort((left, right) => left - right), [12001, 12002, 12003, 12004]);
  await Promise.all([first.close(), second.close()]);
});

test('automatic port reservation fails instead of looping forever on duplicate candidates', async () => {
  const link = vmessLink({ add: 'edge.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555' });
  const makeChild = () => {
    const child = new EventEmitter(); child.exitCode = null;
    child.kill = (signal) => { child.exitCode = 0; child.emit('close', 0, signal); return true; };
    return child;
  };
  const first = await openMihomoRuntime(link, { runtimePath: '/opt/bin/mihomo', allocatePort: async () => 13001, controllerPort: 13002, spawn: makeChild, waitForPort: async () => {}, selectProxy: async () => {} });
  const result = await Promise.race([
    openMihomoRuntime(link, { runtimePath: '/opt/bin/mihomo', allocatePort: async () => 13001, controllerPort: 13003, spawn: makeChild, waitForPort: async () => {}, selectProxy: async () => {} }).catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100))
  ]);
  assert.notEqual(result, 'hung');
  assert.match(result.message, /unable to reserve a unique local port/);
  await first.close();
});

test('automatic ports are released even when runtime process cleanup fails', async () => {
  const link = vmessLink({ add: 'edge.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555' });
  const candidates = [14001, 14002, 14001, 14002];
  const first = await openMihomoRuntime(link, {
    runtimePath: '/opt/bin/mihomo', allocatePort: async () => candidates.shift(),
    spawn: () => { const child = new EventEmitter(); child.exitCode = null; child.kill = () => { throw new Error('kill failed'); }; return child; },
    waitForPort: async () => {}, selectProxy: async () => {}
  });
  await assert.rejects(() => first.close(), /kill failed/);
  const second = await openMihomoRuntime(link, {
    runtimePath: '/opt/bin/mihomo', allocatePort: async () => candidates.shift(),
    spawn: () => { const child = new EventEmitter(); child.exitCode = null; child.kill = (signal) => { child.exitCode = 0; child.emit('close', 0, signal); return true; }; return child; },
    waitForPort: async () => {}, selectProxy: async () => {}
  });
  assert.equal(new URL(second.proxies.http).port, '14001');
  assert.equal(new URL(second.controllerUrl).port, '14002');
  await second.close();
});

test('Node proxy runtime selects proxies and probes Mihomo delay through controller API', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/proxies/GLOBAL')) {
      assert.equal(init.method, 'PUT');
      assert.equal(init.body, JSON.stringify({ name: 'runtime-node' }));
      return { ok: true, status: 204, json: async () => ({}) };
    }
    assert.equal(String(url), 'http://127.0.0.1:9090/proxies/runtime-node/delay?timeout=3000&url=https%3A%2F%2Fprobe.example%2F204');
    return { ok: true, status: 200, json: async () => ({ delay: 123 }) };
  };

  await selectMihomoProxy('http://127.0.0.1:9090', 'runtime-node', 3, { fetch });
  assert.equal(await probeMihomoProxyDelay('http://127.0.0.1:9090', 'runtime-node', 'https://probe.example/204', 3, { fetch }), 123);
  assert.equal(calls.length, 2);
});

test('Node proxy controller requests enforce the configured timeout', async () => {
  const result = await Promise.race([
    selectMihomoProxy('http://127.0.0.1:9090', 'runtime-node', 0.01, { fetch: async () => await new Promise(() => {}) }).catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100))
  ]);
  assert.notEqual(result, 'hung');
  assert.ok(result instanceof Error);
  assert.equal(result.code, 'AUTOVPN_INTERNAL_TIMEOUT');
});

test('Node proxy runtime tags an early Mihomo exit as transient', async () => {
  const link = vmessLink({ add: 'edge.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555' });
  await assert.rejects(() => openMihomoRuntime(link, {
    runtimePath: '/opt/bin/mihomo', mixedPort: 10013, controllerPort: 10014,
    spawn: () => {
      const child = new EventEmitter(); child.exitCode = null; child.kill = () => true;
      process.nextTick(() => { child.exitCode = 2; child.emit('exit', 2, null); });
      return child;
    },
    waitForPort: async () => await new Promise(() => {}), selectProxy: async () => {}
  }), (error) => {
    assert.equal(error.code, 'AUTOVPN_INTERNAL_TIMEOUT');
    return true;
  });
});

test('Node proxy runtime surfaces an early Mihomo exit while waiting for ports', async () => {
  const link = vmessLink({ add: 'edge.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555' });
  await assert.rejects(() => openMihomoRuntime(link, {
    runtimePath: '/opt/bin/mihomo',
    mixedPort: 10011,
    controllerPort: 10012,
    spawn: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => true;
      process.nextTick(() => {
        child.exitCode = 2;
        child.emit('exit', 2, null);
      });
      return child;
    },
    waitForPort: async () => await new Promise(() => {}),
    selectProxy: async () => {}
  }), /mihomo exited during startup with code 2/);
});

test('Node proxy runtime clamps Mihomo delay timeout to controller API limits', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ delay: 123 }) };
  };

  assert.equal(await probeMihomoProxyDelay('http://127.0.0.1:9090', 'runtime-node', 'http://probe.example/204', 60, { fetch }), 123);
  assert.equal(calls[0], 'http://127.0.0.1:9090/proxies/runtime-node/delay?timeout=30000&url=http%3A%2F%2Fprobe.example%2F204');
});
