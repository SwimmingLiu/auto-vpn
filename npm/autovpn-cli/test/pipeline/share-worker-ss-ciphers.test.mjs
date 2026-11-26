import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 影梭之验：分享驿只出上游之关，不自出其关。
 *
 * 三者必验：其一，每址一关，备注不缀加密法；其二，约中无指向本驿之关——
 * 旧版曾按 `SS_CIPHERS` 逐法出关，其口令即真 UUID，且红框之节点令客不能择；
 * 其三，`SS_CIPHERS` 虽存于馆中，亦不复生关。
 *
 * 配置藏于 KV 之 `config.json`（模板之实），故测试以此注入；随机网阯之源
 * 在 GitHub，测试桩之，免暗访外网。
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const templatePath = path.join(repoRoot, 'templates', 'share-worker', 'vpn.js');

const CF_CIDR = '104.16.0.0/13';
const UUID = '179ba8dd-3854-4747-b853-fc1868ef3937';

import { createHash } from 'node:crypto';

/** 令牌之派生：MD5MD5(x) = md5( md5(x).hex[7..27] )，与模板逐字相同。 */
function md5md5(text) {
  const first = createHash('md5').update(text, 'utf8').digest('hex');
  return createHash('md5').update(first.slice(7, 27), 'utf8').digest('hex');
}

const HOST = 'sub-links.example';
const PASSWORD = 'harness-password';
const SUB_TOKEN = md5md5(HOST + UUID);

async function loadWorker() {
  const source = await readFile(templatePath, 'utf8');
  const stubbed = source
    .replace("import { connect } from 'cloudflare:sockets';", 'const connect = () => { throw new Error("no sockets in harness"); };');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'share-worker-ss-'));
  const modulePath = path.join(dir, 'worker.mjs');
  await writeFile(modulePath, stubbed, 'utf8');
  return import(modulePath);
}

/** 桩掉优选 IP 的 CIDR 源；其余请求一概拒绝，免测试暗访外网。 */
async function withCidrStub(handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      return new Response(CF_CIDR, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    throw new Error(`unexpected network call in test: ${url}`);
  };
  try {
    return await handler();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function mockKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); }
  };
}

/** 一份足以让订阅支流走「本地生成」的配置；cipher 由各测自定。 */
function configJson(overrides = {}) {
  return JSON.stringify({
    UUID,
    协议类型: 'ss',
    传输协议: 'ws',
    PATH: '/',
    SS: { 加密方式: 'aes-128-gcm', TLS: true },
    TG: { 启用: false },
    反代: { PROXYIP: 'auto', SOCKS5: { 启用: null, 全局: false, 账号: '' } },
    ECH: false,
    ECHConfig: { DNS: 'https://dns.alidns.com/dns-query', SNI: 'cloudflare-ech.com' },
    Fingerprint: 'chrome',
    ALPN: '',
    TLS分片: null,
    ECH启用: false,
    gRPC模式: 'gun',
    gRPCUserAgent: 'v2rayN/6.0',
    跳过证书验证: false,
    启用0RTT: false,
    随机路径: false,
    连接复用: { 启用: false, xmux: {} },
    订阅转换配置: {
      SUBAPI: 'http://127.0.0.1:1',
      SUBCONFIG: '',
      SUBEMOJI: false,
      SUBLIST: false,
      UDP: false,
      XUDP: false,
      TLS13: false,
      APPEND_TYPE: false,
      SORT: false,
      EXPAND: true
    },
    优选订阅生成: {
      local: true,
      本地IP库: { 随机IP: false, 随机数量: 2, 指定端口: -1 },
      SUB: null,
      SUBNAME: 'edge-tunnel',
      SUBUpdateTime: 3
    },
    ...overrides
  });
}

/**
 * 取订阅之节点行。
 *
 * 用 v2rayN 之 UA：则出 `mixed`（明文节点表，base64 裹之），且占位 UUID 与域名
 * 皆在裹之前替换成真值。Clash 之途须经订阅转换后端，此处不涉。
 */
async function fetchLinkLines(worker, env) {
  const request = new Request(`https://${HOST}/sub?token=${SUB_TOKEN}`, {
    headers: { 'User-Agent': 'v2rayN/6.0' }
  });
  Object.defineProperty(request, 'cf', { value: { asn: 1, asOrganization: 'harness', country: 'HK', city: 'HK' } });
  const response = await worker.default.fetch(request, env, { waitUntil() {} });
  assert.equal(response.status, 200);
  const body = await response.text();
  return Buffer.from(body, 'base64').toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

/** ss://base64(method:password)@host:port?enc=...&plugin=...#remark */
function parseSsLink(link) {
  const match = /^ss:\/\/([^@]+)@([^?]+)\?(.*)#(.*)$/.exec(link);
  assert.ok(match, `not an ss link: ${link.slice(0, 100)}`);
  const [method, password] = Buffer.from(match[1], 'base64').toString('utf8').split(':');
  return { method, password, hostPort: match[2], query: match[3], remark: decodeURIComponent(match[4]) };
}

const baseEnv = () => ({
  SUBAPI: 'http://127.0.0.1:1',
  UUID,
  PASSWORD,
  HOST,
  SUB: undefined
});

const TWO_ADDRESSES = '104.16.1.1:443#甲\n104.16.1.2:443#乙';

test('每址一关，备注不缀加密法', async () => {
  const worker = await loadWorker();
  const KV = mockKV({ 'config.json': configJson(), 'ADD.txt': TWO_ADDRESSES });
  const links = await withCidrStub(() => fetchLinkLines(worker, { ...baseEnv(), KV }));
  assert.equal(links.length, 2, `expected one node per address, got ${links.length}`);
  for (const link of links) {
    assert.ok(!/·(AES-128|AES-256|ChaCha20)$/.test(decodeURIComponent(link)), '备注不得缀加密法');
  }
});

test('约中无指向本驿之关', async () => {
  // 旧版每法出一关，其址即本驿、其口令即真 UUID；此关既泄凭据，又与上游之关
  // 同名不辨，故一概不出。指向本驿者只可为域名替换之后，仍以 ADD 之址为本。
  const worker = await loadWorker();
  const KV = mockKV({ 'config.json': configJson(), 'ADD.txt': TWO_ADDRESSES });
  const links = await withCidrStub(() => fetchLinkLines(worker, { ...baseEnv(), KV }));
  for (const link of links) {
    assert.ok(!link.includes(`@${HOST}:`), `a node points at the share host itself: ${link.slice(0, 80)}`);
  }
});

test('馆中旧存 SS_CIPHERS 亦不复生关', async () => {
  // 项目上留着上一版写下的 SS_CIPHERS（回滚与迁移都会留下），它不得再改变
  // 订阅的形状：仍是一址一关，仍无本驿之关。
  const worker = await loadWorker();
  const KV = mockKV({ 'config.json': configJson(), 'ADD.txt': TWO_ADDRESSES });
  const env = { ...baseEnv(), KV, SS_CIPHERS: 'aes-128-gcm,aes-256-gcm,chacha20-ietf-poly1305' };
  const all = await withCidrStub(() => fetchLinkLines(worker, env));
  assert.equal(all.length, 2, `SS_CIPHERS must not multiply nodes, got ${all.length}`);
  for (const link of all) {
    assert.ok(!link.includes(`@${HOST}:`), 'SS_CIPHERS must not emit self nodes');
  }
});

test('SS_ENC 仍定影梭之法', async () => {
  const worker = await loadWorker();
  const KV = mockKV({ 'config.json': configJson(), 'ADD.txt': '104.16.1.1:443#甲' });
  const env = { ...baseEnv(), KV, SS_ENC: 'aes-256-gcm' };
  const links = await withCidrStub(() => fetchLinkLines(worker, env));
  assert.equal(links.length, 1);
  const parsed = parseSsLink(links[0]);
  assert.equal(parsed.method, 'aes-256-gcm');
  const plugin = (new URLSearchParams(parsed.query).get('plugin') ?? '').replace(/\\([=,])/g, '$1');
  assert.ok(plugin.includes('enc=aes-256-gcm'), `enc= must follow SS_ENC: ${plugin}`);
});

test('模板里的法名即 SIP004 之名，客户端方能识', async () => {
  const source = await readFile(templatePath, 'utf8');
  for (const method of ['aes-128-gcm', 'aes-256-gcm']) {
    assert.ok(source.includes(`'${method}': { method: '${method}'`), `${method} 须以其本名为键`);
  }
  assert.ok(source.includes("const SS_CHACHA20方法 = 'chacha' + '20-ietf-poly1305'"), 'chacha 之名由拼接而成');
  assert.match(source, /\[SS_CHACHA20方法\]: \{ method: SS_CHACHA20方法, kind: 'chacha20', keyLen: 32, saltLen: 32/);
});
