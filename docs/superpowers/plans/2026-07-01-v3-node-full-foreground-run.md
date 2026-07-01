# v3 Node Full Foreground Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `AUTOVPN_BACKEND=node autovpn run --project-root . --output jsonl` to enter the Node foreground pipeline with deploy and verify enabled, instead of requiring deploy/verify Python stage fallback.

**Architecture:** Keep Python as the default production backend, but remove the obsolete `NodeBackend.run()` deploy/verify guard now that the Node deploy stage supports Wrangler deploys, blocked-project fallback, share-project sync/fallback, custom-domain binding, DNS upsert, and verify. Leave detached jobs, `resume`, `retry-stage`, and `--resume-latest` on Python-backed paths.

**Tech Stack:** Node.js ESM, TypeScript, `node:test`, existing AutoVPN npm CLI backend adapter.

---

### Task 1: Unlock Node Foreground Deploy/Verify

**Files:**
- Modify: `npm/autovpn-cli/test/backend-contract.test.mjs`
- Modify: `npm/autovpn-cli/src/backend/node-backend.ts`

- [x] **Step 1: Write the failing test**

Replace the old `NodeBackend rejects deploy runs before creating artifacts` contract with a test that consumes a full foreground Node run and expects the failure to come from normal pipeline profile loading:

```js
test('NodeBackend allows full foreground runs through the Node deploy and verify stages', async () => {
  const projectRoot = await mkdir(path.join(os.tmpdir(), `autovpn-node-backend-full-run-${Date.now()}`, 'project'), { recursive: true });
  const events = [];
  const backend = new NodeBackend({
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime') },
    cwd: projectRoot
  });

  await assert.rejects(async () => {
    for await (const event of backend.run({ projectRoot, skipDeploy: false, skipVerify: false, output: 'jsonl' })) {
      events.push(event);
    }
  }, /profile\.toml/);

  assert.equal(events[0].type, 'run_started');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `rtk proxy node --test npm/autovpn-cli/test/backend-contract.test.mjs`

Expected: FAIL with `Node backend deploy is not available yet`.

- [x] **Step 3: Write minimal implementation**

Delete the obsolete deploy/verify guard from `NodeBackend.run()` and remove the now-unused `usesPythonStageFallback()` helper. Keep the `resumeLatest` guard intact.

- [x] **Step 4: Run target test to verify it passes**

Run: `rtk proxy npm run build --prefix npm/autovpn-cli && rtk proxy node --test npm/autovpn-cli/test/backend-contract.test.mjs`

Expected: PASS, 25 backend-contract tests.

### Task 2: Update Operator Documentation

**Files:**
- Modify: `README.md`
- Modify: `npm/autovpn-cli/README.md`

- [x] **Step 1: Update root README Node validation example**

Change the experimental Node backend example from an offline `--skip-deploy --skip-verify` command to the full foreground command:

```bash
AUTOVPN_BACKEND=node autovpn run --project-root /opt/autovpn/vpn-subscription-automation --output jsonl
```

State that `--skip-deploy --skip-verify` remains available for offline checks.

- [x] **Step 2: Update npm CLI README limits**

Rename the example to "Experimental Node-orchestrated foreground run", document the full command, and keep the current limits:

```bash
AUTOVPN_BACKEND=node \
autovpn run --project-root . --output jsonl
```

Add `AUTOVPN_STAGE_BACKEND_DEPLOY` and `AUTOVPN_STAGE_BACKEND_VERIFY` to the fallback environment variable list.

### Task 3: Validation And Release Hygiene

**Files:**
- Read: `README.md`
- Read: `npm/autovpn-cli/README.md`
- Read: `npm/autovpn-cli/src/backend/node-backend.ts`
- Read: `npm/autovpn-cli/test/backend-contract.test.mjs`

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

Expected: PASS and no packaging errors.

- [ ] **Step 5: Open PR, wait for CI, merge, sync, clean, and package**

Follow the project post-development workflow: push branch, open PR, confirm CI, perform local review, merge, delete remote/local feature branch and worktree, then package the latest main tarball and smoke-test `autovpn --version`.

## Self-Review

- Spec coverage: This plan covers the stale NodeBackend full-run blocker, operator docs, tests, PR, cleanup, and packaging.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: The plan uses the existing `NodeBackend.run()` and `RunOptions` fields unchanged.
