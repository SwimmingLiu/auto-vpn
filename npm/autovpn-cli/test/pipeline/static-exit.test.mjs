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
const templatePath = path.join(repoRoot, 'templates', 'share-worker', 'vpn.js');

/**
 * Load the static-exit block straight out of the deployed Worker template.
 *
 * The block is fenced by `// <静态出口 begin>` / `// <静态出口 end>` so this test
 * exercises the exact source the Worker ships, not a copy that can drift.
 */
async function loadStaticExit() {
  const source = await readFile(templatePath, 'utf8');
  const start = source.indexOf('// <静态出口 begin>');
  const end = source.indexOf('// <静态出口 end>');
  assert.ok(start > 0 && end > start, 'template must carry the static-exit block markers');
  const block = source.slice(start, end + '// <静态出口 end>'.length);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-exit-'));
  const modulePath = path.join(dir, 'block.mjs');
  await writeFile(
    modulePath,
    `${block}\nexport { 解析静态出口清单, 解析静态出口地址, 应用静态出口, 解析YAML节点名 };\n`,
    'utf8'
  );
  return import(modulePath);
}

const baseClash = `mixed-port: 1
proxies:
  - {name: "US 421", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
  - name: "JP 9"
    type: vmess
    server: 5.6.7.8
    port: 443
    uuid: 11111111-2222-4333-8444-555555555555
    alterId: 0
    cipher: auto
proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies:
      - "US 421"
      - "JP 9"
      - DIRECT
  - name: "♻️ 自动选择"
    type: url-test
    proxies:
      - "US 421"
rules:
  - MATCH,🚀 节点选择
`;

test('static exit parses socks5 and http URI lists', async () => {
  const { 解析静态出口清单 } = await loadStaticExit();
  const entries = 解析静态出口清单({
    STATIC_EXIT: 'socks5://USER:PASS@198.51.100.10:1080#🇭🇰 香港静态IP\nhttp://198.51.100.11:8080#住宅出口'
  });

  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    name: '🇭🇰 香港静态IP',
    type: 'socks5',
    server: '198.51.100.10',
    port: 1080,
    username: 'USER',
    password: 'PASS',
    udp: true
  });
  assert.deepEqual(entries[1], {
    name: '住宅出口',
    type: 'http',
    server: '198.51.100.11',
    port: 8080
  });
});

test('static exit keeps IPv6 literals and defaults the port', async () => {
  const { 解析静态出口清单 } = await loadStaticExit();
  const [entry] = 解析静态出口清单({ STATIC_EXIT: 'socks5://[2001:db8::1]#v6' });

  assert.equal(entry.server, '[2001:db8::1]');
  assert.equal(entry.port, 1080);
  assert.equal(entry.name, 'v6');
});

test('static exit accepts a JSON list and ignores unusable rows', async () => {
  const { 解析静态出口清单 } = await loadStaticExit();
  const entries = 解析静态出口清单({
    STATIC_EXIT_JSON: JSON.stringify([
      { name: '住宅', type: 'http', server: '198.51.100.7', port: 8080 },
      { name: '', type: 'http', server: '198.51.100.8', port: 8080 },
      { name: '缺端口', type: 'http', server: '198.51.100.9' }
    ])
  });

  assert.deepEqual(entries.map((entry) => entry.name), ['住宅']);
});

test('static exit injects the egress node, a chained twin and an entrance group', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const out = 应用静态出口(baseClash, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#静态出口' });

  assert.match(out, /- \{name: "静态出口", type: "socks5", server: "198\.51\.100\.10", port: 1080, username: "u", password: "p", udp: true\}/);
  assert.match(out, /- \{name: "静态出口（链式）", type: "socks5"[^}]*, dialer-proxy: "🛬 静态IP入口"\}/);
  assert.match(out, /- name: "🛡️ 静态IP出口"\n\s+type: select\n\s+proxies:\n\s+- "静态出口（链式）"\n\s+- "静态出口"/);
  assert.match(out, /- name: "🛬 静态IP入口"\n\s+type: select\n\s+proxies:\n\s+- "US 421"\n\s+- "JP 9"\n\s+- DIRECT/);
  // Block-style entries keep their own indentation when new entries are appended.
  assert.match(out, /\n {4}cipher: auto\n  - \{name: "静态出口"/);
});

test('static exit mounts its group on every select group exactly once', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const out = 应用静态出口(baseClash, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#静态出口' });
  const nodeSelect = out.slice(out.indexOf('- name: "🚀 节点选择"'), out.indexOf('- name: "♻️ 自动选择"'));
  const autoSelect = out.slice(out.indexOf('- name: "♻️ 自动选择"'), out.indexOf('- name: "🛡️ 静态IP出口"'));

  assert.ok(nodeSelect.includes('- "🛡️ 静态IP出口"'), 'select group must list the egress group');
  assert.ok(!autoSelect.includes('🛡️ 静态IP出口'), 'url-test groups cannot hold a select-only group');

  const twice = 应用静态出口(out, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#静态出口' });
  assert.equal(twice, out, 'a second pass must be a no-op');
});

test('static exit twin mode all chains one node per entrance', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const out = 应用静态出口(baseClash, {
    STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#静态出口',
    STATIC_EXIT_TWINS: 'all'
  });

  assert.match(out, /name: "US 421 ➜ 静态出口"[^}]*dialer-proxy: "US 421"/);
  assert.match(out, /name: "JP 9 ➜ 静态出口"[^}]*dialer-proxy: "JP 9"/);
  assert.ok(!out.includes('🛬 静态IP入口'), 'all mode does not need an entrance group');
});

test('static exit twin mode off leaves only the direct egress node', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const out = 应用静态出口(baseClash, {
    STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#静态出口',
    STATIC_EXIT_TWINS: 'off'
  });

  assert.ok(out.includes('name: "静态出口"'));
  assert.ok(!out.includes('dialer-proxy'));
  assert.ok(!out.includes('静态IP入口'));
  assert.match(out, /- name: "🛡️ 静态IP出口"\n\s+type: select\n\s+proxies:\n\s+- "静态出口"/);
});

test('static exit leaves a subscription untouched when no list is configured', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  assert.equal(应用静态出口(baseClash, {}), baseClash);
  assert.equal(应用静态出口(baseClash, { STATIC_EXIT: 'not-a-proxy' }), baseClash);
});

test('static exit renames colliding entries instead of shadowing them', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const out = 应用静态出口(baseClash, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#US 421' });

  assert.match(out, /- \{name: "US 421 2", type: "socks5"/);
  assert.match(out, /- "US 421 2（链式）"/);
});

test('static exit output is accepted by mihomo', async (t) => {
  let mihomoBin = '';
  try {
    await run('mihomo', ['-v']);
    mihomoBin = 'mihomo';
  } catch {
    t.skip('mihomo binary is not installed');
    return;
  }

  const { 应用静态出口 } = await loadStaticExit();
  const out = 应用静态出口(baseClash, {
    STATIC_EXIT: 'socks5://USER:PASS@198.51.100.10:1080#🇭🇰 香港静态IP',
    STATIC_EXIT_JSON: JSON.stringify([{ name: '住宅HTTP', type: 'http', server: '198.51.100.7', port: 8080 }])
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-exit-mihomo-'));
  const configPath = path.join(dir, 'config.yaml');
  await writeFile(configPath, out, 'utf8');

  const { stderr, stdout } = await run(mihomoBin, ['-t', '-f', configPath, '-d', dir], { timeout: 120_000 });
  assert.match(`${stdout}${stderr}`, /test is successful/);
});

test('static exit normalizes CRLF upstream output', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const crlf = baseClash.replace(/\n/g, '\r\n');
  const out = 应用静态出口(crlf, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#静态出口' });

  assert.ok(!out.includes('\r'), 'output must not mix line endings');
  assert.match(out, /- name: "🛡️ 静态IP出口"\n\s+type: select/);
});

test('static exit keeps quoted and hashed upstream names intact', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const yaml = `mixed-port: 1
proxies:
  - {name: "US \\"quoted\\" 421", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
  - {name: "JP #9", type: vmess, server: 5.6.7.8, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies:
      - "US \\"quoted\\" 421"
      - "JP #9"
rules:
  - MATCH,🚀 节点选择
`;
  const out = 应用静态出口(yaml, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#静态出口' });
  const entryGroup = out.slice(out.indexOf('- name: "🛬 静态IP入口"'));

  assert.match(entryGroup, /- "US \\"quoted\\" 421"/);
  assert.match(entryGroup, /- "JP #9"/);
});

test('static exit renames its groups when an upstream node already uses that name', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const yaml = baseClash.replace(
    '- {name: "US 421",',
    '- {name: "🛡️ 静态IP出口", type: vmess, server: 9.9.9.9, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}\n  - {name: "US 421",'
  );
  const out = 应用静态出口(yaml, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#静态出口' });

  assert.equal(out.split('\n').filter((line) => line.includes('name: "🛡️ 静态IP出口"')).length, 1, 'the proxy keeps its name, the group must move aside');
  assert.match(out, /- name: "🛡️ 静态IP出口 2"\n\s+type: select/);
  assert.match(out, /dialer-proxy: "🛬 静态IP入口"/);
});

const flowBase = `mixed-port: 1
proxies: [{name: "A", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}]
proxy-groups:
  - name: "G1"
    type: select
    proxies: ["A"]
rules:
  - MATCH,G1
`;

test('static exit decodes YAML escapes the way the parser does', async () => {
  const { 解析YAML节点名, 应用静态出口 } = await loadStaticExit();
  assert.equal(解析YAML节点名("'It''s HK'"), "It's HK");
  assert.equal(解析YAML节点名('"HK\\u00e9\\nX"'), 'HKé\nX');

  const yaml = `mixed-port: 1
proxies:
  - {name: 'It''s HK', type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
proxy-groups:
  - name: "G1"
    type: select
    proxies:
      - 'It''s HK'
rules:
  - MATCH,G1
`;
  const out = 应用静态出口(yaml, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#exit' });
  const entrance = out.slice(out.indexOf('- name: "🛬 静态IP入口"'));
  assert.match(entrance, /- "It's HK"/);
  assert.ok(!entrance.includes('- "It"\n'), 'the escaped name must not be truncated');
});

test('static exit expands flow-style proxies so the injection still lands', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const out = 应用静态出口(flowBase, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#exit' });

  assert.match(out, /^proxies:\n/m);
  assert.match(out, /name: "exit"/);
  assert.match(out, /- name: "🛡️ 静态IP出口"/);
});

test('static exit rewrites a flow-style proxy group instead of appending a bad child', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const yaml = flowBase.replace('  - name: "G1"\n    type: select\n    proxies: ["A"]',
    '  - name: "G1"\n    type: select\n    proxies: ["A"]\n  - {name: "G2", type: select, proxies: ["A"]}');
  const out = 应用静态出口(yaml, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#exit' });

  assert.match(out, /- \{name: "G2", type: select, proxies: \["A", "🛡️ 静态IP出口"\]\}/);
});

test('static exit treats a quoted-colon top-level key as a section boundary', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const yaml = flowBase.replace('rules:', '"my:provider":\n  - name: x\nrules:');
  const out = 应用静态出口(yaml, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#exit' });
  const provider = out.slice(out.indexOf('"my:provider":'), out.indexOf('rules:'));

  assert.ok(!provider.includes('静态IP出口'), 'injection must not land inside the quoted key');
  assert.match(out, /- name: "🛬 静态IP入口"/);
});

test('static exit renames an exit that would shadow an existing group', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const out = 应用静态出口(baseClash, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#🚀 节点选择' });

  assert.match(out, /- \{name: "🚀 节点选择 2", type: "socks5"/);
  assert.match(out, /- "🚀 节点选择 2（链式）"/);
  assert.equal(out.split('\n').filter((line) => line.includes('- name: "🚀 节点选择"')).length, 1);
});

test('static exit builds a proxy-groups section when upstream has none', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const yaml = `mixed-port: 1
proxies:
  - {name: "A", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
rules:
  - MATCH,DIRECT
`;
  const out = 应用静态出口(yaml, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#exit' });

  assert.match(out, /\nproxy-groups:\n/);
  assert.match(out, /- name: "🛡️ 静态IP出口"/);
  assert.match(out, /- name: "🛬 静态IP入口"/);
});

// mihomo rejects a proxy and a group sharing a name with "loop is detected in
// ProxyGroup", so an exit named after one of the two injected groups has to be
// renamed exactly like one that collides with a user group.
for (const collidingName of ['🛡️ 静态IP出口', '🛬 静态IP入口']) {
  test(`static exit renames an exit named after its own group: ${collidingName}`, async () => {
    const { 应用静态出口 } = await loadStaticExit();
    const out = 应用静态出口(baseClash, {
      STATIC_EXIT: `socks5://u:p@198.51.100.10:1080#${collidingName}`
    });

    assert.match(out, new RegExp(`- \\{name: "${collidingName} 2", type: "socks5"`));
    assert.match(out, new RegExp(`- "${collidingName} 2（链式）"`));
    // The group keeps the canonical name; only the node moved aside.
    assert.equal(out.split('\n').filter((line) => line === `  - name: "${collidingName}"`).length, 1);
  });
}

// An inline empty section is still a section header: appending to it would emit
// a second `proxy-groups` key and js-yaml/mihomo reject the duplicate mapping.
test('static exit replaces an inline empty proxy-groups section', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  for (const emptySection of ['proxy-groups: []', 'proxy-groups: {}', 'proxy-groups: []  # later']) {
    const yaml = `mixed-port: 1
proxies:
  - {name: "A", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
${emptySection}
rules:
  - MATCH,DIRECT
`;
    const out = 应用静态出口(yaml, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#exit' });

    assert.equal(
      out.split('\n').filter((line) => /^proxy-groups:/.test(line)).length,
      1,
      `${emptySection} must leave exactly one proxy-groups key`
    );
    assert.match(out, /- name: "🛡️ 静态IP出口"/);
    assert.match(out, /- name: "🛬 静态IP入口"/);
  }
});

test('static exit fills a proxy-groups header that has no entries', async () => {
  const { 应用静态出口 } = await loadStaticExit();
  const yaml = `mixed-port: 1
proxies:
  - {name: "A", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
proxy-groups:
  # filled in by the generator later
rules:
  - MATCH,DIRECT
`;
  const out = 应用静态出口(yaml, { STATIC_EXIT: 'socks5://u:p@198.51.100.10:1080#exit' });

  assert.equal(out.split('\n').filter((line) => /^proxy-groups:/.test(line)).length, 1);
  assert.match(out, /- name: "🛡️ 静态IP出口"/);
});

test('every defect fixture stays loadable by mihomo', async (t) => {
  let mihomoBin = '';
  try {
    await run('mihomo', ['-v']);
    mihomoBin = 'mihomo';
  } catch {
    t.skip('mihomo binary is not installed');
    return;
  }
  const { 应用静态出口 } = await loadStaticExit();
  const fixtures = {
    escapedName: `mixed-port: 1
proxies:
  - {name: 'It''s HK', type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
proxy-groups:
  - name: "G1"
    type: select
    proxies:
      - 'It''s HK'
rules:
  - MATCH,G1
`,
    flowProxies: flowBase,
    flowGroup: flowBase.replace('  - name: "G1"\n    type: select\n    proxies: ["A"]',
      '  - name: "G1"\n    type: select\n    proxies: ["A"]\n  - {name: "G2", type: select, proxies: ["A"]}'),
    quotedKey: flowBase.replace('rules:', '"my:provider":\n  - name: x\nrules:'),
    groupNameExit: baseClash.replace('rules:', 'rules:'),
    emptyGroups: flowBase
      .replace('proxy-groups:\n  - name: "G1"\n    type: select\n    proxies: ["A"]', 'proxy-groups: []')
      .replace('MATCH,G1', 'MATCH,DIRECT'),
    // A top-level key whose value is an inline mapping or a spaced scalar sits
    // between proxies and proxy-groups in almost every real Clash config. The
    // rewriter used to walk straight through it and splice the exit nodes into
    // its middle.
    inlineMappingKey: flowBase.replace('proxy-groups:', 'tun: {enable: false, stack: gvisor}\nproxy-groups:'),
    spacedScalarKey: flowBase.replace('proxy-groups:', 'external-ui-name: My Dashboard\nproxy-groups:'),
    // A `]` inside a node name or inside a trailing comment is not the end of
    // the flow list; the bracket scan has to honour quotes and comments.
    bracketInFlowName: `mixed-port: 1
proxies: [{name: "HK [01] 1x", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}]
proxy-groups:
  - name: "G1"
    type: select
    proxies: ["HK [01] 1x"]
rules:
  - MATCH,G1
`,
    trailingCommentBracket: `mixed-port: 1
proxies: [{name: "A", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}] # [pool]
proxy-groups:
  - name: "G1"
    type: select
    proxies:
      - A
rules:
  - MATCH,G1
`,
    // A comment after the `proxies:` key of a group used to hide the member
    // list, so the exit group was injected but never reachable from that group.
    groupListComment: flowBase.replace('    proxies: ["A"]', '    proxies:  # members\n      - A'),
    // A UTF-8 BOM makes the first line unrecognisable unless it is stripped.
    withBom: `﻿${flowBase}`,
    // PyYAML's default output style: sequence items sit in the key's column.
    indentless: `mixed-port: 1
proxies:
- {name: "A", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
proxy-groups:
- name: "G1"
  type: select
  proxies:
  - A
rules:
- MATCH,G1
`,
    noGroups: `mixed-port: 1
proxies:
  - {name: "A", type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-4333-8444-555555555555, alterId: 0, cipher: auto}
rules:
  - MATCH,DIRECT
`
  };
  const configs = {
    groupNameExit: 'socks5://u:p@198.51.100.10:1080#🚀 节点选择',
    emptyGroups: 'socks5://u:p@198.51.100.10:1080#exit'
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-exit-fixtures-'));
  for (const [name, yaml] of Object.entries(fixtures)) {
    const out = 应用静态出口(yaml, { STATIC_EXIT: configs[name] ?? 'socks5://u:p@198.51.100.10:1080#exit' });
    const configPath = path.join(dir, `${name}.yaml`);
    await writeFile(configPath, out, 'utf8');
    const { stdout, stderr } = await run(mihomoBin, ['-t', '-f', configPath, '-d', dir], { timeout: 120_000 });
    assert.match(`${stdout}${stderr}`, /test is successful/, `${name} must load in mihomo`);
  }
});
