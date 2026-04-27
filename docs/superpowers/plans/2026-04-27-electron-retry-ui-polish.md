# Electron Retry UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove non-run artifacts from retry history, replace the runs-page retry cards with a dual-select layout, and add visible copy-node feedback in the Electron results page.

**Architecture:** Keep the existing retry-stage backend flow unchanged, but tighten artifact discovery so only real run artifacts are listed. In the renderer, swap the retry card list for two selects plus a summary box, move selection updates onto `change`, and add a small toast system backed by an Electron clipboard bridge with browser fallback.

**Tech Stack:** Python 3.12/3.14, pytest, Electron IPC, Electron clipboard, vanilla renderer JS, Playwright, node:test

---

### Task 1: Filter retry history to real run artifacts

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend_resume.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_backend_cli.py`

- [ ] **Step 1: Write the failing backend test**

```python
def test_artifact_list_json_filters_non_run_directories(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifacts_root = project_root / "artifacts"
    real_artifact = artifacts_root / "20260427-081718"
    fake_artifact = artifacts_root / "screenshots"
    real_artifact.mkdir(parents=True)
    fake_artifact.mkdir(parents=True)
    (real_artifact / "pipeline_report.json").write_text(
        json.dumps({"artifact_dir": str(real_artifact), "run_status": "success"}, ensure_ascii=False),
        encoding="utf-8",
    )
    (fake_artifact / "runs-current.png").write_text("png", encoding="utf-8")

    payload = json.loads(artifact_list_json(project_root))

    assert [item["artifact_name"] for item in payload["items"]] == ["20260427-081718"]
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && .venv/bin/pytest tests/backend/test_backend_cli.py -k artifact_list_json_filters_non_run_directories -v
```

Expected: FAIL because `screenshots` is still included.

- [ ] **Step 3: Write minimal implementation**

Add a helper in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend_resume.py` that only accepts artifact directories whose names match `YYYYMMDD-HHMMSS` and that contain `run.db` or `pipeline_report.json`, then use it inside `list_artifacts_with_retry_stages()`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && .venv/bin/pytest tests/backend/test_backend_cli.py -k artifact_list_json_filters_non_run_directories -v
```

Expected: PASS.

### Task 2: Replace retry artifact cards with dual selects

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Write the failing renderer tests**

Add assertions that:

```javascript
assert.equal(await page.locator('[data-run-retry-artifact]').count(), 1);
assert.equal(await page.locator('[data-run-retry-stage]').count(), 1);
assert.equal(await page.locator('[data-run-retry-artifact-card]').count(), 0);
```

Also verify the selected run can be changed through `selectOption(...)` and the retry payload still uses the chosen artifact/stage.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && rtk node --test electron/tests/renderer-e2e.test.mjs
```

Expected: FAIL because the page still renders card buttons and click-based selection.

- [ ] **Step 3: Write minimal implementation**

In `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`, replace the card list with:

```html
<select data-run-retry-artifact>...</select>
<select data-run-retry-stage>...</select>
```

Render a compact summary box below the controls. In `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`, remove `data-run-retry-stage` handling from the `click` path and keep both selects on `change` / `input`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && rtk node --test electron/tests/renderer-e2e.test.mjs
```

Expected: PASS.

### Task 3: Add clipboard bridge and visible copy toast

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/preload.cjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add a backend-side API shape test:

```javascript
assert.equal(typeof window.vpnAutomation?.copyText, 'function');
```

Add a renderer e2e check that clicking “复制节点” produces a visible toast such as `已复制 1 条节点`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && rtk node --test electron/tests/backend.test.mjs electron/tests/renderer-e2e.test.mjs
```

Expected: FAIL because no bridge or toast exists.

- [ ] **Step 3: Write minimal implementation**

Expose `copyText` through preload and IPC, using Electron `clipboard.writeText`. In the renderer, prefer the bridge, fall back to `navigator.clipboard`, and show:

```javascript
showToast({ tone: 'success', message: `已复制 ${count} 条节点` });
```

For failures:

```javascript
showToast({ tone: 'danger', message: `复制失败：${error.message}` });
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && rtk node --test electron/tests/backend.test.mjs electron/tests/renderer-e2e.test.mjs
```

Expected: PASS.

### Task 4: Refresh visual baseline and run full verification

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`

- [ ] **Step 1: Run the visual suite to get the updated runs-page hash**

Run:

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && rtk node --test electron/tests/renderer-visual.test.mjs
```

Expected: FAIL with a new `runs` digest.

- [ ] **Step 2: Update the expected `runs` digest**

Only replace the `runs` hash in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs` after confirming the screenshot matches the dual-select layout.

- [ ] **Step 3: Run the full project test stack**

Run:

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && rtk npm run test:all
```

Expected: exit 0.

- [ ] **Step 4: Do UI and runtime verification**

Run one Playwright/browser verification against the updated runs page and one real smoke command:

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && PYTHONPATH=src .venv/bin/python -m vpn_automation.backend artifact-list --project-root /Users/swimmingliu/data/VPN/vpn-subscription-automation
```

Confirm `screenshots` is absent, then verify the result-page copy toast through Playwright.
