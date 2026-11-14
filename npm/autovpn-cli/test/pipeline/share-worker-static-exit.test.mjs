import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const templatePath = path.join(repoRoot, 'templates', 'share-worker', 'vpn.js');

const upstreamClash = `mixed-port: 7890
mode: rule
proxies:
  - {name: "US 421", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
  - {name: "JP 9", type: vmess, server: 5.6.7.8, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies:
      - "US 421"
      - "JP 9"
      - DIRECT
  - name: "🇺🇸 美国"
    type: url-test
    proxies:
      - "US 421"
rules:
  - MATCH,🚀 节点选择
`;

function mockKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    __store: store
  };
}

/**
 * Boot the share Worker in Node.
 *
 * Only two edits are made to the shipped template: the Cloudflare-only socket
 * import becomes a stub (this path never opens a socket), and the subscription
 * token is pinned so the harness can authenticate.
 */
async function loadWorker() {
  const source = await readFile(templatePath, 'utf8');
  const stubbed = source
    .replace("import { connect } from 'cloudflare:sockets';", 'const connect = () => { throw new Error("no sockets in harness"); };')
    .replace(/const 订阅TOKEN = await MD5MD5\(host \+ userID\)/, "const 订阅TOKEN = 'harness-token'");
  assert.ok(stubbed.includes("const 订阅TOKEN = 'harness-token'"), 'token rewrite must land');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'share-worker-'));
  const modulePath = path.join(dir, 'worker.mjs');
  await writeFile(modulePath, stubbed, 'utf8');
  return import(modulePath);
}

async function withSubconverterStub(handler) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(upstreamClash);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('share Worker emits a chained static exit into the Clash subscription', async (t) => {
  const worker = await loadWorker();

  const response = await withSubconverterStub(async (subapi) => {
    const env = {
      SUB: 'https://sub-nodes.example/?serect_key=unused',
      SUBAPI: subapi,
      UUID: '179ba8dd-3854-4747-b853-fc1868ef3937',
      PASSWORD: 'harness-password',
      KV: mockKV({ 'static-exit.json': JSON.stringify([{ name: '香港静态IP', type: 'socks5', server: '198.51.100.10', port: 1080, username: 'USER', password: 'PASS' }]) }),
      STATIC_EXIT: 'socks5://USER:PASS@198.51.100.10:1080#香港静态IP',
      HOST: 'sub-links.example'
    };
    const request = new Request('https://sub-links.example/sub?token=harness-token', {
      headers: { 'User-Agent': 'clash-verge/v2.0.0 mihomo' }
    });
    // `cf` is populated by the edge; the log path reads it synchronously.
    Object.defineProperty(request, 'cf', { value: { asn: 1, asOrganization: 'harness', country: 'HK', city: 'HK' } });
    return worker.default.fetch(request, env, { waitUntil() {} });
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /yaml/);
  const yaml = await response.text();

  assert.match(yaml, /name: "香港静态IP"/);
  assert.match(yaml, /dialer-proxy: "🛬 静态IP入口"/);
  assert.match(yaml, /- name: "🛡️ 静态IP出口"/);
  assert.match(yaml, /- name: "🛬 静态IP入口"/);
  // The subscription must keep the upstream nodes untouched.
  assert.match(yaml, /name: "US 421"/);
  assert.match(yaml, /MATCH,🚀 节点选择/);

  let mihomoBin = '';
  try {
    await run('mihomo', ['-v']);
    mihomoBin = 'mihomo';
  } catch {
    t.diagnostic('mihomo not installed; skipping the config check');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'share-worker-mihomo-'));
  const configPath = path.join(dir, 'config.yaml');
  await writeFile(configPath, yaml, 'utf8');
  const { stdout, stderr } = await run(mihomoBin, ['-t', '-f', configPath, '-d', dir], { timeout: 120_000 });
  assert.match(`${stdout}${stderr}`, /test is successful/);
});

test('share Worker leaves the Clash subscription alone without a static exit', async () => {
  const worker = await loadWorker();

  const response = await withSubconverterStub(async (subapi) => {
    const env = {
      SUBAPI: subapi,
      UUID: '179ba8dd-3854-4747-b853-fc1868ef3937',
      PASSWORD: 'harness-password',
      KV: mockKV()
    };
    const request = new Request('https://sub-links.example/sub?token=harness-token', {
      headers: { 'User-Agent': 'clash-verge/v2.0.0 mihomo' }
    });
    Object.defineProperty(request, 'cf', { value: { asn: 1, asOrganization: 'harness', country: 'HK', city: 'HK' } });
    return worker.default.fetch(request, env, { waitUntil() {} });
  });

  assert.equal(response.status, 200);
  const yaml = await response.text();
  assert.ok(!yaml.includes('静态IP出口'));
  assert.ok(!yaml.includes('dialer-proxy'));
  assert.match(yaml, /name: "US 421"/);
});

test('share Worker reads the KV static-exit list and serves it over the admin route', async () => {
  const worker = await loadWorker();
  const store = new Map();
  const KV = {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); }
  };
  const base = { UUID: '179ba8dd-3854-4747-b853-fc1868ef3937', PASSWORD: 'pw', KV, HOST: 'sub-links.example' };
  const withCf = (request) => {
    Object.defineProperty(request, 'cf', { value: { asn: 1, asOrganization: 'harness', country: 'HK', city: 'HK' } });
    return request;
  };

  // `auth` is MD5MD5(UA + KEY + password); the harness pins UA and the default KEY.
  const cookie = 'auth=bf86fba5f9b36f290496f134e0bfab80';
  const post = await worker.default.fetch(withCf(new Request('https://sub-links.example/admin/static-exit.json', {
    method: 'POST',
    body: JSON.stringify([{ name: 'KV出口', type: 'socks5', server: '198.51.100.77', port: 1080 }]),
    headers: { Cookie: cookie, 'User-Agent': 'clash-verge/v2.0.0 mihomo' }
  })), base, { waitUntil() {} });
  assert.equal(post.status, 200);

  const get = await worker.default.fetch(withCf(new Request('https://sub-links.example/admin/static-exit.json', {
    headers: { Cookie: cookie, 'User-Agent': 'clash-verge/v2.0.0 mihomo' }
  })), base, { waitUntil() {} });
  assert.equal(get.status, 200);
  assert.match(await get.text(), /KV出口/);

  const yaml = await withSubconverterStub(async (subapi) => {
    const response = await worker.default.fetch(withCf(new Request('https://sub-links.example/sub?token=harness-token', {
      headers: { 'User-Agent': 'clash-verge/v2.0.0 mihomo' }
    })), { ...base, SUBAPI: subapi }, { waitUntil() {} });
    return response.text();
  });

  assert.match(yaml, /name: "KV出口"/, 'a list stored only in KV must still reach the subscription');
  assert.match(yaml, /- name: "🛡️ 静态IP出口"/);
});
