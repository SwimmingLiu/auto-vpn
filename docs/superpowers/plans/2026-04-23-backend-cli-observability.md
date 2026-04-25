# Backend CLI Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual backend run script, a structured event stream, and a terminal monitor so the real pipeline can be run and observed outside Electron.

**Architecture:** Extend the backend CLI and pipeline controller with structured runtime events and explicit skip controls for deploy/verify, then add shell wrappers that create durable manual-run sessions backed by JSONL event logs. Keep stdout compatible with IPC consumers while giving humans a separate readable mode.

**Tech Stack:** Python 3.12, pytest, shell scripts, existing pipeline modules

---

### Task 1: Lock in backend controller behavior with failing tests

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/e2e/test_controller_e2e.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_controller.py`

- [ ] **Step 1: Write failing tests for skipped deploy/verify and failed-stage reporting**

Add tests that expect:

- `controller.run(..., skip_deploy=True, skip_verify=True)` marks both stages as `skipped`
- a raised exception in a running stage marks that stage `failed`
- `pipeline_report.json` still exists after failure and contains the failed stage status

- [ ] **Step 2: Run the focused controller tests and verify they fail**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_controller.py tests/e2e/test_controller_e2e.py -q`

Expected: FAIL because `PipelineController.run` does not yet accept skip flags or persist failed-stage status.

- [ ] **Step 3: Implement minimal controller support for skipped stages and failure persistence**

Update `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/controller.py` to:

- accept `skip_deploy` / `skip_verify`
- mark skipped stages explicitly
- write `pipeline_report.json` on failure
- re-raise after capturing summary state

- [ ] **Step 4: Re-run the focused controller tests**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_controller.py tests/e2e/test_controller_e2e.py -q`

Expected: PASS

### Task 2: Add structured event emission tests before implementation

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_extract.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_speedtest_runtime.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_availability.py`

- [ ] **Step 1: Write failing tests for extract / speedtest / availability events**

Add tests that expect:

- extract emits request/decrypt/iteration events
- speedtest emits probe and full-test progress events
- availability batch emits per-link result events

- [ ] **Step 2: Run the focused pipeline tests and verify they fail**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_extract.py tests/pipeline/test_speedtest_runtime.py tests/pipeline/test_availability.py -q`

Expected: FAIL because these functions do not yet accept or emit structured event callbacks.

- [ ] **Step 3: Implement minimal structured event hooks**

Update:

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/extract.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/speedtest.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/availability.py`

to emit the events required by the tests while preserving the existing text progress callbacks.

- [ ] **Step 4: Re-run the focused pipeline tests**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_extract.py tests/pipeline/test_speedtest_runtime.py tests/pipeline/test_availability.py -q`

Expected: PASS

### Task 3: Extend backend CLI for manual runs

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_backend_cli.py`

- [ ] **Step 1: Write failing CLI tests for output mode and event log persistence**

Add tests that expect:

- `build_event(...)` still emits valid JSON
- the run pathway can write an `events.jsonl` file
- human output mode renders readable lines instead of raw JSON

- [ ] **Step 2: Run the backend CLI tests and verify they fail**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/backend/test_backend_cli.py -q`

Expected: FAIL because the CLI has no output-mode or event-log support.

- [ ] **Step 3: Implement backend CLI event sinks**

Add:

- `--skip-deploy`
- `--skip-verify`
- `--output`
- `--event-log`
- `--human-log`

and wire them into controller callbacks.

- [ ] **Step 4: Re-run the backend CLI tests**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/backend/test_backend_cli.py -q`

Expected: PASS

### Task 4: Add manual run and monitor scripts

**Files:**
- Add: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/scripts/run_backend_pipeline.sh`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/scripts/monitor_run.sh`
- Add: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_run_script.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_monitor_script.py`

- [ ] **Step 1: Write failing script tests**

Add tests that expect:

- run script dry-run creates/announces a manual-run session with event log paths
- monitor script reads `events.jsonl` and shows request/decrypt counters plus stage summary

- [ ] **Step 2: Run the script-focused tests and verify they fail**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/backend/test_run_script.py tests/backend/test_monitor_script.py -q`

Expected: FAIL because the run script does not exist and the monitor script still parses the old log format.

- [ ] **Step 3: Implement the scripts**

Create a reusable run script and update the monitor script to read session metadata plus `events.jsonl`.

- [ ] **Step 4: Re-run the script-focused tests**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/backend/test_run_script.py tests/backend/test_monitor_script.py -q`

Expected: PASS

### Task 5: Run the end-to-end verification set

**Files:**
- No new files

- [ ] **Step 1: Run Python unit and backend/e2e verification**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/backend tests/pipeline tests/e2e -q`

Expected: PASS

- [ ] **Step 2: Run Electron tests as repository-wide regression coverage**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && npm run test:electron`

Expected: PASS

- [ ] **Step 3: Run the full repo test command**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && npm run test:all`

Expected: PASS

- [ ] **Step 4: Document manual usage in README**

Update `/Users/swimmingliu/data/VPN/vpn-subscription-automation/README.md` with:

- how to run the backend pipeline manually
- how to monitor a session
- default skip-deploy/verify behavior
- how to opt back into deploy/verify later
