# v3 Node Detached Resume-Latest Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Historical boundary plan: keep detached `resume-latest` fallback on the compatible Python worker while `AUTOVPN_BACKEND=node run --detach` uses the Node worker.

**Architecture:** `startDetachedRun()` originally had two worker choices. Plain detached run under `AUTOVPN_BACKEND=node` used the Node CLI worker, but detached `resumeLatest` still resolved the Python CLI. This plan captured that earlier boundary before foreground `run --resume-latest` and detached resume/retry workers became Node-native under `AUTOVPN_BACKEND=node`.

**Tech Stack:** Node.js ESM, TypeScript, `node:test`, existing AutoVPN npm CLI job manager.

---

### Task 1: Capture Resume-Latest Worker Boundary

**Files:**
- Modify: `npm/autovpn-cli/test/jobs/job-manager.test.mjs`
- Modify: `npm/autovpn-cli/src/jobs/commands.ts`

- [x] **Step 1: Write the failing test**

Update `jobs resume detached falls back to resume-latest for run jobs without session metadata` so it runs with `AUTOVPN_BACKEND=node` and asserts the spawned command remains `/venv/bin/autovpn` and includes `--resume-latest`.

- [x] **Step 2: Run test to verify it fails**

Run: `rtk proxy npm run build --prefix npm/autovpn-cli && rtk proxy node --test npm/autovpn-cli/test/jobs/job-manager.test.mjs`

Expected: FAIL because the worker is currently `process.execPath`.

- [x] **Step 3: Implement minimal fix**

Change `wantsNodeWorker()` to return true only when `AUTOVPN_BACKEND=node` and `command.resumeLatest` is false.

- [x] **Step 4: Run target tests**

Run: `rtk proxy npm run build --prefix npm/autovpn-cli && rtk proxy node --test npm/autovpn-cli/test/jobs/job-manager.test.mjs npm/autovpn-cli/test/backend-contract.test.mjs`

Expected: PASS.

### Task 2: Full Validation And Release Hygiene

**Files:**
- Read: `npm/autovpn-cli/src/jobs/commands.ts`
- Read: `npm/autovpn-cli/test/jobs/job-manager.test.mjs`

- [x] **Step 1: Run npm CLI tests**

Run: `rtk proxy npm test --prefix npm/autovpn-cli`

Expected: PASS.

- [x] **Step 2: Run Electron headless regression tests**

Run: `rtk proxy node --test electron/tests/*.test.mjs`

Expected: PASS.

- [x] **Step 3: Run Python regression tests**

Run: `rtk proxy uv run --with pytest pytest tests -q`

Expected: PASS.

- [x] **Step 4: Run package dry-run**

Run: `rtk proxy npm pack --dry-run`

Expected: PASS.

- [ ] **Step 5: PR, CI, merge, sync, cleanup, package**

Push the branch, create a PR, wait for CI, perform local review, merge, delete remote/local feature branch and worktree, then package latest main and smoke-test `autovpn --version`.

## Self-Review

- Spec coverage: This plan covers the `resume-latest` detached worker boundary introduced by the Node detached worker migration.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: The plan uses existing `DetachedRunCommand.resumeLatest` and job manager contracts unchanged.
