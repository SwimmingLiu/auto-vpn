# Electron Stage Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add artifact-based stage retry to the Electron runs page so users can choose a historical run and restart from `speedtest` or a later stage through `verify`.

**Architecture:** Keep the existing full-run pipeline untouched. Add a backend artifact-history and `retry-stage` path that reconstructs inputs from artifact files and `run.db`, creates a fresh retry artifact, and emits the same event stream consumed by the renderer. Update the runs page to select an artifact and a retryable stage, then call the new Electron bridge.

**Tech Stack:** Python 3.12/3.14, pytest, sqlite3, Electron IPC, vanilla renderer JS, Playwright, node:test

---

### Task 1: Add backend artifact history and retry orchestration

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend_resume.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/run_store.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_backend_cli.py`

- [ ] **Step 1: Write failing backend tests for artifact list and retry-stage**
- [ ] **Step 2: Run the targeted backend tests to confirm failure**
- [ ] **Step 3: Implement `artifact-list` and `retry-stage` CLI support with artifact-based stage restoration**
- [ ] **Step 4: Re-run the targeted backend tests to verify pass**

### Task 2: Expose retry-stage through Electron bridge

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/lib/backend.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/preload.cjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`

- [ ] **Step 1: Write failing Electron-side tests for the new bridge/invocation paths**
- [ ] **Step 2: Run the targeted Electron backend tests to confirm failure**
- [ ] **Step 3: Implement `artifactList` / `retryStage` bridge methods and IPC handlers**
- [ ] **Step 4: Re-run the targeted Electron backend tests to verify pass**

### Task 3: Add runs-page history + stage retry UI

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/state.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Write failing renderer e2e assertions for the new runs-page controls**
- [ ] **Step 2: Run the targeted renderer test to confirm failure**
- [ ] **Step 3: Implement history selection, retryable-stage selection, and retry action wiring**
- [ ] **Step 4: Re-run the targeted renderer test to verify pass**

### Task 4: Refresh visual baseline and run full verification

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`

- [ ] **Step 1: Run visual test to capture the updated runs-page digest**
- [ ] **Step 2: Update the expected `runs` digest**
- [ ] **Step 3: Run `rtk npm run test:all`**
- [ ] **Step 4: Do one browser-based runs-page verification and one real `retry-stage` smoke run**

