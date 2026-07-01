# v3 Node Detached Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `AUTOVPN_BACKEND=node` use the existing Node job manager for detached run, detached resume, and detached retry commands instead of failing on stale Node-backend shell guards.

**Architecture:** Keep detached worker execution compatible with the Python CLI for this slice, but ensure the terminal-facing job manager path remains Node-owned under both default and `AUTOVPN_BACKEND=node` modes. Remove only the shell-level stale guards; do not change job metadata, process-group handling, or worker command construction.

**Tech Stack:** Node.js ESM, TypeScript, `node:test`, existing AutoVPN npm CLI job manager.

---

### Task 1: Allow Node Backend Detached Run

**Files:**
- Modify: `npm/autovpn-cli/test/backend-contract.test.mjs`
- Modify: `npm/autovpn-cli/src/cli/main.ts`

- [x] **Step 1: Write the failing test**

Replace the stale rejection contract with a test that verifies `AUTOVPN_BACKEND=node run --detach --json` creates a Node-managed job and spawns the compatible worker command:

```js
test('Node backend allows detached run through the Node job manager', async () => {
  const io = createIo();
  let executeCliCalled = false;
  const spawns = [];

  const code = await runCliShell(['run', '--project-root', '.', '--skip-deploy', '--skip-verify', '--detach', '--json'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    env: {
      AUTOVPN_BACKEND: 'node',
      AUTOVPN_PYTHON_CLI: '/venv/bin/autovpn',
      VPN_AUTOMATION_RUNTIME_ROOT: '/tmp/autovpn-node-detached-runtime'
    },
    io,
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 3456;
      child.unref = () => {};
      return child;
    },
    now: () => '2026-07-01T00:00:00+00:00',
    jobId: () => '20260701-000000-node-detached',
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      }
    })
  });

  const payload = JSON.parse(io.stdout);
  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.job_id, '20260701-000000-node-detached');
  assert.equal(payload.pid, 3456);
  assert.equal(payload.options.skip_deploy, true);
  assert.equal(payload.options.skip_verify, true);
  assert.equal(executeCliCalled, false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `rtk proxy npm run build --prefix npm/autovpn-cli && rtk proxy node --test npm/autovpn-cli/test/backend-contract.test.mjs`

Expected: FAIL because the shell guard returns `Node backend detached runs are not available yet`.

- [x] **Step 3: Write minimal implementation**

Remove the `argv[0] === 'run' && hasFlag(argv, '--detach')` rejection from `nodeBackendUnsupportedArgv()`.

- [x] **Step 4: Run target tests**

Run: `rtk proxy npm run build --prefix npm/autovpn-cli && rtk proxy node --test npm/autovpn-cli/test/backend-contract.test.mjs npm/autovpn-cli/test/jobs/job-manager.test.mjs`

Expected: PASS.

### Task 2: Allow Node Backend Detached Retry And Resume Paths

**Files:**
- Modify: `npm/autovpn-cli/test/backend-contract.test.mjs`
- Modify: `npm/autovpn-cli/src/cli/main.ts`

- [x] **Step 1: Write the failing detached retry test**

Add a test for `AUTOVPN_BACKEND=node jobs retry --detach --json` that expects a Node-managed retry job and the compatible `retry-stage` worker command.

- [x] **Step 2: Run test to verify it fails**

Run: `rtk proxy npm run build --prefix npm/autovpn-cli && rtk proxy node --test npm/autovpn-cli/test/backend-contract.test.mjs`

Expected: FAIL because the stale `jobs resume/retry --detach` guard prevents JSON job payload creation.

- [x] **Step 3: Remove stale detached resume/retry guard**

Delete the `argv[0] === 'jobs' && (argv.includes('resume') || argv.includes('retry')) && hasFlag(argv, '--detach')` rejection and remove the now-empty helper.

- [x] **Step 4: Run target tests**

Run: `rtk proxy npm run build --prefix npm/autovpn-cli && rtk proxy node --test npm/autovpn-cli/test/backend-contract.test.mjs npm/autovpn-cli/test/jobs/job-manager.test.mjs`

Expected: PASS.

### Task 3: Documentation And Full Validation

**Files:**
- Modify: `README.md`
- Modify: `npm/autovpn-cli/README.md`

- [x] **Step 1: Update operator docs**

Document that detached job management runs in Node for `run --detach`, `jobs resume --detach`, and `jobs retry --detach`, while the spawned worker command is still Python-compatible until the worker runtime migration.

- [x] **Step 2: Run npm CLI tests**

Run: `rtk proxy npm test --prefix npm/autovpn-cli`

Expected: PASS.

- [x] **Step 3: Run Electron headless regression tests**

Run: `rtk proxy node --test electron/tests/*.test.mjs`

Expected: PASS.

- [x] **Step 4: Run Python regression tests**

Run: `rtk proxy uv run --with pytest pytest tests -q`

Expected: PASS.

- [x] **Step 5: Run package dry-run**

Run: `rtk proxy npm pack --dry-run`

Expected: PASS.

- [ ] **Step 6: PR, CI, merge, sync, cleanup, package**

Push the branch, create a PR, wait for CI, perform local review, merge, delete remote/local feature branch and worktree, then package latest main and smoke-test `autovpn --version`.

## Self-Review

- Spec coverage: The plan covers stale detached shell guards, detached run/retry compatibility, docs, tests, PR, cleanup, and packaging.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: The plan uses existing `runCliShell()`, `runNativeCommand()`, and job manager contracts unchanged.
