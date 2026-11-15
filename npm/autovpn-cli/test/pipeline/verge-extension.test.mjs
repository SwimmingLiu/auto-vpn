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
  assert.ok(exitNames.includes('🇭🇰 香港静态IP（链式）'));
  // 链式建得出来就不注入直连出口：留一个直连选项等于留一个绕过整条链的开关。
  assert.equal(exitNames.includes('🇭🇰 香港静态IP'), false);

  const twin = out.proxies.find((proxy) => proxy.name === '🇭🇰 香港静态IP（链式）');
  assert.equal(twin['dialer-proxy'], '🛬 静态IP入口');

  const exitGroup = out['proxy-groups'].find((group) => group.name === '🛡️ 静态IP出口');
  assert.deepEqual(exitGroup.proxies, ['🇭🇰 香港静态IP（链式）']);

  const entrance = out['proxy-groups'].find((group) => group.name === '🛬 静态IP入口');
  assert.deepEqual(entrance.proxies, ['US 421', 'JP 9']);

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
  assert.ok(out.proxies.some((proxy) => proxy.name === '🚀 节点选择 2（链式）'));
  assert.equal(out.proxies.some((proxy) => proxy.name === '🚀 节点选择 2'), false);
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
    const exit = out.proxies.find((p) => String(p.name).endsWith('（链式）'));
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
  assert.ok(out.proxies.some((p) => String(p.name).endsWith('（链式）')));
});

test('the Verge extension falls back to a direct exit only when no chain is wanted', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace("const MODE = 'chain'", "const MODE = 'direct'");
  const main = await loadExtension(source);
  const out = main(structuredClone(baseProfile), 'p');

  // MODE = 'direct' 是唯一不建链式的状态；这时直连出口是分组里唯一能用的东西，
  // 不注入的话出口分组会是空的，mihomo 会拒收整份配置。
  assert.ok(out.proxies.some((p) => p.name === '🇭🇰 香港静态IP'));
  const exitGroup = out['proxy-groups'].find((g) => g.name === '🛡️ 静态IP出口');
  assert.deepEqual(exitGroup.proxies, ['🇭🇰 香港静态IP', 'DIRECT']);
  assert.equal(out['proxy-groups'].some((g) => g.name === '🛬 静态IP入口'), false);
});

test('the Verge extension appends the exit group only to the default main selector', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));

  const profile = structuredClone(baseProfile);
  profile['proxy-groups'].push({ name: '☑️ 手动切换', type: 'select', proxies: ['US 421'] });
  const out = main(profile, 'p');

  const nodeSelect = out['proxy-groups'].find((g) => g.name === '🚀 节点选择');
  assert.deepEqual(nodeSelect.proxies, ['US 421', 'JP 9', 'DIRECT', '🛡️ 静态IP出口']);
  // 没点名的 select 分组不挂，否则同一件事有两处能改，看着像重复。
  const manual = out['proxy-groups'].find((g) => g.name === '☑️ 手动切换');
  assert.deepEqual(manual.proxies, ['US 421']);
});

test('an empty EXIT_GROUP_TARGETS means every select group', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace("const EXIT_GROUP_TARGETS = ['🚀 节点选择'];", 'const EXIT_GROUP_TARGETS = [];');
  const main = await loadExtension(source);

  const profile = structuredClone(baseProfile);
  profile['proxy-groups'].push({ name: '☑️ 手动切换', type: 'select', proxies: ['US 421'] });
  const out = main(profile, 'p');

  for (const 名 of ['🚀 节点选择', '☑️ 手动切换']) {
    const g = out['proxy-groups'].find((item) => item.name === 名);
    assert.ok(g.proxies.includes('🛡️ 静态IP出口'), `${名} must receive the exit group`);
  }
  // url-test 分组不挂：出口只有一个，自动测速没有意义。
  const autoSelect = out['proxy-groups'].find((g) => g.name === '♻️ 自动选择');
  assert.deepEqual(autoSelect.proxies, ['US 421']);
});

test('a string EXIT_GROUP_TARGETS is one target, not "all groups"', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace("const EXIT_GROUP_TARGETS = ['🚀 节点选择'];", "const EXIT_GROUP_TARGETS = '☑️ 手动切换';");
  const main = await loadExtension(source);

  const profile = structuredClone(baseProfile);
  profile['proxy-groups'].push({ name: '☑️ 手动切换', type: 'select', proxies: ['US 421'] });
  const out = main(profile, 'p');

  const manual = out['proxy-groups'].find((g) => g.name === '☑️ 手动切换');
  assert.ok(manual.proxies.includes('🛡️ 静态IP出口'));
  const nodeSelect = out['proxy-groups'].find((g) => g.name === '🚀 节点选择');
  assert.equal(nodeSelect.proxies.includes('🛡️ 静态IP出口'), false);
});

test('the Verge extension keeps a neighbour node on the exit address and leaves no dangling member', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));
  const profile = structuredClone(baseProfile);
  // 同一台机器、名字带出口名，但不是本脚本生成的：不能删，更不能留下悬空成员。
  profile.proxies.push({ name: '🇭🇰 香港静态IP 备用', type: 'vmess', server: '198.51.100.10', port: 1080, uuid: 'x' });
  profile['proxy-groups'][0].proxies.push('🇭🇰 香港静态IP 备用');
  profile['proxy-groups'][1].proxies.push('🇭🇰 香港静态IP 备用');

  const out = main(profile, 'p');
  assert.ok(out.proxies.some((p) => p.name === '🇭🇰 香港静态IP 备用'));
  for (const g of out['proxy-groups']) {
    for (const 成员 of g.proxies ?? []) {
      const 能解析 = out.proxies.some((p) => p.name === 成员)
        || out['proxy-groups'].some((x) => x.name === 成员)
        || ['DIRECT', 'REJECT'].includes(成员);
      assert.ok(能解析, `${g.name} 的成员 ${成员} 必须能解析`);
    }
  }
});

test('the Verge extension does not accumulate RULES_TO_EXIT rules across runs', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace('const RULES_TO_EXIT = [];', "const RULES_TO_EXIT = ['DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口'];");
  const main = await loadExtension(source);

  const once = main(structuredClone(baseProfile), 'p');
  const twice = main(structuredClone(once), 'p');
  assert.equal(twice.rules.filter((规则) => String(规则).includes('openai.com')).length, 1);
  assert.deepEqual(twice, once);
});

test('the Verge extension retargets rules when the exit group gets its name back', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace('const RULES_TO_EXIT = [];', "const RULES_TO_EXIT = ['DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口'];");
  const main = await loadExtension(source);

  const profile = structuredClone(baseProfile);
  // 影子节点把出口组挤成了 `… 2`，规则跟着改名。
  profile.proxies.push({ name: '🛡️ 静态IP出口', type: 'vmess', server: '9.9.9.9', port: 443, uuid: 'x' });
  const once = main(profile, 'p');
  const 旧组名 = once['proxy-groups'].find((g) => g.name.startsWith('🛡️')).name;
  assert.equal(旧组名, '🛡️ 静态IP出口 2');
  assert.equal(once.rules[0], `DOMAIN-SUFFIX,openai.com,${旧组名}`);

  // 影子节点消失后分组回到原名，旧规则必须跟着改，不能留着指向 `… 2`。
  const held = structuredClone(once);
  held.proxies = held.proxies.filter((p) => p.name !== '🛡️ 静态IP出口');
  const again = main(held, 'p');
  assert.equal(again['proxy-groups'].find((g) => g.name.startsWith('🛡️')).name, '🛡️ 静态IP出口');
  assert.equal(again.rules[0], 'DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口');
  assert.equal(again.rules.filter((规则) => String(规则).includes('openai.com')).length, 1);
});

test('the Verge extension removes its rules when the chain disappears', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace('const RULES_TO_EXIT = [];', "const RULES_TO_EXIT = ['DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口'];");
  const main = await loadExtension(source);

  const once = main(structuredClone(baseProfile), 'p');
  const held = structuredClone(once);
  held.proxies = held.proxies.filter((p) => String(p.name).endsWith('（链式）'));
  const out = main(held, 'p');
  assert.equal(out.rules.some((规则) => String(规则).includes('openai.com')), false);
});

test('a rule written with spaces or no-resolve is cleaned up like any other', async () => {
  const source = (await readFile(scriptPath, 'utf8')).replace(
    'const RULES_TO_EXIT = [];',
    "const RULES_TO_EXIT = ['DOMAIN-SUFFIX, openai.com, 🛡️ 静态IP出口', 'IP-CIDR,198.51.100.0/24,🛡️ 静态IP出口,no-resolve'];"
  );
  const main = await loadExtension(source);
  const count = (config, needle) => config.rules.filter((rule) => String(rule).includes(needle)).length;

  const once = main(structuredClone(baseProfile), 'p');
  assert.equal(count(once, 'openai.com'), 1);
  assert.equal(count(once, '198.51.100.0'), 1);

  // 目标字段两侧有空格、后面跟着 no-resolve，都不能妨碍认出这是上一轮的规则。
  const twice = main(structuredClone(once), 'p');
  assert.equal(count(twice, 'openai.com'), 1, 'a spaced rule must not pile up');
  assert.equal(count(twice, '198.51.100.0'), 1, 'a no-resolve rule must not pile up');

  const cleared = await loadExtension(
    source.replace(/const STATIC_EXITS = \[[\s\S]*?\n\];/, 'const STATIC_EXITS = [];')
  );
  const out = cleared(twice, 'p');
  assert.equal(out.rules.some((rule) => /openai\.com|198\.51\.100\.0/.test(String(rule))), false);
  assert.equal(out.rules.some((rule) => String(rule).includes('静态IP')), false);
});

test('the Verge extension removes its nodes when the exit list is emptied', async () => {
  const source = await readFile(scriptPath, 'utf8');
  const withExit = await loadExtension(
    source.replace('const RULES_TO_EXIT = [];', "const RULES_TO_EXIT = ['DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口'];")
  );
  const once = withExit(structuredClone(baseProfile), 'p');
  // 前置条件：这一轮确实注入了规则，否则下面那条规则断言在空集上成立。
  assert.ok(once.rules.some((规则) => String(规则).includes('openai.com')));

  const main = await loadExtension(source.replace(/const STATIC_EXITS = \[[\s\S]*?\n\];/, 'const STATIC_EXITS = [];'));
  const out = main(once, 'p');

  assert.equal(out.proxies.some((p) => String(p.name).includes('静态IP')), false);
  assert.equal(out['proxy-groups'].some((g) => String(g.name).includes('静态IP')), false);
  assert.equal(out.rules.some((规则) => String(规则).includes('静态IP')), false);
  // 清空出口只删自己注入的东西：入口分组的成员是订阅自己的节点。
  assert.ok(out.proxies.some((p) => p.name === 'US 421'));
  assert.ok(out.proxies.some((p) => p.name === 'JP 9'));
});

/** Drop the marker the previous extension version did not write. */
function withoutMarker(config) {
  const out = structuredClone(config);
  for (const proxy of out.proxies) delete proxy.__static_exit;
  for (const group of out['proxy-groups']) delete group.__static_exit;
  return out;
}

function assertMembersResolve(config) {
  for (const group of config['proxy-groups']) {
    for (const member of group.proxies ?? []) {
      const resolves = config.proxies.some((proxy) => proxy.name === member)
        || config['proxy-groups'].some((other) => other.name === member)
        || ['DIRECT', 'REJECT'].includes(member);
      assert.ok(resolves, `${group.name} 的成员 ${member} 必须能解析`);
    }
  }
}

test('the Verge extension clears an injection made by the previous version', async () => {
  const source = await readFile(scriptPath, 'utf8');
  const withExit = await loadExtension(
    source.replace('const RULES_TO_EXIT = [];', "const RULES_TO_EXIT = ['DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口'];")
  );
  const once = withExit(structuredClone(baseProfile), 'p');
  // 前置条件：这一轮确实注入了节点、分组和规则，否则下面的断言全是在空集上成立。
  assert.ok(once.proxies.some((proxy) => String(proxy.name).endsWith('（链式）')));
  assert.ok(once.rules.some((rule) => String(rule).includes('openai.com')));

  // 上一版脚本注入的东西没有 __static_exit 标记，只能按结构认。
  const legacy = withoutMarker(once);
  const cleared = await loadExtension(source.replace(/const STATIC_EXITS = \[[\s\S]*?\n\];/, 'const STATIC_EXITS = [];'));
  const out = cleared(legacy, 'p');

  assert.equal(out.proxies.some((proxy) => String(proxy.name).includes('静态IP')), false);
  assert.equal(out['proxy-groups'].some((group) => String(group.name).includes('静态IP')), false);
  assert.equal(out.rules.some((rule) => String(rule).includes('静态IP') || String(rule).includes('openai.com')), false);
  assert.ok(out.proxies.some((proxy) => proxy.name === 'US 421'), 'subscription nodes must survive');
  assert.ok(out.proxies.some((proxy) => proxy.name === 'JP 9'), 'subscription nodes must survive');
  assertMembersResolve(out);
});

test('a cleared injection from the previous version still loads in mihomo', async (t) => {
  try {
    await run('mihomo', ['-v']);
  } catch {
    t.skip('mihomo binary is not installed');
    return;
  }

  const source = (await readFile(scriptPath, 'utf8')).replace(
    'const RULES_TO_EXIT = [];',
    "const RULES_TO_EXIT = ['DOMAIN-SUFFIX, openai.com, 🛡️ 静态IP出口', 'IP-CIDR,198.51.100.0/24,🛡️ 静态IP出口,no-resolve'];"
  );
  const withExit = await loadExtension(source);
  const legacy = withoutMarker(withExit(structuredClone(baseProfile), 'p'));
  const cleared = await loadExtension(source.replace(/const STATIC_EXITS = \[[\s\S]*?\n\];/, 'const STATIC_EXITS = [];'));
  const out = cleared(legacy, 'p');
  // 带空格和 no-resolve 的规则也在这一轮里被清掉，否则清空出口后它们指向已删的分组。
  assert.equal(out.rules.some((rule) => /openai\.com|198\.51\.100\.0/.test(String(rule))), false);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'verge-extension-'));
  const configPath = path.join(dir, 'cleared.yaml');
  await writeFile(configPath, JSON.stringify(out, null, 2), 'utf8');
  const { stdout, stderr } = await run('mihomo', ['-t', '-f', configPath, '-d', dir], { timeout: 120_000 });
  assert.match(`${stdout}${stderr}`, /test is successful/, 'clearing a previous-version injection must still load');
});

test('renaming the exit drops the old node from the groups that listed it', async () => {
  const source = await readFile(scriptPath, 'utf8');
  const once = await loadExtension(source);
  const held = once(structuredClone(baseProfile), 'p');
  // 用户在 🚀 节点选择 里手动钉住了旧的链式节点。
  held['proxy-groups'].find((group) => group.name === '🚀 节点选择').proxies.push('🇭🇰 香港静态IP（链式）');

  const renamed = await loadExtension(source.replace("name: '🇭🇰 香港静态IP'", "name: '🇭🇰 香港家宽'"));
  const out = renamed(held, 'p');
  assert.ok(out.proxies.some((proxy) => proxy.name === '🇭🇰 香港家宽（链式）'));
  assert.equal(out.proxies.some((proxy) => proxy.name === '🇭🇰 香港静态IP（链式）'), false);
  assert.equal(
    out['proxy-groups'].find((group) => group.name === '🚀 节点选择').proxies.includes('🇭🇰 香港静态IP（链式）'),
    false
  );
  assertMembersResolve(out);
});

test('a subscription node whose name only looks like an exit survives', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));
  const profile = structuredClone(baseProfile);
  // 和出口同地址，名字带上前导零。`唯一()` 只生成 `2`、`3`…，不会生成 `01`，
  // 所以这是订阅自己的节点，不能当成上一轮的产物删掉。
  profile.proxies.push({ name: '🇭🇰 香港静态IP 01', type: 'socks5', server: '198.51.100.10', port: 1080 });
  profile.rules.unshift('DOMAIN-SUFFIX,intranet.example,🇭🇰 香港静态IP 01');
  const out = main(profile, 'p');

  assert.ok(out.proxies.some((proxy) => proxy.name === '🇭🇰 香港静态IP 01'));
  assert.ok(out.rules.some((rule) => String(rule).includes('intranet.example')));
});

test('a node that dials a removed exit goes with it', async () => {
  const source = await readFile(scriptPath, 'utf8');
  const once = await loadExtension(source);
  const held = once(structuredClone(baseProfile), 'p');
  const chain = '🇭🇰 香港静态IP（链式）';
  // 用户把一条规则和另一条节点都挂在这条注入的链式节点上。
  held.rules = [`DOMAIN-SUFFIX,intranet.example,${chain}`, ...held.rules];
  held.proxies.push({ name: '内网中转', type: 'socks5', server: '127.0.0.1', port: 1080, 'dialer-proxy': chain });

  const renamed = await loadExtension(source.replace("name: '🇭🇰 香港静态IP'", "name: '🇭🇰 香港家宽'"));
  const out = renamed(held, 'p');

  assert.ok(out.proxies.some((proxy) => proxy.name === '🇭🇰 香港家宽（链式）'));
  assert.equal(out.proxies.some((proxy) => proxy.name === chain), false);
  // 指着已删节点的节点和规则都不能留下，mihomo 会因为 not found 拒收整份配置。
  assert.equal(out.proxies.some((proxy) => proxy.name === '内网中转'), false);
  assert.equal(out.rules.some((rule) => String(rule).includes('intranet.example')), false);
  assertMembersResolve(out);
});

test('a second run recognises a previous-version chain node by name', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));
  const once = main(structuredClone(baseProfile), 'p');
  const again = main(withoutMarker(once), 'p');

  // 认不出来就会并排留下两条链式节点，第二条带 ` 2` 后缀。
  assert.equal(again.proxies.filter((proxy) => String(proxy.name).endsWith('（链式）')).length, 1);
  assert.equal(again.proxies.some((proxy) => String(proxy.name).includes('（链式） 2')), false);
  assert.deepEqual(
    again.proxies.map((proxy) => proxy.name).sort(),
    once.proxies.map((proxy) => proxy.name).sort()
  );
});

test('a previous-version chain node is recognised when the exit name has the separator', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace("name: '🇭🇰 香港静态IP'", "name: '🇭🇰 香港 ➜ 静态IP'");
  const main = await loadExtension(source);
  const once = main(structuredClone(baseProfile), 'p');
  const again = main(withoutMarker(once), 'p');

  assert.equal(again.proxies.filter((proxy) => String(proxy.name).endsWith('（链式）')).length, 1);
  assert.equal(again.proxies.some((proxy) => String(proxy.name).includes('（链式） 2')), false);
});

test('an exit name containing the chain separator still rebuilds cleanly', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace("name: '🇭🇰 香港静态IP'", "name: '🇭🇰 香港 ➜ 静态IP'");
  const main = await loadExtension(source);

  const once = main(structuredClone(baseProfile), 'p');
  const twice = main(structuredClone(once), 'p');
  assert.equal(twice.proxies.filter((p) => String(p.name).endsWith('（链式）')).length, 1);
  assert.deepEqual(twice, once);
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
  assert.equal(出口节点.length, 1, 'the chain node must not be duplicated');
  assert.ok(again['proxy-groups'].some((g) => g.name.startsWith('🛡️')));
});

test('the Verge extension rebuilds a deleted entrance group instead of dangling the chain', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));
  const once = main(structuredClone(baseProfile), 'p');
  const held = structuredClone(once);
  held['proxy-groups'] = held['proxy-groups'].filter((g) => g.name !== '🛬 静态IP入口');
  const again = main(held, 'p');

  const entrance = again['proxy-groups'].find((g) => g.name === '🛬 静态IP入口');
  assert.ok(entrance, 'the entrance group must come back');
  const chain = again.proxies.find((p) => String(p.name).endsWith('（链式）'));
  // dialer-proxy 必须指回真正存在的分组，否则 mihomo 报 not found 并拒收整份配置。
  assert.equal(chain['dialer-proxy'], entrance.name);
});

test('the Verge extension rebuilds a deleted exit group without duplicating the entrance', async () => {
  const source = (await readFile(scriptPath, 'utf8'))
    .replace("const EXIT_GROUP_TARGETS = ['🚀 节点选择'];", 'const EXIT_GROUP_TARGETS = [];');
  const main = await loadExtension(source);
  const once = main(structuredClone(baseProfile), 'p');
  const held = structuredClone(once);
  held['proxy-groups'] = held['proxy-groups'].filter((g) => !g.name.startsWith('🛡️'));
  const again = main(held, 'p');

  assert.ok(again['proxy-groups'].some((g) => g.name === '🛡️ 静态IP出口'), 'the exit group must come back');
  const entrances = again['proxy-groups'].filter((g) => g.name.startsWith('🛬'));
  assert.equal(entrances.length, 1, 'one entrance group, not a renamed duplicate');
  // 入口组 → 出口组 → 链式节点 → 入口组 会形成 dialer 环，选错一次就解析回自身。
  assert.equal(entrances[0].proxies.includes('🛡️ 静态IP出口'), false);
});

test('the Verge extension drops a member that points at a vanished exit group', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));
  const once = main(structuredClone(baseProfile), 'p');
  const held = structuredClone(once);
  held['proxy-groups'] = held['proxy-groups'].filter((g) => g.name !== '🛡️ 静态IP出口');
  const 选择 = held['proxy-groups'].find((g) => g.name === '🚀 节点选择');
  选择.proxies = 选择.proxies.filter((名) => 名 !== '🛡️ 静态IP出口');
  选择.proxies.push('🛡️ 静态IP出口 2');
  const out = main(held, 'p');

  const 输出选择 = out['proxy-groups'].find((g) => g.name === '🚀 节点选择');
  assert.equal(输出选择.proxies.includes('🛡️ 静态IP出口 2'), false);
  assert.equal(输出选择.proxies.includes('🛡️ 静态IP出口'), true);
});

test('the Verge extension injects nothing when there is no upstream to chain through', async () => {
  const main = await loadExtension(await readFile(scriptPath, 'utf8'));
  const once = main(structuredClone(baseProfile), 'p');
  // 订阅里只剩本脚本上一轮建的链式节点：没有可用的上一跳。
  const held = structuredClone(once);
  held.proxies = held.proxies.filter((p) => String(p.name).endsWith('（链式）'));
  const out = main(held, 'p');

  // 宁可这一轮没有出口，也不退回直连——那正是脚本要堵的那道门。
  assert.equal(out.proxies.some((p) => String(p.name).includes('静态IP')), false);
  assert.equal(out['proxy-groups'].some((g) => String(g.name).startsWith('🛡️')), false);
  assert.equal(out['proxy-groups'].some((g) => String(g.name).startsWith('🛬')), false);
});

test('the Verge extension recovers every deleted-group shape into a loadable config', async (t) => {
  let mihomoBin = '';
  try {
    await run('mihomo', ['-v']);
    mihomoBin = 'mihomo';
  } catch {
    t.skip('mihomo binary is not installed');
    return;
  }

  const source = (await readFile(scriptPath, 'utf8'))
    .replace("const EXIT_GROUP_TARGETS = ['🚀 节点选择'];", 'const EXIT_GROUP_TARGETS = [];')
    .replace('const RULES_TO_EXIT = [];', "const RULES_TO_EXIT = ['DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口'];");
  const main = await loadExtension(source);
  const once = main(structuredClone(baseProfile), 'p');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verge-recovery-'));
  const 场景 = {
    noEntrance: (profile) => {
      profile['proxy-groups'] = profile['proxy-groups'].filter((g) => g.name !== '🛬 静态IP入口');
    },
    noExit: (profile) => {
      profile['proxy-groups'] = profile['proxy-groups'].filter((g) => !g.name.startsWith('🛡️'));
    },
    staleMember: (profile) => {
      profile['proxy-groups'] = profile['proxy-groups'].filter((g) => g.name !== '🛡️ 静态IP出口');
      const 选择 = profile['proxy-groups'].find((g) => g.name === '🚀 节点选择');
      选择.proxies = 选择.proxies.filter((名) => 名 !== '🛡️ 静态IP出口');
      选择.proxies.push('🛡️ 静态IP出口 2');
    }
  };

  for (const [label, mutate] of Object.entries(场景)) {
    const held = structuredClone(once);
    mutate(held);
    const configPath = path.join(dir, `${label}.yaml`);
    await writeFile(configPath, JSON.stringify(main(held, 'p'), null, 2), 'utf8');
    const { stdout, stderr } = await run(mihomoBin, ['-t', '-f', configPath, '-d', dir], { timeout: 120_000 });
    assert.match(`${stdout}${stderr}`, /test is successful/, `${label} must recover into a loadable config`);
  }
});
