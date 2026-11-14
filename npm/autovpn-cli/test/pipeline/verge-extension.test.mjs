import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const scriptPath = path.join(repoRoot, 'docs', 'clash-verge-extension.js');

/** Load the extension script the way Clash Verge Rev does: eval it, call main(). */
async function loadExtension(source) {
  const module = { exports: {} };
  new Function('module', 'exports', `${source}\nmodule.exports = { main };`)(module, module.exports);
  return module.exports.main;
}

const baseProfile = {
  'mixed-port': 7890,
  mode: 'rule',
  proxies: [
    { name: 'US 421', type: 'vmess', server: '1.2.3.4', port: 443, uuid: '11111111-2222-4333-8444-555555555555', alterId: 0, cipher: 'auto' },
    { name: 'JP 9', type: 'vmess', server: '5.6.7.8', port: 443, uuid: '11111111-2222-4333-8444-555555555555', alterId: 0, cipher: 'auto' }
  ],
  'proxy-groups': [
    { name: '🚀 节点选择', type: 'select', proxies: ['US 421', 'JP 9', 'DIRECT'] },
    { name: '♻️ 自动选择', type: 'url-test', proxies: ['US 421'] }
  ],
  rules: ['MATCH,🚀 节点选择']
};

test('the Verge extension adds a chained exit and an entrance group', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));
  const out = main(structuredClone(baseProfile), 'SwimmingLiu-VPN');

  const exitNames = out.proxies.map((proxy) => proxy.name);
  assert.ok(exitNames.includes('🇭🇰 香港静态IP'));
  assert.ok(exitNames.includes('🇭🇰 香港静态IP（链式）'));

  const twin = out.proxies.find((proxy) => proxy.name === '🇭🇰 香港静态IP（链式）');
  assert.equal(twin['dialer-proxy'], '🛬 静态IP入口');

  const exitGroup = out['proxy-groups'].find((group) => group.name === '🛡️ 静态IP出口');
  assert.deepEqual(exitGroup.proxies, ['🇭🇰 香港静态IP（链式）', '🇭🇰 香港静态IP', 'DIRECT']);

  const entrance = out['proxy-groups'].find((group) => group.name === '🛬 静态IP入口');
  assert.deepEqual(entrance.proxies, ['US 421', 'JP 9', 'DIRECT']);

  const nodeSelect = out['proxy-groups'].find((group) => group.name === '🚀 节点选择');
  assert.deepEqual(nodeSelect.proxies, ['US 421', 'JP 9', 'DIRECT', '🛡️ 静态IP出口']);
  // url-test 分组不能挂只有选项的分组
  const autoSelect = out['proxy-groups'].find((group) => group.name === '♻️ 自动选择');
  assert.deepEqual(autoSelect.proxies, ['US 421']);
});

test('the Verge extension is idempotent across repeated runs', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));
  const once = main(structuredClone(baseProfile), 'p');
  const twice = main(structuredClone(once), 'p');

  assert.deepEqual(twice, once);
});

test('the Verge extension leaves a profile without proxies alone', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));
  const empty = { 'proxy-groups': [], proxies: [] };

  assert.deepEqual(main(structuredClone(empty), 'p'), empty);
});

test('the Verge extension never shadows an existing group name', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace("name: '🇭🇰 香港静态IP'", "name: '🚀 节点选择'");
  const main = await loadExtension(source);
  const out = main(structuredClone(baseProfile), 'p');

  assert.ok(!out.proxies.some((proxy) => proxy.name === '🚀 节点选择'));
  assert.ok(out.proxies.some((proxy) => proxy.name === '🚀 节点选择 2'));
  assert.ok(out.proxies.some((proxy) => proxy.name === '🚀 节点选择 2（链式）'));
});

test('the Verge extension output loads in mihomo', async (t) => {
  let mihomoBin = '';
  try {
    await run('mihomo', ['-v']);
    mihomoBin = 'mihomo';
  } catch {
    t.skip('mihomo binary is not installed');
    return;
  }

  const source = await readFile(scriptPath, 'utf8');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verge-extension-'));
  for (const [label, patched] of [
    ['chain', source],
    ['all', source.replace("const MODE = 'chain'", "const MODE = 'all'")],
    ['direct', source.replace("const MODE = 'chain'", "const MODE = 'direct'")]
  ]) {
    const main = await loadExtension(patched);
    const out = main(structuredClone(baseProfile), 'p');
    const configPath = path.join(dir, `${label}.yaml`);
    // mihomo accepts JSON as YAML 1.2, so no YAML dumper dependency is needed here.
    await writeFile(configPath, JSON.stringify(out, null, 2), 'utf8');
    const { stdout, stderr } = await run(mihomoBin, ['-t', '-f', configPath, '-d', dir], { timeout: 120_000 });
    assert.match(`${stdout}${stderr}`, /test is successful/, `${label} mode must load in mihomo`);
  }
});

test('the Verge extension normalises exit types mihomo would reject', async () => {
  const source = await readFile(scriptPath, 'utf8');
  // `socks5h` is a URI spelling; mihomo only knows `socks5` and answers
  // `unsupport proxy type: socks5h`, which fails the whole profile.
  for (const [declared, expected, tls] of [
    ['socks5h', 'socks5', false],
    ['socks', 'socks5', false],
    ['https', 'http', true],
    ['http+tls', 'http', true]
  ]) {
    const patched = source.replace("type: 'socks5'", `type: '${declared}'`);
    const main = await loadExtension(patched);
    const out = main(structuredClone(baseProfile), 'p');
    const exit = out.proxies.find((p) => p.name === '🇭🇰 香港静态IP');
    assert.ok(exit, `${declared}: the exit must be injected`);
    assert.equal(exit.type, expected, `${declared} must become ${expected}`);
    if (tls) assert.equal(exit.tls, true, `${declared} must carry tls`);
  }
});

test('the Verge extension tolerates a non-string proxy name', async () => {
  const source = await readFile(scriptPath, 'utf8');
  const main = await loadExtension(source);
  const profile = structuredClone(baseProfile);
  profile.proxies.push({ name: 123, type: 'vmess', server: '2.2.2.2', port: 443, uuid: 'x' });
  // A numeric name used to throw `名.includes is not a function` and abort main(),
  // so the subscription got no exit at all.
  const out = main(profile, 'p');
  assert.ok(out.proxies.some((p) => p.name === '🇭🇰 香港静态IP'));
});

test('the Verge extension still injects when a node shares the exit address', async () => {
  const source = await readFile(scriptPath, 'utf8');
  const main = await loadExtension(source);
  const profile = structuredClone(baseProfile);
  // Same server:port as the configured exit, different name: this is a normal
  // node, not an injected one, and must not make the guard skip injection.
  profile.proxies.push({ name: '我的香港', type: 'vmess', server: '198.51.100.10', port: 1080, uuid: 'x' });
  const out = main(profile, 'p');
  assert.ok(out.proxies.some((p) => p.name === '🇭🇰 香港静态IP（链式）'));
});

test('the Verge extension rewrites RULES_TO_EXIT when the group was renamed', async () => {
  const source = await readFile(scriptPath, 'utf8');
  const patched = source.replace(
    'const RULES_TO_EXIT = [];',
    "const RULES_TO_EXIT = ['DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口'];"
  );
  const main = await loadExtension(patched);
  const profile = structuredClone(baseProfile);
  // A proxy already holds the exit group's name, so the group becomes `… 2`.
  profile.proxies.push({ name: '🛡️ 静态IP出口', type: 'vmess', server: '9.9.9.9', port: 443, uuid: 'x' });
  const out = main(profile, 'p');
  const 出口组 = out['proxy-groups'].find((g) => g.name.startsWith('🛡️ 静态IP出口'));
  assert.ok(出口组);
  // The rule must point at the group that actually exists, or mihomo rejects the file.
  assert.equal(out.rules[0], `DOMAIN-SUFFIX,openai.com,${出口组.name}`);
});

test('the Verge extension creates a rules list when the profile has none', async () => {
  const source = await readFile(scriptPath, 'utf8');
  const patched = source.replace(
    'const RULES_TO_EXIT = [];',
    "const RULES_TO_EXIT = ['DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口'];"
  );
  const main = await loadExtension(patched);
  const profile = structuredClone(baseProfile);
  delete profile.rules;
  const out = main(profile, 'p');
  assert.ok(Array.isArray(out.rules) && out.rules.length === 1, 'a rules list must be created');
});

test('the Verge extension recovers a deleted group without duplicating nodes', async () => {
  const source = await readFile(scriptPath, 'utf8');
  const main = await loadExtension(source);
  const once = main(structuredClone(baseProfile), 'p');
  // The user deleted the group in the UI; the exit nodes are still there.
  const held = structuredClone(once);
  held['proxy-groups'] = held['proxy-groups'].filter((g) => !g.name.startsWith('🛡️'));
  const again = main(held, 'p');
  const 出口节点 = again.proxies.filter((p) => String(p.name).includes('静态IP'));
  assert.equal(出口节点.length, 2, 'the exit node and its chain must not be duplicated');
  assert.ok(again['proxy-groups'].some((g) => g.name.startsWith('🛡️')));
});
