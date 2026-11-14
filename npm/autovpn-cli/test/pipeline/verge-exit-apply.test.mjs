import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  解析出口URI,
  读取出口文件,
  生成配置块,
  替换配置块,
  脱敏,
  curl代理地址,
} from '../../scripts/apply-verge-exit.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const templatePath = path.join(repoRoot, 'docs', 'clash-verge-extension.js');

// 假凭证，故意带上需要转义的字符：密码里有冒号、井号、单引号、反斜杠。
const 假用户 = 'alice';
const 假密码 = "pw1:two#three'four\\zqxjk";
const 假地址 = `socks5://${假用户}:${encodeURIComponent(假密码)}@203.0.113.7:1080#🇭🇰 香港静态IP`;

test('parses a socks5 URI with percent-encoded credentials', () => {
  const 出口 = 解析出口URI(假地址);
  assert.equal(出口.name, '🇭🇰 香港静态IP');
  assert.equal(出口.type, 'socks5');
  assert.equal(出口.server, '203.0.113.7');
  assert.equal(出口.port, 1080);
  assert.equal(出口.username, 假用户);
  assert.equal(出口.password, 假密码);
  assert.equal(出口.udp, true);
});

test('splits on the last @ so an unescaped @ in the password still parses', () => {
  const 出口 = 解析出口URI('socks5://alice:p@ss@203.0.113.7:1080');
  assert.equal(出口.server, '203.0.113.7');
  assert.equal(出口.port, 1080);
  assert.equal(出口.username, 'alice');
  assert.equal(出口.password, 'p@ss');
});

test('fills in the default port per scheme', () => {
  assert.equal(解析出口URI('socks5://u:p@h.example').port, 1080);
  assert.equal(解析出口URI('http://u:p@h.example').port, 80);
  assert.equal(解析出口URI('https://u:p@h.example').port, 443);
});

test('normalizes scheme names the way mihomo needs them', () => {
  assert.equal(解析出口URI('socks5h://u:p@h.example:1081').type, 'socks5');
  assert.equal(解析出口URI('socks://u:p@h.example:1082').type, 'socks5');

  const tls = 解析出口URI('https://u:p@h.example');
  assert.equal(tls.type, 'http');
  assert.equal(tls.tls, true);
});

test('parses bracketed IPv6 hosts', () => {
  const 出口 = 解析出口URI('socks5://u:p@[2001:db8::1]:1080');
  assert.equal(出口.server, '[2001:db8::1]');
  assert.equal(出口.port, 1080);
});

test('omits credentials when the URI has none', () => {
  const 出口 = 解析出口URI('socks5://203.0.113.7:1080');
  assert.equal(出口.name, '203.0.113.7:1080');
  assert.equal(Object.hasOwn(出口, 'username'), false);
  assert.equal(JSON.stringify(出口).includes('password'), false);
});

test('rejects ports that mihomo would refuse', () => {
  for (const 端口 of ['0', '65536', 'abc', '-1', '1080.5']) {
    assert.throws(() => 解析出口URI(`socks5://u:p@h.example:${端口}`), /端口/);
  }
});

test('rejects an unknown scheme and a missing host', () => {
  assert.throws(() => 解析出口URI('vless://u:p@h.example:443'), /不支持的协议/);
  assert.throws(() => 解析出口URI('203.0.113.7:1080'), /协议/);
  assert.throws(() => 解析出口URI('socks5://u:p@:1080'), /缺少主机/);
});

test('a bad line reports its number, not its contents', () => {
  const 文本 = '# 注释行\n\nsocks5://u:p@h.example:1080#ok\nvless://bob:zqxjk@h.example:443\n';
  let 报错 = '';
  try {
    读取出口文件(文本);
  } catch (错) {
    报错 = 错.message;
  }
  assert.match(报错, /第 4 行/);
  assert.doesNotMatch(报错, /bob/);
  assert.doesNotMatch(报错, /zqxjk/);
});

test('the curl probe re-encodes the credentials instead of passing them raw', () => {
  // 用户可能把 `#` / `:` 原样写进密码；交给 curl 前必须编码，否则 curl 会把
  // 井号当片段、把冒号当分隔符，连到错误的主机上。
  const 脏 = 解析出口URI(`socks5://${encodeURIComponent('a:b')}:${encodeURIComponent('p#w')}@h.example:1080`);
  assert.equal(curl代理地址(脏), `socks5h://${encodeURIComponent('a:b')}:${encodeURIComponent('p#w')}@h.example:1080`);

  assert.equal(curl代理地址(解析出口URI('socks5://h.example:1080')), 'socks5h://h.example:1080');
  assert.equal(curl代理地址(解析出口URI('https://u:p@h.example')), 'https://u:p@h.example:443');
  assert.equal(curl代理地址(解析出口URI('http://u:p@h.example')), 'http://u:p@h.example:80');
  assert.equal(curl代理地址(解析出口URI('socks5://u:p@[2001:db8::1]:1080')), 'socks5h://u:p@[2001:db8::1]:1080');
});

test('the generated block survives quotes and backslashes in the password', () => {
  const 出口 = 解析出口URI(假地址);
  const 块 = 生成配置块([出口]);
  new Function(块);

  const 模块 = { exports: {} };
  new Function('module', 'exports', `${块}\nmodule.exports = STATIC_EXITS;`)(模块, 模块.exports);
  assert.equal(模块.exports[0].password, 假密码);
});

test('the redacted form never contains the credentials', () => {
  const 文本 = 脱敏(解析出口URI(假地址));
  assert.equal(文本, 'socks5://***@203.0.113.7:1080');
  assert.doesNotMatch(文本, /alice/);
  assert.doesNotMatch(文本, /zqxjk/);
});

test('block replacement touches only the STATIC_EXITS literal', async () => {
  const 模板 = await readFile(templatePath, 'utf8');
  const 新块 = 生成配置块([解析出口URI(假地址)]);
  const 结果 = 替换配置块(模板, 新块);

  assert.ok(结果.includes(新块));
  assert.equal(结果.includes('198.51.100.10'), false);
  // 配置区以外的内容原样保留。
  assert.ok(结果.includes('function main(config)'));
  assert.ok(结果.includes('const EXIT_GROUP'));
  // 再替换一次结果不变，且仍是合法 JS。
  assert.equal(替换配置块(结果, 新块), 结果);
  new Function(结果);
});

test('replacement fails loudly when the template lost its config block', () => {
  assert.throws(() => 替换配置块('function main() { return 1; }', 'const STATIC_EXITS = [];'), /STATIC_EXITS/);
});

test('the patched script injects the real exit the way Verge runs it', async () => {
  const 模板 = await readFile(templatePath, 'utf8');
  const 源码 = 替换配置块(模板, 生成配置块([解析出口URI(假地址)]));

  const 模块 = { exports: {} };
  new Function('module', 'exports', `${源码}\nmodule.exports = { main };`)(模块, 模块.exports);

  const 输出 = 模块.exports.main(
    {
      proxies: [{ name: 'US 421', type: 'vmess', server: '1.2.3.4', port: 443, uuid: '11111111-2222-4333-8444-555555555555' }],
      'proxy-groups': [{ name: '🚀 节点选择', type: 'select', proxies: ['US 421', 'DIRECT'] }],
      rules: ['MATCH,🚀 节点选择'],
    },
    'p',
  );

  const 出口 = 输出.proxies.find((p) => p.name === '🇭🇰 香港静态IP');
  assert.equal(出口.server, '203.0.113.7');
  assert.equal(出口.username, 假用户);
  assert.equal(出口.password, 假密码);
  assert.equal(出口.udp, true);

  const 链式 = 输出.proxies.find((p) => p.name === '🇭🇰 香港静态IP（链式）');
  assert.equal(链式['dialer-proxy'], '🛬 静态IP入口');
});
