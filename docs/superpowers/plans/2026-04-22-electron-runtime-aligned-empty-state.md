# Electron Runtime-Aligned Empty State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the Electron app with the real backend capabilities, replace fake seeded UI data with honest empty states, and make the packaged `.app` load backend code plus existing profile data correctly.

**Architecture:** Reduce the renderer to the pages that map to actual product behavior, keep runtime state in one renderer store, and route all packaged profile IO through an explicit runtime profile path. Package Python source next to Electron resources without `asar` so the system Python can import the backend module.

**Tech Stack:** Electron, native HTML/CSS/ES modules, Python backend, Playwright, Node test runner, pytest

---

### Task 1: Lock the new runtime-aligned UI contract with failing tests

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/tests/renderer-e2e.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/tests/renderer-visual.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/tests/ui-state.test.mjs`

- [ ] **Step 1: Write failing assertions for the reduced navigation and empty states**

```js
assert.equal(await page.locator('.sidebar-nav .nav-item').count(), 6);
assert.match(await page.locator('#dashboardEmptyState').innerText(), /暂无运行数据/);
assert.equal(await page.locator('button:has-text("暂停")').count(), 0);
```

- [ ] **Step 2: Run tests and verify they fail for the current fake-data workspace**

Run: `node --test electron/tests/renderer-e2e.test.mjs electron/tests/ui-state.test.mjs`
Expected: FAIL because the current renderer still exposes 11 pages and seeded sample data.

- [ ] **Step 3: Write the failing visual baseline for the runtime-aligned layout**

```js
const EXPECTED_DIGESTS = {
  dashboard: 'replace-after-green',
  config: 'replace-after-green',
  run: 'replace-after-green',
  artifacts: 'replace-after-green',
  logs: 'replace-after-green',
  about: 'replace-after-green'
};
```

- [ ] **Step 4: Run the visual test and verify it fails**

Run: `node --test electron/tests/renderer-visual.test.mjs`
Expected: FAIL because the screenshots still match the over-expanded mockup layout.

### Task 2: Rebuild the renderer around real pages and empty states

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/renderer/index.html`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/renderer/styles.css`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/renderer/i18n.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/renderer/state.js`

- [ ] **Step 1: Replace the 11-page nav with the runtime-aligned 6-page nav**

```js
export const PAGE_ORDER = ['dashboard', 'config', 'run', 'artifacts', 'logs', 'about'];
```

- [ ] **Step 2: Run the e2e test and confirm it still fails until page markup is updated**

Run: `node --test electron/tests/renderer-e2e.test.mjs`
Expected: FAIL on missing page titles or selectors.

- [ ] **Step 3: Remove fake seeded business data from the renderer view model**

```js
const counts = {
  raw_links: state.counts.raw_links ?? 0,
  postprocess_links: state.counts.postprocess_links ?? 0,
  speedtest_links: state.counts.speedtest_links ?? 0,
  availability_links: state.counts.availability_links ?? 0
};
```

- [ ] **Step 4: Add honest empty-state cards and remove unsupported actions**

```js
if (!state.logEntries.length) {
  return '<div id="logsEmptyState" class="empty-state">暂无日志</div>';
}
```

- [ ] **Step 5: Keep only actions with real handlers and wire them explicitly**

```js
const actionButton = event.target.closest('[data-action]');
if (actionButton?.dataset.action === 'open-artifacts') {
  return openArtifactsDirectory();
}
```

- [ ] **Step 6: Re-run renderer tests and make them pass**

Run: `node --test electron/tests/renderer-e2e.test.mjs electron/tests/ui-state.test.mjs`
Expected: PASS.

### Task 3: Make default profiles truly empty and package profile migration explicit

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/src/vpn_automation/config/models.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/src/vpn_automation/config/store.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/src/vpn_automation/backend.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/tests/config/test_store.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/tests/backend/test_backend_cli.py`

- [ ] **Step 1: Write failing tests for empty defaults and env-driven runtime profile paths**

```python
def test_create_default_profile_starts_empty(tmp_path: Path) -> None:
    profile = create_default_profile(tmp_path)
    assert profile.sources["leiting"].url == ""
    assert profile.deploy.subscription_url == ""
```

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run: `. .venv/bin/activate && python -m pytest tests/config/test_store.py tests/backend/test_backend_cli.py -v`
Expected: FAIL because defaults are still seeded and profile path env is ignored.

- [ ] **Step 3: Implement empty defaults plus seed/migration loading**

```python
profile_override = os.environ.get("VPN_AUTOMATION_PROFILE_PATH")
seed_override = os.environ.get("VPN_AUTOMATION_BUNDLED_PROFILE_PATH")
```

- [ ] **Step 4: Re-run the targeted tests**

Run: `. .venv/bin/activate && python -m pytest tests/config/test_store.py tests/backend/test_backend_cli.py -v`
Expected: PASS.

### Task 4: Fix packaged runtime backend loading and artifact actions

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/main.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/ipc.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/paths.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/lib/backend.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/electron/tests/app-launch.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/package.json`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions/tests/integrations/test_packaging.py`

- [ ] **Step 1: Write the failing packaging/runtime assertions**

```js
assert.match(String(build.files), /src/);
assert.equal(build.asar, false);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `. .venv/bin/activate && python -m pytest tests/integrations/test_packaging.py -v && node --test electron/tests/app-launch.test.mjs`
Expected: FAIL because packaged runtime files are not present and app launch assumptions are incomplete.

- [ ] **Step 3: Pass explicit runtime profile and bundled seed paths into the backend environment**

```js
env: {
  ...process.env,
  PYTHONPATH: path.join(projectRoot, 'src'),
  VPN_AUTOMATION_PROFILE_PATH: runtimeProfilePath,
  VPN_AUTOMATION_BUNDLED_PROFILE_PATH: bundledProfilePath
}
```

- [ ] **Step 4: Update packaging config to ship backend source and seed profile**

```json
"files": [
  "electron/**/*",
  "src/**/*",
  "pyproject.toml",
  "state/profiles/default.json"
],
"asar": false
```

- [ ] **Step 5: Re-run the targeted tests**

Run: `. .venv/bin/activate && python -m pytest tests/integrations/test_packaging.py -v && node --test electron/tests/app-launch.test.mjs`
Expected: PASS.

### Task 5: Final verification, packaged launch proof, and screenshots

**Files:**
- Modify as needed: renderer, backend, tests, package config, docs

- [ ] **Step 1: Update final visual hashes**

```js
const EXPECTED_DIGESTS = {
  dashboard: '<final hash>',
  config: '<final hash>',
  run: '<final hash>',
  artifacts: '<final hash>',
  logs: '<final hash>',
  about: '<final hash>'
};
```

- [ ] **Step 2: Run full repo verification**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/runtime-empty-real-actions && . .venv/bin/activate && python -m pytest tests -v && node --test electron/tests/*.test.mjs`
Expected: all tests pass

- [ ] **Step 3: Run packaging and packaged launch verification**

Run: `npm run package:electron`
Expected: `.app` generated successfully

- [ ] **Step 4: Launch the packaged app and verify profile load succeeds**

Run: `\"dist-electron/mac-arm64/VPN Subscription Automation.app/Contents/MacOS/VPN Subscription Automation\"`
Expected: no `ModuleNotFoundError` for `vpn_automation`, profile load succeeds

- [ ] **Step 5: Export fresh screenshots of the packaged app**

Run: Playwright or desktop screenshot capture against the packaged app
Expected: deliverable images showing dashboard/config/run pages with empty-state honest UI
