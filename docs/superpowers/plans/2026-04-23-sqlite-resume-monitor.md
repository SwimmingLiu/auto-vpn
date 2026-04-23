# SQLite Resume and Extract Attempt Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resume-latest support on top of the SQLite checkpoint pipeline and expose per-attempt extract monitoring for all sources.

**Architecture:** Extend the SQLite schema with `extract_attempts` and run status metadata, then thread resume-aware state loading through backend/controller/extract while keeping artifact exports compatible. Update the monitor script to display both aggregate progress and recent extract attempts.

**Tech Stack:** Python 3.14, sqlite3, pytest, shell monitoring script, existing Electron/Python backend layout

---

### Task 1: Add failing tests for extract attempt logging and run status metadata

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/pipeline/test_run_store.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/pipeline/test_extract.py`

- [ ] **Step 1: Write the failing tests**

Add tests asserting:

```python
def test_run_store_creates_extract_attempts_table(...):
    ...

def test_run_store_records_extract_attempt(...):
    ...

def test_fetch_source_links_records_each_attempt(...):
    ...
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/pipeline/test_run_store.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/pipeline/test_extract.py -q
```

Expected: FAIL because `extract_attempts` schema and logging hooks do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement:

- `RunStore.record_extract_attempt(...)`
- schema for `extract_attempts`
- `runs.updated_at` / `status` updates
- callback wiring inside `fetch_source_links()`

- [ ] **Step 4: Run test to verify it passes**

Run the same pytest command and confirm pass.

- [ ] **Step 5: Commit**

```bash
git add tests/pipeline/test_run_store.py tests/pipeline/test_extract.py src/vpn_automation/pipeline/run_store.py src/vpn_automation/pipeline/extract.py
git commit -m "feat: log extract attempts in sqlite"
```

### Task 2: Add failing tests for resume-latest lookup and extract resume state recovery

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/backend/test_backend_cli.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/e2e/test_controller_e2e.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/pipeline/test_run_store.py`

- [ ] **Step 1: Write the failing tests**

Add tests asserting:

```python
def test_backend_run_resume_latest_uses_latest_incomplete_artifact(...):
    ...

def test_run_store_restores_extract_state_for_source(...):
    ...

def test_pipeline_resume_continues_extract_from_saved_iteration(...):
    ...
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/backend/test_backend_cli.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/e2e/test_controller_e2e.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/pipeline/test_run_store.py -q
```

Expected: FAIL because no resume command/state restoration exists yet.

- [ ] **Step 3: Write minimal implementation**

Implement:

- `RunStore.fetch_latest_incomplete_run(...)`
- `RunStore.fetch_source_resume_state(...)`
- backend CLI `run --resume-latest`
- controller support for opening an existing artifact and resuming extract

- [ ] **Step 4: Run test to verify it passes**

Run the same pytest command and confirm pass.

- [ ] **Step 5: Commit**

```bash
git add tests/backend/test_backend_cli.py tests/e2e/test_controller_e2e.py tests/pipeline/test_run_store.py src/vpn_automation/backend.py src/vpn_automation/pipeline/controller.py src/vpn_automation/pipeline/run_store.py
git commit -m "feat: add resume-latest pipeline mode"
```

### Task 3: Add monitor output for recent extract attempts

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/backend/test_monitor_script.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/scripts/monitor_run.sh`

- [ ] **Step 1: Write the failing tests**

Add assertions such as:

```python
assert "Recent extract attempts:" in result.stdout
assert "leiting iter=12 ok returned=1 new=1 total=2" in result.stdout
assert "heidong iter=13 fail SSLError: boom" in result.stdout
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/backend/test_monitor_script.py -q
```

Expected: FAIL because the monitor does not print recent extract attempts.

- [ ] **Step 3: Write minimal implementation**

Update `monitor_run.sh` to query the latest `extract_attempts` rows and render a compact section beneath source progress.

- [ ] **Step 4: Run test to verify it passes**

Run the same pytest command and confirm pass.

- [ ] **Step 5: Commit**

```bash
git add tests/backend/test_monitor_script.py scripts/monitor_run.sh
git commit -m "feat: show recent extract attempts in monitor"
```

### Task 4: Restore artifact exports and stage skipping during resume

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/src/vpn_automation/pipeline/controller.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/e2e/test_controller_e2e.py`

- [ ] **Step 1: Write the failing tests**

Add coverage that after resume:

```python
assert resumed_summary.counts["raw_links"] == expected
assert resumed_summary.stage_status["extract"] == "success"
assert resumed_summary.stage_status["dedupe"] == "success"
```

and that already completed stage outputs are reused instead of recomputed from scratch.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests/e2e/test_controller_e2e.py -q
```

Expected: FAIL because resume does not yet skip completed stages or reconstruct exports consistently.

- [ ] **Step 3: Write minimal implementation**

Implement:

- stage completion checks from SQLite
- export helpers that rebuild `vpn_node_raw.txt`, `vpn_node_deduped.txt`, and later outputs from SQLite where applicable
- controller resume summary population

- [ ] **Step 4: Run test to verify it passes**

Run the same pytest command and confirm pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/test_controller_e2e.py src/vpn_automation/pipeline/controller.py
git commit -m "feat: reuse checkpointed stage outputs on resume"
```

### Task 5: Full verification and real resume drill

**Files:**
- Modify only if verification exposes regressions

- [ ] **Step 1: Run full automated verification**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/tests -q
node --test /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/electron/tests/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 2: Run a real extract, stop it, then resume**

Run a real backend command, interrupt it, then:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -u -m vpn_automation.backend run --resume-latest --project-root /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-resume-monitor
```

Then verify:

- `monitor_run.sh --once ...` shows non-empty `Recent extract attempts`
- resumed source iterations continue from the saved value, not from `1`

- [ ] **Step 3: Package the app**

Run:

```bash
npm run package:electron
```

Expected: `.app` emitted successfully.

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "test: verify sqlite resume and monitor flow"
```

### Task 6: Publish and merge

**Files:**
- Modify only if review feedback requires changes

- [ ] **Step 1: Push branch and open PR**

```bash
git push -u origin codex/sqlite-resume-monitor
gh pr create --repo SwimmingLiu/vpn-subscription-automation --base main --head codex/sqlite-resume-monitor --title "feat: add sqlite resume and extract attempt monitor" --body-file /tmp/sqlite-resume-monitor-pr.md
```

- [ ] **Step 2: Request Copilot review**

```bash
gh pr edit <pr> --add-reviewer "@copilot"
```

- [ ] **Step 3: Address review feedback**

If any file changes, rerun Task 5 verification before updating the PR.

- [ ] **Step 4: Merge and package again from the merged code**

```bash
gh pr merge <pr> --squash --delete-branch
npm run package:electron
```

Expected: PR merged and final `.app` built from merged code.
