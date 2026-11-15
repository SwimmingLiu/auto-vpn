import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CREDENTIAL_FIELD,
  attachedScript,
  findConfigProxy,
  findExtensionScripts,
  generateExitBlock,
  loadScript,
  parseProfilesYaml,
  probeInjection,
  proxyMatchesExit,
  replaceExitBlock,
  sameConfigProxy,
} from '../dist/verge/script.js';
import { parseExitUri } from '../dist/verge/exit-uri.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const templatePath = path.join(repoRoot, 'docs', 'clash-verge-extension.js');
const template = fs.readFileSync(templatePath, 'utf8');

const SECRET = ['s3cr3t', String.fromCharCode(39), String.fromCharCode(92)].join('');
const LINK = `socks5://alice:${encodeURIComponent(SECRET)}@203.0.113.7:1080#🇭🇰 香港静态IP`;

test('the generated block carries the credential under the mihomo field name', () => {
  const block = generateExitBlock([parseExitUri(LINK)]);
  assert.ok(block.startsWith('const STATIC_EXITS = ['));
  assert.ok(block.includes(`${CREDENTIAL_FIELD}: `));

  // Compiling and running it is the only honest check that the escaping held.
  const module = { exports: {} };
  new Function('module', 'exports', `${block}\nmodule.exports = STATIC_EXITS;`)(module, module.exports);
  assert.equal(module.exports[0][CREDENTIAL_FIELD], SECRET);
  assert.equal(module.exports[0].name, '🇭🇰 香港静态IP');
});

test('an empty list generates a compilable empty literal', () => {
  const block = generateExitBlock([]);
  const module = { exports: {} };
  new Function('module', 'exports', `${block}\nmodule.exports = STATIC_EXITS;`)(module, module.exports);
  assert.deepEqual(module.exports, []);
});

test('replacing the block leaves the rest of the script alone', () => {
  const block = generateExitBlock([parseExitUri(LINK)]);
  const next = replaceExitBlock(template, block);
  assert.ok(next.includes(block));
  assert.equal(next.includes('198.51.100.10'), false);
  assert.ok(next.includes('function main(config)'));
  // The operator's own settings survive a write.
  assert.ok(next.includes("const MODE = 'chain';"));
  assert.ok(next.includes("const EXIT_GROUP_TARGETS = ['🚀 节点选择'];"));
  assert.equal(replaceExitBlock(next, block), next);
});

test('a one-line empty literal is replaced too', () => {
  const source = "const STATIC_EXITS = [];\nconst MODE = 'chain';\n";
  const next = replaceExitBlock(source, generateExitBlock([]));
  assert.ok(next.startsWith('const STATIC_EXITS = [\n'));
  assert.ok(next.includes("const MODE = 'chain';"));
});

test('a second declaration or a commented-out one stops the write', () => {
  const twice = 'const STATIC_EXITS = [];\nconst STATIC_EXITS = [\n];\n';
  assert.throws(() => replaceExitBlock(twice, 'const STATIC_EXITS = [];'), /2 times/);

  const commented = '/*\nconst STATIC_EXITS = [\n];\n*/\n';
  assert.throws(() => replaceExitBlock(commented, 'const STATIC_EXITS = [];'), /block comment/);
});

test('a script without the literal is refused', () => {
  assert.throws(() => replaceExitBlock('function main(config) { return config; }', 'const STATIC_EXITS = [];'), /no `const STATIC_EXITS/);
});

test('a closing `];` with a trailing comment ends the block, not the next one in the file', () => {
  const source = [
    "const STATIC_EXITS = [",
    "  { name: 'old', type: 'socks5', server: '203.0.113.9', port: 1080 },",
    ']; // exits',
    "const MODE = 'chain';",
    "const RULES_TO_EXIT = ['DOMAIN,x.example']; // ];",
    'function main(config) { return config; }',
    '',
  ].join('\n');
  const next = replaceExitBlock(source, generateExitBlock([]));
  // A later `];` inside an unrelated comment must survive.
  assert.ok(next.includes("const RULES_TO_EXIT = ['DOMAIN,x.example']; // ];"));
  assert.ok(!next.includes('203.0.113.9'));
  assert.ok(next.includes("const MODE = 'chain';"));
});

test('a YAML-escaped name and credential are read back as the typed value', () => {
  // Verge writes entries with YAML quoting, not raw JS; a single-quoted value
  // doubles its quote and a double-quoted one escapes `\` and `"`.
  const name = "it's a #1 exit";
  const credential = 'a"b\\c#d';
  const text = [
    'proxies:',
    "- name: 'it''s a #1 exit'",
    '  type: socks5',
    '  server: 203.0.113.7',
    '  port: 1080',
    `  ${CREDENTIAL_FIELD}: "a\\"b\\\\c#d"`,
  ].join('\n');
  const entry = findConfigProxy(text, name);
  assert.ok(entry, 'the doubled-quote name must match the unescaped one');
  assert.equal(entry.credential, credential);
});

test('profiles.yaml yields the current profile and its attached script', () => {
  const yaml = [
    '# Profiles Config for Clash Verge',
    '',
    'current: RB8TRndVIDOG',
    'items:',
    '- uid: Merge',
    '  type: merge',
    '  name: null',
    '  file: Merge.yaml',
    '- uid: Script1',
    '  type: script',
    '  name: null',
    '  file: Script1.js',
    '- uid: RB8TRndVIDOG',
    '  type: remote',
    '  name: example',
    '  file: RB8TRndVIDOG.yaml',
    '  option:',
    '    merge: murK1SXVOzs9',
    '    script: Script1',
    '  selected:',
    '  - name: main',
    '    now: DIRECT',
  ].join('\n');
  const profiles = parseProfilesYaml(yaml);
  assert.equal(profiles.current, 'RB8TRndVIDOG');
  assert.equal(profiles.items.length, 3);
  assert.equal(attachedScript(profiles), 'Script1');
  assert.equal(profiles.items[2].type, 'remote');
});

test('the attached script is found first and unmarked files are ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verge-home-'));
  const appDir = path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev');
  const profilesDir = path.join(appDir, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'Attached.js'), template);
  fs.writeFileSync(path.join(profilesDir, 'Other.js'), template.replace('const MODE', 'const OTHER_MODE'));
  fs.writeFileSync(path.join(profilesDir, 'unrelated.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(appDir, 'profiles.yaml'), [
    'current: Remote1',
    'items:',
    '- uid: Attached',
    '  type: script',
    '  file: Attached.js',
    '- uid: Other',
    '  type: script',
    '  file: Other.js',
    '- uid: Remote1',
    '  type: remote',
    '  file: Remote1.yaml',
    '  option:',
    '    script: Other',
  ].join('\n'));

  const found = findExtensionScripts(home, {});
  assert.equal(found.length, 2);
  assert.equal(found[0].attached, true);
  assert.equal(path.basename(found[0].file), 'Other.js');
  assert.equal(found[1].attached, false);
});

test('loading the template reports its settings and exits', () => {
  const loaded = loadScript(template);
  assert.equal(loaded.settings.mode, 'chain');
  assert.equal(loaded.settings.exitGroup, '🛡️ 静态IP出口');
  assert.equal(loaded.settings.entranceGroup, '🛬 静态IP入口');
  assert.deepEqual(loaded.settings.targets, ['🚀 节点选择']);
  assert.equal(loaded.exits.length, 1);
});

test('the probe reports the chain node and the exit group the template injects', () => {
  const injection = probeInjection(replaceExitBlock(template, generateExitBlock([parseExitUri(LINK)])));
  const groupNames = injection.groups.map((group) => group.name);
  assert.deepEqual(groupNames, ['🛡️ 静态IP出口', '🛬 静态IP入口']);
  const chain = injection.proxies.find((proxy) => String(proxy.name).includes('（链式）'));
  assert.ok(chain, 'the chain node is injected');
  assert.equal(chain['dialer-proxy'], '🛬 静态IP入口');
  assert.equal(injection.proxies.some((proxy) => proxy.name === '🇭🇰 香港静态IP'), false);

  // The selector the template targets gains the exit group.
  const selector = injection.groups[0];
  assert.equal(selector.type, 'select');
});

test('an emptied exit list injects nothing', () => {
  const emptied = replaceExitBlock(template, generateExitBlock([]));
  const injection = probeInjection(emptied);
  assert.deepEqual(injection.proxies, []);
  assert.deepEqual(injection.groups, []);
});

test('a generated-config entry is read by name and stops at the next node', () => {
  const text = [
    'proxies:',
    '- name: US 421',
    '  type: vmess',
    '  server: 198.51.100.1',
    '  port: 443',
    `  ${CREDENTIAL_FIELD}: not-ours`,
    '- name: "Hong Kong exit（链式）"',
    '  type: socks5',
    '  server: 203.0.113.7',
    '  port: 1080',
    `  ${CREDENTIAL_FIELD}: 'quoted secret'`,
    '  dialer-proxy: 🛬 静态IP入口',
    '- name: JP 9',
    '  type: vmess',
    '  server: 198.51.100.2',
    '  port: 443',
    'proxy-groups:',
  ].join('\n');

  assert.deepEqual(findConfigProxy(text, 'Hong Kong exit（链式）'), {
    type: 'socks5',
    server: '203.0.113.7',
    port: 1080,
    credential: 'quoted secret',
  });
  assert.equal(findConfigProxy(text, 'Hong Kong exit'), null);
  assert.equal(findConfigProxy(text, 'missing'), null);
});

test('the generated entry is compared field by field, not only by credential', () => {
  const exit = {
    name: 'HK',
    type: 'socks5',
    server: '203.0.113.7',
    port: 1080,
    username: 'alice',
    credential: 'pw',
  };
  const text = [
    'proxies:',
    '- name: HK',
    '  type: socks5',
    '  server: 203.0.113.7',
    '  port: 1080',
    '  username: alice',
    `  ${CREDENTIAL_FIELD}: pw`,
    '  udp: true',
  ].join('\n');
  const entry = findConfigProxy(text, 'HK');

  assert.equal(proxyMatchesExit(entry, exit), true);
  // 只换用户名、协议或 TLS，地址和凭证不变，也是核心没收到的那一条。
  assert.equal(proxyMatchesExit(entry, { ...exit, username: 'bob' }), false);
  assert.equal(proxyMatchesExit(entry, { ...exit, type: 'http' }), false);
  assert.equal(proxyMatchesExit(entry, { ...exit, tls: true }), false);
  assert.equal(sameConfigProxy(entry, { ...entry, username: 'bob' }), false);
  assert.equal(sameConfigProxy(entry, { ...entry }), true);
});
