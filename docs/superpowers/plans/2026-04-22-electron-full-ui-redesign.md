# Electron Full UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Electron renderer into a design-mockup-driven multi-page desktop workspace while preserving profile save/run/stop behavior and adding end-to-end plus visual verification.

**Architecture:** Keep the Electron bridge and backend contract intact, but replace the renderer shell with a page-based SPA driven by shared state. Move page markup generation into renderer view helpers so the UI can cover all design-mockup screens without turning one file into an unreviewable template blob.

**Tech Stack:** Electron, native HTML/CSS/ES modules, Playwright, Node test runner

---

### Task 1: Lock in the redesigned UI contract with failing renderer tests

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`

- [ ] **Step 1: Write the failing e2e assertions for multi-page navigation**

```js
const pages = [
  ['#navDashboard', '仪表盘总览'],
  ['#navConfig', '配置管理'],
  ['#navRuns', '运行任务'],
  ['#navHistory', '任务历史']
];
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/tests/renderer-e2e.test.mjs`
Expected: FAIL because the current renderer does not expose the new nav targets and page titles.

- [ ] **Step 3: Write the failing visual hash coverage for the redesigned pages**

```js
const expectedDigests = {
  dashboard: 'TO_BE_REPLACED_AFTER_GREEN',
  config: 'TO_BE_REPLACED_AFTER_GREEN'
};
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test electron/tests/renderer-visual.test.mjs`
Expected: FAIL because the screenshot hash does not match the redesigned UI.

### Task 2: Rebuild renderer structure and styles around the 11-page design

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/index.html`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/state.js`

- [ ] **Step 1: Replace the single-scroll dashboard shell with page navigation + content host**

```html
<aside class="sidebar">…11 nav buttons…</aside>
<div class="main-shell">
  <header class="topbar">…shortcut actions + run controls…</header>
  <main id="pageContent" class="page-content"></main>
</div>
```

- [ ] **Step 2: Run the e2e test and confirm it still fails on missing page rendering**

Run: `node --test electron/tests/renderer-e2e.test.mjs`
Expected: FAIL with missing titles/content because page renderers are not implemented yet.

- [ ] **Step 3: Implement deterministic view-model helpers and page renderers**

```js
export function buildDashboardPage(viewModel, messages) { /* returns html */ }
export function buildConfigPage(viewModel, messages) { /* returns html */ }
export function buildMonitorPage(viewModel, messages) { /* returns html */ }
```

- [ ] **Step 4: Add the desktop visual system**

```css
.workspace-shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); }
.page-card { border: 1px solid var(--border); border-radius: 24px; background: #fff; }
.terminal-panel { background: #101826; color: #d9e6ff; }
```

- [ ] **Step 5: Run renderer tests again**

Run: `node --test electron/tests/renderer-e2e.test.mjs`
Expected: PASS after navigation/content/state behavior are present.

### Task 3: Refresh Electron integration tests and workflow docs

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/app-launch.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/AGENTS.md`

- [ ] **Step 1: Update launch and state tests for the new configuration page and text copy**

```js
await page.locator('#navConfig').click();
await page.waitForSelector('#configPrimarySource');
```

- [ ] **Step 2: Run the targeted tests and verify failures if expectations still reference the old dashboard**

Run: `node --test electron/tests/app-launch.test.mjs electron/tests/ui-state.test.mjs`
Expected: FAIL until the new selectors and messages are aligned.

- [ ] **Step 3: Fix tests and document the mandatory Playwright/Computer Use verification loop**

```md
- After every UI/UX edit or any behavior-changing task update, rerun Playwright or Computer Use end-to-end verification plus pixel-level / visual checks before moving on.
```

- [ ] **Step 4: Re-run the targeted tests**

Run: `node --test electron/tests/app-launch.test.mjs electron/tests/ui-state.test.mjs`
Expected: PASS.

### Task 4: Final verification, PR, review, merge, package

**Files:**
- Modify as needed: all touched renderer/test/docs files

- [ ] **Step 1: Update visual hashes from the final screenshots**

```js
assert.deepEqual(digests, {
  dashboard: '<final hash>',
  config: '<final hash>'
});
```

- [ ] **Step 2: Run full verification**

Run: `python3 -m pytest tests -v && node --test electron/tests/*.test.mjs`
Expected: all tests pass

- [ ] **Step 3: Run explicit UI verification**

Run: `node --test electron/tests/renderer-e2e.test.mjs electron/tests/renderer-visual.test.mjs`
Expected: all redesigned page checks and screenshot hashes pass

- [ ] **Step 4: Create PR, request review, apply feedback, and merge**

```bash
git checkout -b feat/electron-full-ui-redesign
git add electron/renderer electron/tests AGENTS.md docs/superpowers/specs/2026-04-22-electron-full-ui-redesign-design.md docs/superpowers/plans/2026-04-22-electron-full-ui-redesign.md
git commit -m "feat: redesign electron desktop workspace"
```

- [ ] **Step 5: Package the Electron app**

Run: `npm run package:electron`
Expected: app bundle generated under `dist-electron/`
