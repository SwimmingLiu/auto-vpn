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
