# SQLite Run Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite-backed runtime checkpoints for pipeline stages, make extract always honor the configured upstream proxy, and temporarily reduce source `max_iterations` to 5000.

**Architecture:** Introduce a dedicated SQLite persistence layer under `src/vpn_automation/pipeline/run_store.py`, thread it through `PipelineController` and the extract pipeline, then update monitoring to read the live database before falling back to log parsing. Keep artifact text files for compatibility, but generate them from the checkpointed data.

**Tech Stack:** Python 3.14, sqlite3, pytest, shell monitoring script, Electron/backend pipeline layout

---

### Task 1: Add failing tests for SQLite checkpoint persistence

**Files:**
- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/pipeline/test_run_store.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/e2e/test_controller_e2e.py`

- [ ] **Step 1: Write the failing unit tests**

```python
from pathlib import Path

from vpn_automation.pipeline.run_store import RunStore


def test_run_store_creates_schema(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "run.db")
    store.initialize(artifact_dir=str(tmp_path / "artifacts"))

    assert (tmp_path / "run.db").exists()
    assert store.fetch_stage_status()["doctor"] == "pending"


def test_run_store_records_progress_and_raw_links(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "run.db")
    store.initialize(artifact_dir=str(tmp_path / "artifacts"))

    store.record_source_progress(
        source_name="leiting",
        iteration=3,
        max_iterations=5000,
        new_links=1,
        raw_links=2,
        successful_iterations=3,
        failed_iterations=0,
    )
    store.record_raw_link("leiting", "vmess://first")
    store.record_raw_link("leiting", "vmess://second")

    assert store.fetch_source_progress()["leiting"]["raw_links"] == 2
    assert store.count_links("raw_links") == 2
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/pipeline/test_run_store.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/e2e/test_controller_e2e.py -q
```

Expected: FAIL with `ModuleNotFoundError` or missing `RunStore` / `run.db` assertions.

- [ ] **Step 3: Write minimal implementation**

Create `run_store.py` with:

```python
class RunStore:
    def __init__(self, path: Path) -> None:
        self.path = path
```

and stub methods for `initialize`, `record_source_progress`, `record_raw_link`, `fetch_stage_status`, `fetch_source_progress`, `count_links`.

- [ ] **Step 4: Run tests to verify GREEN**

Run the same pytest command and confirm the new tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy add tests/pipeline/test_run_store.py tests/e2e/test_controller_e2e.py src/vpn_automation/pipeline/run_store.py
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy commit -m "test: add sqlite checkpoint coverage"
```

### Task 2: Make extract always use the configured upstream proxy and lower iterations to 5000

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src/vpn_automation/pipeline/extract.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/pipeline/test_extract.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src/vpn_automation/config/models.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/electron/runtime/default-profile.toml`

- [ ] **Step 1: Write the failing tests**

Add tests asserting:

```python
def test_fetch_source_links_uses_upstream_proxy_for_every_request(...):
    ...
    assert all(call["proxies"] == {
        "http": "http://127.0.0.1:7897",
        "https": "http://127.0.0.1:7897",
    } for call in calls)


def test_default_profile_caps_source_iterations_at_5000():
    profile = create_default_profile(Path("/tmp/project"))
    assert all(source.max_iterations == 5000 for source in profile.sources.values())
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/pipeline/test_extract.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/config/test_store.py -q
```

Expected: FAIL because current code still uses `proxies=None` for the first attempt and defaults remain above 5000.

- [ ] **Step 3: Write minimal implementation**

Change `fetch_source_links()` to set:

```python
request_proxies = upstream_proxies or None
response = session.get(url, timeout=20, verify=False, proxies=request_proxies)
```

and remove the direct-first retry branch.

Change default source configs so `max_iterations=5000`.

- [ ] **Step 4: Run tests to verify GREEN**

Run the same pytest command and confirm pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy add src/vpn_automation/pipeline/extract.py tests/pipeline/test_extract.py src/vpn_automation/config/models.py electron/runtime/default-profile.toml
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy commit -m "feat: use upstream proxy for all extract sources"
```

### Task 3: Integrate RunStore into PipelineController and export artifact files from checkpointed data

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src/vpn_automation/pipeline/controller.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src/vpn_automation/backend.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/pipeline/test_controller.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/e2e/test_controller_e2e.py`

- [ ] **Step 1: Write the failing tests**

Add assertions that a successful controller run creates:

```python
assert (Path(summary.artifact_dir) / "run.db").exists()
assert summary.counts["raw_links"] == 2
```

and that `test_run_extract_executes_enabled_sources_in_parallel` leaves raw links visible in SQLite before the method returns.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/pipeline/test_controller.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/e2e/test_controller_e2e.py -q
```

Expected: FAIL because `run.db` is not created and controller does not write checkpoints mid-run.

- [ ] **Step 3: Write minimal implementation**

Update `PipelineController` to:

- initialize `RunStore` right after artifact creation
- mirror `set_stage()` into the store
- pass a progress/raw-link writer into extract
- record stage outputs for speedtest / availability / final links
- export `vpn_node_raw.txt`, `vpn_node_speedtest.txt`, `vpn_node_availability.txt`, `vpn_node_emoji.txt` from checkpointed data

- [ ] **Step 4: Run tests to verify GREEN**

Run the same pytest command and confirm pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy add src/vpn_automation/pipeline/controller.py src/vpn_automation/backend.py tests/pipeline/test_controller.py tests/e2e/test_controller_e2e.py
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy commit -m "feat: checkpoint pipeline state in sqlite"
```

### Task 4: Update monitoring to read SQLite first

**Files:**
- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/scripts/monitor_run.sh`
- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/backend/test_monitor_script.py`

- [ ] **Step 1: Write the failing tests**

Add a fixture that creates `run.db` and assert:

```python
assert "Latest db:" in result.stdout
assert "raw=3" in result.stdout
assert "leiting: iter 12/5000 raw=2" in result.stdout
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/backend/test_monitor_script.py -q
```

Expected: FAIL because the monitor only parses logs and text artifacts.

- [ ] **Step 3: Write minimal implementation**

Teach `monitor_run.sh` to:

- discover latest `run.db`
- query stage/source/count data with `sqlite3`
- fall back to old log parsing when `run.db` is absent

- [ ] **Step 4: Run tests to verify GREEN**

Run the same pytest command and confirm pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy add scripts/monitor_run.sh tests/backend/test_monitor_script.py
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy commit -m "feat: read live sqlite checkpoints from monitor"
```

### Task 5: Sync shipped config and verify end-to-end

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/README.md`

- [ ] **Step 1: Write the failing checks**

Use a simple config assertion:

```bash
rg -n "^max_iterations = 5000$" /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/electron/runtime/default-profile.toml
```

Expected before change: no full match for every source.

- [ ] **Step 2: Update shipped config and local runtime config**

Set every source in `electron/runtime/default-profile.toml` to:

```toml
max_iterations = 5000
```

If the local runtime file exists at:

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/state/profile.toml`

set every source there to the same value as a local environment update (do not commit that file if it is ignored).

Document that:

- extract requests use `VPN_AUTOMATION_UPSTREAM_PROXY` uniformly
- `run.db` is created per artifact directory

- [ ] **Step 3: Run verification**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/backend /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/config /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/e2e /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/pipeline -q
node --test /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/electron/tests/*.test.mjs
/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/scripts/monitor_run.sh --once /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy
```

Expected:

- targeted Python suites pass
- Electron tests pass
- monitor script prints SQLite-backed stage/count output

- [ ] **Step 4: Commit**

```bash
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy add README.md electron/runtime/default-profile.toml
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy commit -m "docs: describe sqlite checkpoints and proxy behavior"
```

### Task 6: Publish, review, merge, package

**Files:**
- Modify: only if review feedback requires follow-up

- [ ] **Step 1: Run final verification before publish**

Run:

```bash
PYTHONPATH=/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/python -m pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/backend /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/config /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/e2e /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/tests/pipeline -q
node --test /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/electron/tests/*.test.mjs
npm run package:electron
```

Expected: all commands exit 0 and packaging produces a runnable `.app`.

- [ ] **Step 2: Push and open PR**

```bash
git -C /Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy push -u origin codex/sqlite-checkpoints-proxy
gh pr create --repo SwimmingLiu/vpn-subscription-automation --title "feat: persist pipeline checkpoints in sqlite" --body-file /tmp/sqlite-checkpoints-pr-body.md
```

- [ ] **Step 3: Request Copilot review**

```bash
gh pr edit --repo SwimmingLiu/vpn-subscription-automation --add-reviewer copilot
```

- [ ] **Step 4: Address review feedback**

If review requires changes, repeat Task 5 verification after each follow-up change.

- [ ] **Step 5: Merge and package**

```bash
gh pr merge --repo SwimmingLiu/vpn-subscription-automation --squash --delete-branch
npm run package:electron
```

Expected: PR merged and packaged app emitted under `dist-electron/mac-arm64/`.
