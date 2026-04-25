# Electron 运行页、结果页、订阅页与设置页刷新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复运行页闪烁与点击丢失，移除重复按钮和重复介绍，补齐统一最大迭代次数配置，并把结果页与订阅页改成真实可用的主视图。

**Architecture:** 保持现有 Electron + 原生 HTML/CSS/JS 架构不变。后端 preview 能力抽出为独立 Node helper 负责 vmess 解析与区域统计；renderer 继续由 `app.js` 驱动，但把高频日志/阶段更新从全量 `renderAll()` 中拆出来，避免运行期按钮 DOM 被重建。页面结构重心放在 `views.js` 和 `styles.css`，设置页统一最大迭代次数通过 drawer draft 批量回写到各 `sources.*.max_iterations`。

**Tech Stack:** Electron、Node.js test runner、Playwright、Python pytest、vanilla HTML/CSS/JS

---

## File Map

- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/lib/artifact-preview.js`
  - 负责读取 artifact 目录、解析最终节点文件、解码 `vmess://`、统计区域卡片。
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js`
  - 改为复用 `artifact-preview.js`，避免 preview 逻辑继续堆在 IPC handler 内。
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
  - 拆分低频全量渲染与高频局部渲染；补充结果页/设置页状态；修复日志事件导致的 DOM 重建。
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
  - 删除二级页面头部；重写运行页、结果页、订阅页、设置抽屉；新增结果区域卡片和 tab rail。
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
  - 调整运行页、结果页、订阅页、设置页布局；给订阅页保留明显留白；删除重复页面头部样式。
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
  - 更新页面副标题与按钮文案，去掉“最近日志”类旧描述。
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
  - 为 preview 解析与区域统计写测试。
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
  - 为结果页统计、设置页统一最大迭代次数摘要等纯函数/文案逻辑写测试。
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
  - 覆盖重复按钮移除、结果页真实字段、订阅页 tab rail、设置页统一最大迭代次数、运行页 DOM 稳定性。
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`
  - 更新六页 visual hash。

---

### Task 1: 为 artifact preview 真实节点解析写失败测试并实现 helper

**Files:**
- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/lib/artifact-preview.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`

- [ ] **Step 1: 先写失败测试，定义 preview 输出结构**

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs` 增加测试，明确 preview 必须返回解码后的节点和区域统计：

```js
import { buildArtifactPreview } from '../lib/artifact-preview.js';

test('buildArtifactPreview decodes final vmess nodes and groups regions', () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-artifact-preview-'));
  const us = 'vmess://eyJhZGQiOiIxLjEuMS4xIiwicHMiOiLwn4e68J+HsyBVUyBOb2RlIiwibmV0Ijoid3MiLCJwYXRoIjoiL3VzIiwicG9ydCI6NDQzfQ==';
  const jp = 'vmess://eyJhZGQiOiIyLjIuMi4yIiwicHMiOiLwn4ev8J+HtSBKUCBOb2RlIiwibmV0Ijoid3MiLCJwYXRoIjoiL2pwIiwicG9ydCI6NDQzfQ==';

  fs.writeFileSync(path.join(artifactDir, 'vpn_node_emoji.txt'), `${us}\n${jp}\n`, 'utf-8');

  const preview = buildArtifactPreview(artifactDir);

  assert.equal(preview.finalNodeCount, 2);
  assert.deepEqual(preview.nodeRows[0], {
    name: '🇺🇸 US Node',
    address: '1.1.1.1',
    protocol: 'vmess',
    path: '/us',
    link: us,
    regionCode: 'US'
  });
  assert.deepEqual(preview.regionCards, [
    { regionCode: 'JP', count: 1 },
    { regionCode: 'US', count: 1 }
  ]);
});
```

- [ ] **Step 2: 运行 backend test，确认 helper 尚不存在时先失败**

Run: `rtk node --test electron/tests/backend.test.mjs`

Expected: FAIL，报错 `Cannot find module '../lib/artifact-preview.js'` 或 preview 结构不匹配。

- [ ] **Step 3: 实现 `artifact-preview.js`，最小完成 vmess 解析与区域统计**

创建 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/lib/artifact-preview.js`：

```js
import fs from 'node:fs';
import path from 'node:path';

const NODE_FILES = ['vpn_node_emoji.txt', 'vpn_node_availability.txt', 'vpn_node_speedtest.txt'];

export function buildArtifactPreview(artifactDir) {
  const resolved = path.resolve(String(artifactDir ?? ''));
  if (!resolved || !fs.existsSync(resolved)) {
    return { ok: false, outputFiles: [], nodeRows: [], regionCards: [], finalNodeCount: 0 };
  }

  const outputFiles = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(resolved, entry.name);
      return { name: entry.name, size: formatBytes(fs.statSync(filePath).size) };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

  const nodeFile = NODE_FILES
    .map((name) => path.join(resolved, name))
    .find((filePath) => fs.existsSync(filePath));

  const nodeRows = nodeFile
    ? fs.readFileSync(nodeFile, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((link) => parseNode(link))
      .filter(Boolean)
    : [];

  return {
    ok: true,
    outputFiles,
    nodeRows,
    regionCards: summarizeRegions(nodeRows),
    finalNodeCount: nodeRows.length
  };
}

function parseNode(link) {
  if (!link.startsWith('vmess://')) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(padBase64(link.slice('vmess://'.length)), 'base64url').toString('utf-8'));
    return {
      name: String(payload.ps ?? ''),
      address: String(payload.add ?? ''),
      protocol: 'vmess',
      path: String(payload.path ?? ''),
      link,
      regionCode: extractRegionCode(String(payload.ps ?? ''))
    };
  } catch {
    return null;
  }
}

function summarizeRegions(nodeRows) {
  const counts = new Map();
  for (const row of nodeRows) {
    const regionCode = row.regionCode || 'OTHER';
    counts.set(regionCode, (counts.get(regionCode) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => left[0].localeCompare(right[0], 'en'))
    .map(([regionCode, count]) => ({ regionCode, count }));
}
```

- [ ] **Step 4: 让 IPC handler 复用新 helper**

把 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js` 中 `artifact:preview` handler 改成直接调用 helper：

```js
import { buildArtifactPreview } from './lib/artifact-preview.js';

ipcMain.handle('artifact:preview', async (_event, artifactDir) => {
  return buildArtifactPreview(artifactDir);
});
```

- [ ] **Step 5: 重跑 backend tests，确认 preview helper 通过**

Run: `rtk node --test electron/tests/backend.test.mjs`

Expected: PASS，且 `buildArtifactPreview decodes final vmess nodes and groups regions` 通过。

- [ ] **Step 6: Commit**

```bash
rtk git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation add \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/lib/artifact-preview.js \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs
rtk git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation commit -m "test: cover artifact preview parsing"
```

### Task 2: 先写失败 e2e，约束页面结构变化与统一最大迭代次数

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`

- [ ] **Step 1: 为运行页、结果页、订阅页、设置页补充失败 e2e**

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs` 增加断言：

```js
await page.locator('#navRuns').click();
await page.waitForSelector('#runsWorkspace');
assert.equal(await page.locator('.topbar-actions [data-run-action]').count(), 0);
assert.equal(await page.locator('#runsLogOutput').count(), 0);

await page.locator('#navResults').click();
await page.waitForSelector('#resultsWorkspace');
assert.equal(await page.locator('.topbar-actions button').count(), 0);
const resultsText = await page.locator('#resultsWorkspace').innerText();
assert.match(resultsText, /IP 地址/);
assert.match(resultsText, /path/);
assert.match(resultsText, /区域统计|节点分布/);

await page.locator('#navSubscriptions').click();
await page.waitForSelector('#subscriptionCards');
assert.equal(await page.locator('.topbar-actions [data-open-url]').count(), 0);
assert.equal(await page.locator('.subscription-tab-rail').count(), 1);

await page.locator('#navSettings').click();
await page.locator('[data-settings-card="sources"]').click();
await page.waitForSelector('#settingsDrawer[data-open="true"]');
assert.equal(await page.getByLabel('最大迭代次数').count(), 1);
```

- [ ] **Step 2: 为统一最大迭代次数摘要写失败单测**

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs` 增加一个纯函数测试，约束数据源卡片摘要必须展示统一迭代次数：

```js
import { summarizeSourceSettings } from '../renderer/views.js';

test('summarizeSourceSettings reports enabled count and shared max iterations', () => {
  const summary = summarizeSourceSettings({
    leiting: { enabled: true, max_iterations: 40 },
    heidong: { enabled: true, max_iterations: 40 },
    mifeng: { enabled: false, max_iterations: 40 }
  });

  assert.equal(summary.enabledCount, 2);
  assert.equal(summary.sharedMaxIterations, 40);
});
```

- [ ] **Step 3: 运行测试，确认这些页面结构断言先失败**

Run: `rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs`

Expected: FAIL，原因包括 `#runsLogOutput` 仍存在、结果页列名仍是“延迟/下载”、订阅页没有 `.subscription-tab-rail`、设置页不存在“最大迭代次数”。

- [ ] **Step 4: 同步更新页面副标题文案，确保测试目标明确**

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js` 先把页面文案改成目标状态：

```js
pageSubtitles: {
  dashboard: '只展示运行状态、系统状态摘要、核心指标和最近结果',
  runs: '执行流水线、查看阶段进度与当前阶段详情',
  results: '查看最终节点、区域统计与 artifact 摘要',
  subscriptions: '切换不同订阅格式并查看二维码与分发信息',
  logs: '查看实时日志流、错误高亮和日志操作',
  settings: '统一管理数据源、测速与运行配置'
}
```

- [ ] **Step 5: 再跑一次 e2e，确认失败点已经集中到视图实现本身**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: 仍然 FAIL，但失败位置集中在页面 DOM 和布局未更新，而不是旧副标题文案。

### Task 3: 重写 `views.js` 与状态摘要，完成运行页/结果页/订阅页/设置页结构调整

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: 删除重复页面头部，先改 `buildPageMarkup()`**

把 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js` 中的 `page-header-card` 整段去掉，让 `buildPageMarkup()` 只输出页面内容：

```js
export function buildPageMarkup(activePage, viewModel, messages, language, subtabs = {}) {
  return `
    <section class="page-shell" data-page-shell="${activePage}">
      ${buildPageInner(activePage, viewModel, messages, language, subtabs)}
    </section>
  `;
}
```

同时把 `buildTopbarActions()` 调整为只保留真正需要的顶栏操作：

```js
const actionSets = {
  dashboard: [
    `<button class="btn btn-secondary" data-action="open-settings" type="button">${escapeHtml(messages.settingsButton)}</button>`,
    `<button class="btn btn-danger" data-run-action="stop" type="button" ${labels.stopDisabled ? 'disabled' : ''}>${escapeHtml(labels.stopLabel)}</button>`,
    `<button class="btn btn-primary" data-run-action="start" type="button" ${labels.runDisabled ? 'disabled' : ''}>${escapeHtml(labels.runLabel)}</button>`
  ],
  runs: [],
  results: [],
  subscriptions: [],
  logs: [],
  settings: [
    `<button class="btn btn-primary" data-action="save-profile" type="button">${escapeHtml(labels.saveLabel)}</button>`
  ]
};
```

- [ ] **Step 2: 重写结果页，改成最终节点 + 区域统计主视图**

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js` 中将 `buildResultsPage()` 改成：

```js
function buildResultsPage(vm) {
  return `
    <div id="resultsWorkspace" class="page-grid results-grid">
      <article class="panel wide-panel artifact-card">
        <div class="result-summary">
          <div class="key-value-row"><span>Artifact 目录</span><strong class="mono">${escapeHtml(vm.artifactDir || '暂无')}</strong></div>
          <div class="key-value-row"><span>最终节点数量</span><strong>${escapeHtml(String(vm.finalNodeCount))}</strong></div>
          <div class="key-value-row"><span>最近更新时间</span><strong>${escapeHtml(vm.lastUpdated)}</strong></div>
        </div>
        <div class="page-actions result-actions">
          <button class="btn btn-secondary" data-action="open-artifact-dir" type="button">打开 artifact</button>
          <button class="btn btn-primary" data-action="copy-nodes" type="button">复制节点</button>
        </div>
      </article>

      <article class="panel wide-panel">
        <div class="panel-headline"><h3>区域统计</h3><span class="panel-subcopy">按最终节点区域汇总</span></div>
        <div class="country-grid">
          ${vm.regionCards.length
            ? vm.regionCards.map((card) => `<div class="country-card"><strong>${escapeHtml(card.regionCode)}</strong><span>${escapeHtml(String(card.count))} 个</span></div>`).join('')
            : '<div class="empty-state">暂无可统计节点。</div>'}
        </div>
      </article>

      <article class="panel wide-panel">
        <div class="panel-headline"><h3>最终节点列表</h3><span class="panel-subcopy">展示 pipeline 最终保留的节点</span></div>
        <div class="table-wrap">
          <table class="data-table compact-result-table">
            <thead><tr><th>#</th><th>节点名称</th><th>IP 地址</th><th>协议</th><th>path</th></tr></thead>
            <tbody>
              ${vm.nodeRows.length
                ? vm.nodeRows.map((row, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.address)}</td><td>${escapeHtml(row.protocol)}</td><td class="mono">${escapeHtml(row.path || '—')}</td></tr>`).join('')
                : '<tr><td colspan="5">暂无节点，运行完成后显示。</td></tr>'}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  `;
}
```

同时新增并导出一个纯函数 `summarizeSourceSettings(sources)`，返回：

```js
{
  enabledCount: 2,
  sharedMaxIterations: 40
}
```

它会被 `buildViewModel()` 用来生成“数据源配置”卡片摘要，确保卡片能显示启用源数量和统一最大迭代次数。

- [ ] **Step 3: 重写订阅页与设置抽屉内容，让布局更舒展**

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js` 中更新 `buildSubscriptionsPage()` 和 `buildSettingsDrawerBody('sources')`：

```js
function buildSubscriptionsPage(vm) {
  const current = vm.currentSubscription;
  return `
    <div id="subscriptionCards" class="page-grid subscriptions-grid">
      <article class="panel wide-panel subscription-tabs-panel">
        <div class="subscription-tab-rail">
          ${SUBSCRIPTION_FORMATS.map((format) => `
            <button
              class="subscription-tab ${vm.subscriptionFormat === format ? 'active' : ''}"
              data-subscription-format="${escapeHtml(format)}"
              type="button"
            >${escapeHtml(format)}</button>
          `).join('')}
        </div>
      </article>

      <article class="panel subscription-main-panel">
        <div class="panel-headline"><h3>主订阅地址</h3><span class="panel-subcopy">切换 tab 后同步更新链接与二维码</span></div>
        <div class="subscription-primary mono">${escapeHtml(current.url)}</div>
        <div class="action-grid subscription-actions">
          <button class="btn btn-primary" data-copy-text="${escapeHtml(current.url)}" type="button">复制链接</button>
          <button class="btn btn-secondary" data-open-url="${escapeHtml(current.url)}" type="button">打开订阅</button>
        </div>
      </article>

      <article class="panel subscription-qr-panel">
        <div class="panel-headline"><h3>订阅二维码</h3></div>
        <div class="qr-block">${renderQr(vm.qrDataUrl)}</div>
      </article>

      <article class="panel wide-panel subscription-meta">
        <div class="mini-stat"><span>最后生成时间</span><strong>${escapeHtml(vm.lastUpdated)}</strong></div>
        <div class="mini-stat"><span>最终节点数量</span><strong>${escapeHtml(String(vm.finalNodeCount))} 个</strong></div>
      </article>
    </div>
  `;
}

function buildSettingsDrawerBody(section, draft) {
  if (section === 'sources') {
    return `
      <div class="form-grid compact-form-grid">
        ${renderDrawerField('最大迭代次数', 'number', draft.sharedMaxIterations, 'sharedMaxIterations', true)}
      </div>
      <div class="table-wrap">
        <table class="data-table settings-source-table">
          <thead><tr><th>启用</th><th>名称</th><th>地址</th><th>密钥</th></tr></thead>
          <tbody>
            ${Object.entries(draft.sources).map(([name, source]) => `
              <tr>
                <td><input type="checkbox" data-drawer-source="${escapeHtml(name)}" data-drawer-key="enabled" ${source.enabled ? 'checked' : ''} /></td>
                <td><strong>${escapeHtml(SOURCE_NAMES[name] || name)}</strong></td>
                <td><input data-drawer-source="${escapeHtml(name)}" data-drawer-key="url" value="${escapeHtml(source.url ?? '')}" /></td>
                <td><input data-drawer-source="${escapeHtml(name)}" data-drawer-key="key" value="${escapeHtml(source.key ?? '')}" /></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
}
```

- [ ] **Step 4: 补充 view model 与 settings draft 的最小状态改动**

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js` 中更新状态和 draft 结构：

```js
const state = {
  profile: null,
  unsubscribe: null,
  stageStatus: {},
  counts: {},
  language: 'zh-CN',
  activePage: 'dashboard',
  subtabs: {},
  subscriptionFormat: 'Clash',
  logFilter: '全部',
  settingsDrawer: null,
  isDemo: false,
  runState: 'idle',
  runResult: 'idle',
  logEntries: [],
  artifactDir: '',
  outputFiles: [],
  nodeRows: [],
  regionCards: [],
  finalNodeCount: 0,
  qrDataUrl: '',
  runStartedAt: null,
  lastUpdateAt: null,
  modalTransform: ''
};

function buildSettingsDraft(section) {
  if (!state.profile) {
    return null;
  }
  if (section === 'sources') {
    const sources = structuredClone(state.profile.sources);
    return {
      sources,
      sharedMaxIterations: resolveSharedMaxIterations(sources)
    };
  }
  if (section === 'speed_test') return structuredClone(state.profile.speed_test);
  if (section === 'deploy') return structuredClone(state.profile.deploy);
  if (section === 'paths') return structuredClone(state.profile.paths);
  if (section === 'about') return { version: getMessages(state.language).sidebarVersion };
  return null;
}

function saveSettingsDrawer() {
  if (!state.settingsDrawer || !state.profile) {
    return;
  }
  const { section, draft } = state.settingsDrawer;
  if (section === 'sources') {
    const nextSources = structuredClone(draft.sources);
    for (const source of Object.values(nextSources)) {
      source.max_iterations = Number(draft.sharedMaxIterations);
    }
    state.profile.sources = nextSources;
  } else if (section !== 'about') {
    state.profile[section] = structuredClone(draft);
  }
  if (section === 'deploy') {
    refreshQrCode();
  }
  state.settingsDrawer = null;
  touchUpdate();
  renderAll();
}

function resolveSharedMaxIterations(sources) {
  const values = Object.values(sources ?? {}).map((source) => Number(source.max_iterations ?? 0));
  return values[0] ?? 0;
}
```

- [ ] **Step 5: 让 `hydrateArtifactPreview()` 吃到新 preview 字段**

继续在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js` 中更新：

```js
async function hydrateArtifactPreview() {
  if (!state.artifactDir || !window.vpnAutomation?.previewArtifact) {
    state.outputFiles = [];
    state.nodeRows = [];
    state.regionCards = [];
    state.finalNodeCount = 0;
    return;
  }

  const result = await window.vpnAutomation.previewArtifact(state.artifactDir);
  if (result?.ok) {
    state.outputFiles = result.outputFiles ?? [];
    state.nodeRows = result.nodeRows ?? [];
    state.regionCards = result.regionCards ?? [];
    state.finalNodeCount = result.finalNodeCount ?? state.nodeRows.length;
    renderPageContent();
  }
}
```

- [ ] **Step 6: 跑 UI state 与 e2e，确认页面结构变更通过**

Run: `rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs`

Expected: PASS，运行页不再有顶栏运行按钮和最近日志，结果页显示新表格列，订阅页出现 `.subscription-tab-rail`，设置抽屉出现“最大迭代次数”。

- [ ] **Step 7: Commit**

```bash
rtk git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation add \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs
rtk git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation commit -m "feat: refresh runs results subscriptions views"
```

### Task 4: 用失败回归测试锁住“日志事件不再重建运行按钮”

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: 先写失败回归测试，直接复现原始问题**

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs` 增加一段专门的运行页稳定性测试：

```js
await page.locator('#navRuns').click();
await page.waitForSelector('#runsWorkspace');

await page.locator('#runsWorkspace [data-run-action="start"]').evaluate((el) => {
  window.__targetButton = el;
  let replacements = 0;
  const observer = new MutationObserver(() => {
    const next = document.querySelector('#runsWorkspace [data-run-action="start"]');
    if (next && next !== window.__targetButton) {
      replacements += 1;
      window.__targetButton = next;
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.__getReplacementCount = () => replacements;
});

for (let index = 0; index < 8; index += 1) {
  await page.evaluate((i) => window.__emitPipelineEvent({ type: 'log', message: `[INFO] tick ${i}` }), index);
}

assert.equal(await page.evaluate(() => window.__getReplacementCount()), 0);
```

- [ ] **Step 2: 跑 e2e，确认旧逻辑下回归测试先失败**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: FAIL，旧实现下 replacement count 会大于 0。

- [ ] **Step 3: 在 `app.js` 拆出低频与高频渲染函数**

把 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js` 改成：

```js
function renderChromeOnly() {
  const messages = getMessages(state.language);
  const viewModel = buildViewModel(state, messages, state.language);
  renderChrome(messages, viewModel);
}

function renderPageContent() {
  const messages = getMessages(state.language);
  const viewModel = buildViewModel(state, messages, state.language);
  elements.pageContent.innerHTML = buildPageMarkup(
    state.activePage,
    viewModel,
    messages,
    state.language,
    state.subtabs
  );
}

function renderAll() {
  const messages = getMessages(state.language);
  const viewModel = buildViewModel(state, messages, state.language);
  document.documentElement.lang = state.language;
  document.title = messages.appTitle;
  document.body.dataset.page = state.activePage;
  renderChrome(messages, viewModel);
  elements.pageContent.innerHTML = buildPageMarkup(
    state.activePage,
    viewModel,
    messages,
    state.language,
    state.subtabs
  );
}
```

- [ ] **Step 4: 让高频路径停止调用 `renderAll()`**

继续在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js` 中最小调整事件路径：

```js
function appendLog(message, overrides = {}) {
  state.logEntries.push(classifyLogEntry(message, overrides));
  touchUpdate();
  if (state.activePage === 'logs') {
    renderPageContent();
  }
}

function handlePipelineEvent(event) {
  if (event.type === 'log') {
    appendLog(event.message);
    return;
  }

  if (event.type === 'stage') {
    state.stageStatus[event.stage] = event.status;
    appendLog(`[stage] ${event.stage} ${event.status}`, {
      kind: 'stage',
      stage: event.stage,
      level: event.status === 'failed' ? 'error' : event.status === 'running' ? 'warning' : 'info'
    });
    touchUpdate();
    if (state.activePage === 'runs') {
      renderPageContent();
    }
    return;
  }

  if (event.type === 'summary') {
    state.stageStatus = event.stage_status ?? {};
    state.counts = normalizeCounts(event.counts ?? {});
    state.artifactDir = event.artifact_dir ?? '';
    touchUpdate();
    renderChromeOnly();
    renderPageContent();
    appendLog(`[summary] artifacts: ${event.artifact_dir}`);
    hydrateArtifactPreview();
    return;
  }
}
```

- [ ] **Step 5: 重跑 e2e，确认日志事件不会再替换运行按钮**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: PASS，replacement count 为 `0`，且运行页点击不会因日志事件丢失。

- [ ] **Step 6: Commit**

```bash
rtk git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation add \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs
rtk git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation commit -m "fix: avoid rerendering run controls on log events"
```

### Task 5: 完成订阅页留白样式、结果页样式和全量验证

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_store.py`

- [ ] **Step 1: 先写订阅页与结果页的最终样式**

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css` 中加入更宽松的订阅页和结果页布局，明确保留留白：

```css
.subscriptions-grid {
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
  gap: 20px;
}

.subscription-tabs-panel,
.subscription-main-panel,
.subscription-qr-panel,
.subscription-meta {
  padding: 24px;
}

.subscription-tab-rail {
  display: flex;
  gap: 12px;
  padding: 8px;
  border-radius: 22px;
  background: var(--surface-soft);
  overflow-x: auto;
}

.subscription-tab {
  min-height: 44px;
  padding: 0 18px;
  border-radius: 16px;
  white-space: nowrap;
}

.subscription-tab.active {
  background: linear-gradient(135deg, var(--accent), #7274f0);
  color: #fff;
}

.subscription-main-panel {
  display: grid;
  gap: 18px;
}

.country-grid {
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 14px;
}
```

- [ ] **Step 2: 跑 visual test，记录新的页面 hash**

Run: `rtk node --test electron/tests/renderer-visual.test.mjs`

Expected: FAIL，并打印六页最新 screenshot hash。

- [ ] **Step 3: 更新 `EXPECTED_DIGESTS`**

把 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs` 中 `EXPECTED_DIGESTS` 的 6 个键按原顺序更新为失败输出里打印出的 **精确哈希值**：

- `dashboard`
- `runs`
- `results`
- `subscriptions`
- `logs`
- `settings`

不要改键名顺序，也不要手填估计值；直接粘贴 visual test 输出的实际 hash。

- [ ] **Step 4: 跑 Electron 全量测试**

Run: `rtk npm run test:electron`

Expected: PASS，backend/ui-state/e2e/visual/app-launch 全部通过。

- [ ] **Step 5: 跑项目全量测试**

Run: `rtk npm run test:all`

Expected: PASS，Python tests 与 Electron tests 均通过。

- [ ] **Step 6: 打包 Electron 并做真实界面验证**

Run: `rtk npm run package:electron`

Expected: PASS，产出 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/dist-electron/mac-arm64/VPN Subscription Automation.app`

然后验证：

- 运行页运行中按钮不再闪烁
- 结果页展示最终节点与区域统计
- 设置页能统一修改最大迭代次数
- 订阅页组件不紧凑，tab、地址、二维码、统计区之间有明显留白

- [ ] **Step 7: Commit**

```bash
rtk git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation add \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css \
  /Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs
rtk git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation commit -m "style: relax subscription layout and refresh visual baselines"
```
