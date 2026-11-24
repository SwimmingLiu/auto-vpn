import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 多加密之验：分享 Worker 的 SS 流可按 `SS.加密方式列表` 一法一组地出节点。
 *
 * 三事必验：其一，旧约不破——未设列表者，每地址仍出一节点，标不缀加密法；
 * 其二，众法俱出——列表所命之法各成一节点，`enc=` 与备注各随其法；
 * 其三，怪法不入——表外之名一概弃之，免订阅里出现客户端不能解的一行。
 *
 * 配置存于 KV 之 `config.json`（模板之实），故测试以此注入；随机 IP 之源
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
// 令牌乃 `MD5MD5(host + userID)`；userID 取 UUID（envUUID 之支），UUID 可由
// `MD5MD5(password + KEY)` 派生，故此处按模板之序复算，不桩任何东西。
const KEY = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
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

/** 一份足以让订阅支流走「本地生成」的配置；protocol 与 cipher 由各测自定。 */
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

/** 本驿自出之关：其址即本驿，名缀「本驿·法标」。 */
const isLocalNode = (line) => line.includes(`@${HOST}:`);

/** ss://base64(method:uuid)@host:port?enc=...&plugin=...#remark */
function parseSsLink(link) {
  const match = /^ss:\/\/([^@]+)@([^?]+)\?(.*)#(.*)$/.exec(link);
  assert.ok(match, `not an ss link: ${link.slice(0, 100)}`);
  const [method, uuid] = Buffer.from(match[1], 'base64').toString('utf8').split(':');
  return { method, uuid, hostPort: match[2], query: match[3], remark: decodeURIComponent(match[4]) };
}

const baseEnv = () => ({
  SUBAPI: 'http://127.0.0.1:1',
  UUID,
  PASSWORD,
  HOST,
  // 桩掉优选源，故给两条固定地址，输出才可预期。
  SUB: undefined
});

test('未设 SS_CIPHERS 时，每地址只出一节点，备注不带加密法之缀', async () => {
  const worker = await loadWorker();
  const KV = mockKV({ 'config.json': configJson(), 'ADD.txt': '104.16.1.1:443#甲\n104.16.1.2:443#乙' });
  const links = await withCidrStub(() => fetchLinkLines(worker, { ...baseEnv(), KV }));
  assert.equal(links.length, 2, `expected one node per address, got ${links.length}`);
  for (const link of links) {
    assert.ok(!/·(AES-128|AES-256|ChaCha20)$/.test(link), '备注不得缀加密法');
  }
});

test('SS_CIPHERS 命三法，则每地址各出三节点，enc 与备注各随其法', async () => {
  const worker = await loadWorker();
  const KV = mockKV({ 'config.json': configJson(), 'ADD.txt': '104.16.1.1:443#甲' });
  const env = { ...baseEnv(), KV, SS_CIPHERS: 'aes-128-gcm,aes-256-gcm,chacha20-ietf-poly1305' };
  const all = await withCidrStub(() => fetchLinkLines(worker, env));
  const local = all.filter(isLocalNode);
  const upstream = all.filter((line) => !isLocalNode(line));
  // 本驿自出一组（三法），上游之关亦各出三法：二者并列，故六行。
  assert.equal(local.length, 3, `local nodes: expected 3, got ${local.length}`);
  assert.equal(upstream.length, 3, `upstream nodes: expected 3, got ${upstream.length}`);
  const links = upstream;

  const parsed = links.map(parseSsLink);
  assert.deepEqual(parsed.map((item) => item.method), ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305']);
  for (const item of parsed) {
    // ss 链接里带的是**占位 UUID**，真值替换只在链接尾部（另在订阅里明文做），
    // 故此处只验其为合法 UUID，不验其等于真 UUID。
    assert.match(item.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'uuid field must be a UUID');
    // `enc` 藏于 plugin 参数之内，编码后再出现，故解之而验。
    // 路径里的 `=` 与 `,` 会被转义成 `\=`/`\,`（订阅器所要求），故先去转义再比对。
    const plugin = (new URLSearchParams(item.query).get('plugin') ?? '').replace(/\\([=,])/g, '$1');
    assert.ok(plugin.includes(`enc=${item.method}`), `enc= must match the method: ${plugin}`);
  }
  assert.deepEqual(parsed.map((item) => item.remark), ['甲·AES-128', '甲·AES-256', '甲·ChaCha20']);
});

test('SS_CIPHERS 中的表外之法一概弃之', async () => {
  const worker = await loadWorker();
  const KV = mockKV({ 'config.json': configJson(), 'ADD.txt': '104.16.1.1:443#甲' });
  const env = { ...baseEnv(), KV, SS_CIPHERS: 'rc4-md5,2022-blake3-aes-128-gcm,aes-128-gcm' };
  const all = await withCidrStub(() => fetchLinkLines(worker, env));
  const links = all.filter((line) => !isLocalNode(line));
  assert.equal(links.length, 1, `only the known cipher may be emitted, got ${links.length}`);
  assert.equal(all.filter(isLocalNode).length, 1, 'unknown ciphers must not reach the local node group either');
  assert.equal(parseSsLink(links[0]).method, 'aes-128-gcm');
  assert.ok(!links[0].includes('2022-blake3'), '2022 系未实现，不得以近似之法冒充');
});

test('模板里的法名即 SIP004 之名，客户端方能识', async () => {
  const source = await readFile(templatePath, 'utf8');
  for (const method of ['aes-128-gcm', 'aes-256-gcm']) {
    assert.ok(source.includes(`'${method}': { method: '${method}'`), `${method} 须以其本名为键`);
  }
  assert.ok(source.includes("const SS_CHACHA20方法 = 'chacha' + '20-ietf-poly1305'"), 'chacha 之名由拼接而成');
  assert.match(source, /\[SS_CHACHA20方法\]: \{ method: SS_CHACHA20方法, kind: 'chacha20', keyLen: 32, saltLen: 32/);
});
