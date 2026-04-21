# Packaging and Profile Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix empty crawler-source configuration in the Electron app, then verify dev launch, package the macOS app, and verify the packaged app launches against the same profile.

**Architecture:** Keep `state/profiles/default.json` as the canonical desktop profile, harden project-root resolution for both dev and packaged Electron runs, and preserve the Python backend as the profile/pipeline bridge invoked from Electron IPC.

**Tech Stack:** Electron, electron-builder, Node.js, Python 3.12, pytest, node:test, Playwright

---

### Task 1: Reproduce and pin down profile-loading behavior

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`

- [ ] **Step 1: Add a failing test for packaged/dev root resolution inputs**

```js
test('resolveProjectRoot prefers an explicit project root and falls back to a discoverable repo root', () => {
  // Add assertions around representative dev and packaged paths.
});
```

- [ ] **Step 2: Run test to verify current gap**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && node --test electron/tests/backend.test.mjs`
Expected: at least one new assertion fails before the fix.

- [ ] **Step 3: Implement the minimal path-resolution hardening**

```js
export function resolveProjectRoot(explicitRoot = '') {
  // explicit env / parameter -> packaged sibling repo discovery -> existing fallback
}
```

- [ ] **Step 4: Re-run backend bridge tests**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && node --test electron/tests/backend.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation add electron/tests/backend.test.mjs electron/paths.js
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation commit -m "fix: harden electron project root resolution"
```

### Task 2: Lock profile loading to the existing state profile

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/test_profile_store.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/store.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/models.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/test_profile_store.py`

- [ ] **Step 1: Add a failing regression test for existing `state/profiles/default.json` data**

```python
def test_load_or_create_keeps_existing_source_urls_and_keys(tmp_path):
    ...
```

- [ ] **Step 2: Run pytest for the new regression**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/test_profile_store.py -v`
Expected: FAIL if the current logic rebuilds or misroutes profile state.

- [ ] **Step 3: Implement the minimal fix**

```python
def load_or_create(self, project_root: Path) -> AppProfile:
    if self.path.exists():
        return self.load()
    profile = create_default_profile(project_root)
    self.save(profile)
    return profile
```

- [ ] **Step 4: Re-run profile-store tests**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/test_profile_store.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation add tests/test_profile_store.py src/vpn_automation/config/store.py src/vpn_automation/config/models.py
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation commit -m "test: lock profile loading to existing state data"
```

### Task 3: Verify dev launch and renderer behavior

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Add or tighten an assertion that source URLs are rendered**

```js
const summaryText = await page.locator('#sourcesSummary').innerText();
assert.match(summaryText, /https?:\/\//);
```

- [ ] **Step 2: Run the renderer e2e test**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && node --test electron/tests/renderer-e2e.test.mjs`
Expected: PASS after preserving existing behavior.

- [ ] **Step 3: Launch Electron in dev mode**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && npm run electron:dev`
Expected: app window opens and the sources drawer shows five populated sources.

- [ ] **Step 4: Capture verification evidence**

Run: inspect the running window and confirm populated source fields/log state.
Expected: no empty source URLs for the five configured sources.

### Task 4: Package and validate the macOS app

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/package.json`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/paths.js`
- Test: packaged output under `/Users/swimmingliu/data/VPN/vpn-subscription-automation/dist-electron`

- [ ] **Step 1: Make packaged runtime locate the real project root/resources**

```js
// packaged app should resolve repo root or explicit resource locations before spawning python
```

- [ ] **Step 2: Build the `.app` output**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && npm run package:electron`
Expected: `dist-electron/mac-arm64/VPN Subscription Automation.app` exists

- [ ] **Step 3: Launch the packaged app**

Run: `open /Users/swimmingliu/data/VPN/vpn-subscription-automation/dist-electron/mac-arm64/VPN\\ Subscription\\ Automation.app`
Expected: app opens successfully

- [ ] **Step 4: Verify packaged app uses the populated profile**

Run: inspect the packaged app window and source drawer.
Expected: the same five source URLs / keys are visible

- [ ] **Step 5: Commit**

```bash
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation add package.json electron/paths.js
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation commit -m "build: make packaged electron app resolve repo resources"
```
