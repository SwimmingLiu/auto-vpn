# Electron 中文唯一界面收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all English fallback behavior from the Electron renderer so the desktop client is implemented and rendered as a Chinese-only UI.

**Architecture:** Keep the change narrow and renderer-only. Collapse the i18n/bootstrap layer to a single `zh-CN` source of truth, replace derived English labels in `state.js` and `views.js` with Chinese constants, then refresh Playwright assertions and screenshot hashes against the new Chinese-only output.

**Tech Stack:** Electron, native HTML/CSS/ES modules, Playwright, Node test runner, Computer Use, GitHub workflow

---

## File Structure

- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
  - Owns the renderer copy dictionary and language helpers. After this change it should expose only Chinese semantics.
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
  - Owns renderer bootstrap and shared UI state. After this change it should initialize the UI as fixed `zh-CN` without reading browser/system language.
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/state.js`
  - Owns stage/order helpers and summary-card label derivation. After this change metric labels should be Chinese.
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
  - Owns page markup and deterministic demo/derived UI content. After this change it should not contain `pick(language, zh, en)` or English fallback strings.
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
  - Locks in Chinese-only helper behavior.
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
  - Locks in Chinese-only rendered output and absence of English UI strings.
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`
  - Owns screenshot digest regression checks and must be updated to the new Chinese-only screenshots.
- Regression-only: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/app-launch.test.mjs`
  - Confirms the real Electron app still loads the saved profile after the renderer cleanup.

### Task 1: Lock the Chinese-only contract in tests first

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Write the failing state/i18n assertions**

```js
test('resolveLanguage ignores saved and system language and always returns zh-CN', () => {
  assert.equal(resolveLanguage(), 'zh-CN');
  assert.equal(resolveLanguage('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLanguage('en-US', 'en-US'), 'zh-CN');
  assert.equal(resolveLanguage('', 'zh-TW'), 'zh-CN');
});

test('getMessages and summary cards expose Chinese-only copy', () => {
  assert.equal(getMessages().runButton, '立即运行');
  assert.equal(getMessages('en-US').pageTitles.deploy, '部署设置');
  assert.equal(getMessages('en-US').pageSubtitles.dashboard, '统一查看节点抓取、测速、部署与实时日志的桌面工作台');

  const cards = toMetricItems({
    raw_links: 12,
    postprocess_links: 5,
    speedtest_links: 3,
    availability_links: 2
  });

  assert.deepEqual(cards[0], { label: '原始节点数', value: '12' });
  assert.deepEqual(cards[1], { label: '后处理节点数', value: '5' });
});
```

- [ ] **Step 2: Run the targeted state test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && node --test electron/tests/ui-state.test.mjs`

Expected: FAIL because `toMetricItems()` still emits uppercase English labels and `resolveLanguage()` still accepts unused parameters.

- [ ] **Step 3: Write the failing renderer assertions that ban English copy**

```js
assert.equal(await page.locator('text=English').count(), 0);
assert.equal(await page.locator('text=Local first').count(), 0);
assert.equal(await page.locator('text=Platform').count(), 0);
assert.equal(await page.locator('text=General').count(), 0);
assert.equal(await page.locator('text=Pipeline overview').count(), 0);
```

- [ ] **Step 4: Run the targeted renderer test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && node --test electron/tests/renderer-e2e.test.mjs`

Expected: FAIL because `views.js` still renders English fallback strings such as `Local first`, `Platform`, `General`, and `Pipeline overview`.

### Task 2: Collapse the renderer bootstrap and helper layer to fixed Chinese behavior

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/state.js`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`

- [ ] **Step 1: Simplify the language module to a single Chinese source**

```js
export function resolveLanguage() {
  return 'zh-CN';
}

export function getMessages() {
  return ZH_MESSAGES;
}
```

- [ ] **Step 2: Fix renderer bootstrap to stop reading saved/system language**

```js
async function bootstrap() {
  state.language = 'zh-CN';
  renderAll();
  bindActions();
}
```

- [ ] **Step 3: Replace English metric-label derivation with Chinese labels**

```js
const METRIC_LABELS = {
  raw_links: '原始节点数',
  postprocess_links: '后处理节点数',
  speedtest_links: '测速通过节点',
  availability_links: '可用节点数'
};

export function toMetricItems(counts = {}) {
  return Object.entries(counts).map(([label, value]) => ({
    label: METRIC_LABELS[label] ?? label,
    value: String(value)
  }));
}
```

- [ ] **Step 4: Re-run the targeted state/i18n tests**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && node --test electron/tests/ui-state.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit the helper-layer cleanup**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add electron/renderer/i18n.js electron/renderer/app.js electron/renderer/state.js electron/tests/ui-state.test.mjs
git commit -m "refactor: collapse renderer language helpers to zh-cn"
```

### Task 3: Remove every English fallback branch from page rendering

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Convert page/tab definitions to Chinese-only arrays and values**

```js
const CONFIG_TABS = [
  ['sources', '抓包 API 配置'],
  ['speed', '测速配置'],
  ['rules', '节点处理规则'],
  ['package', '加密策略'],
  ['paths', '本地路径设置'],
  ['pages', 'Cloudflare Pages 配置']
];

const LOG_TABS = [
  ['runtime', '运行日志'],
  ['deploy', '部署日志'],
  ['system', '系统日志'],
  ['error', '错误日志']
];

const SETTINGS_TABS = [
  ['general', '通用设置'],
  ['appearance', '界面设置'],
  ['mail', '邮件配置'],
  ['logs', '日志设置'],
  ['notifications', '通知设置'],
  ['about', '关于设置']
];
```

- [ ] **Step 2: Delete the `pick(language, zh, en)` pattern from derived page content**

```js
filterOptions: {
  region: ['全部', '美国', '新加坡', '日本', '中国香港', '德国'],
  protocol: ['全部', 'VLESS', 'VMESS', 'Trojan'],
  availability: ['全部', '在线', '降级'],
  mode: ['全部', '本地优先', 'GitHub Actions 备用']
}
```

```js
<h3>${escapeHtml('流程总览')}</h3>
<button class="btn btn-secondary small" type="button" data-page-target="logs">${escapeHtml('查看更多')}</button>
<label class="radio-row"><input type="radio" checked />${escapeHtml('本地优先（推荐）')}</label>
${renderBoundField('选择平台', 'text', 'Cloudflare Pages', 'deploy-platform')}
<div class="metric-card accent"><span>${escapeHtml('一般告警')}</span><strong>5</strong></div>
```

- [ ] **Step 3: Remove the helper entirely once no callers remain**

```js
function formatDate(value) {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}
```

Delete this dead helper:

```js
function pick(language, zh, en) {
  return language === 'zh-CN' ? zh : en;
}
```

- [ ] **Step 4: Re-run the renderer e2e test**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && node --test electron/tests/renderer-e2e.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit the page-copy cleanup**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add electron/renderer/views.js electron/tests/renderer-e2e.test.mjs
git commit -m "refactor: remove english fallback copy from renderer views"
```

### Task 4: Refresh visual regression and run full renderer verification

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/app-launch.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/window-config.test.mjs`

- [ ] **Step 1: Print the new screenshot digest map from the final Chinese-only UI**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && node --test electron/tests/renderer-visual.test.mjs`

Expected: FAIL because the current `EXPECTED_DIGESTS` object still contains the old hashes.

- [ ] **Step 2: Capture the new digests and replace the constant with the printed values**

Use this temporary snippet inside `electron/tests/renderer-visual.test.mjs` before the assertion:

```js
console.log(JSON.stringify(digests, null, 2));
assert.deepEqual(digests, EXPECTED_DIGESTS);
```

After the test prints the digest object, replace the entire `EXPECTED_DIGESTS` constant with that JSON verbatim and then remove the temporary digest-print statement.

- [ ] **Step 3: Run the full Electron test suite**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && npm run test:electron`

Expected: PASS with all Electron tests green, including `ui-state`, `renderer-e2e`, `renderer-visual`, `app-launch`, `backend`, and `window-config`.

- [ ] **Step 4: Run explicit development-mode UI verification**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && npm run electron:dev`

Expected: the development window opens under `com.github.Electron`.

Then verify with Computer Use:

- Dashboard has no `English`, `Local first`, `Pipeline overview`, `Platform`, or `General`
- Config page still shows 5 source URL inputs
- Settings and About pages render in Chinese
- Run / Stop buttons remain visible

- [ ] **Step 5: Commit the regression updates**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add electron/tests/renderer-visual.test.mjs
git commit -m "test: refresh chinese-only electron visual baselines"
```

### Task 5: Complete the repo workflow, review loop, and packaging deliverable

**Files:**
- Modify: all files touched in Tasks 1-4

- [ ] **Step 1: Create a working branch and squash-fix any leftover unstaged plan drift**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git checkout -b feat/electron-zh-cn-only-ui
git status --short
```

Expected: only the renderer/test files from Tasks 1-4 are staged or committed for this feature.

- [ ] **Step 2: Push the branch and open a draft PR**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git push -u origin feat/electron-zh-cn-only-ui
```

Expected: branch is available on origin.

Then open a draft PR with the GitHub workflow/plugin and title it:

```text
refactor: make electron renderer chinese-only
```

- [ ] **Step 3: Request `@Copilot` review and resolve feedback**

After the draft PR is open:

- Request `@Copilot` review
- Apply requested changes
- If any file changes after review, re-run:
  - `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && npm run test:electron`
  - `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && npm run electron:dev`
- Re-run the Computer Use UI check on the updated build

- [ ] **Step 4: Merge only after tests and review are green**

Use the GitHub workflow/plugin to merge the PR once:

- `npm run test:electron` is green
- the Chinese-only UI verification is complete
- `@Copilot` review feedback is resolved

- [ ] **Step 5: Package the final desktop app**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && npm run package:electron`

Expected: PASS and generate:

```text
/Users/swimmingliu/data/VPN/vpn-subscription-automation/dist-electron/mac-arm64/VPN Subscription Automation.app
```

- [ ] **Step 6: Record the final delivery summary**

```text
- Branch: feat/electron-zh-cn-only-ui
- PR: merged
- Tests: npm run test:electron
- UI verification: development-mode Electron + Computer Use
- Package: dist-electron/mac-arm64/VPN Subscription Automation.app
```
