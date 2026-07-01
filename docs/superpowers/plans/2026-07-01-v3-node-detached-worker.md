# v3 Node Detached Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AUTOVPN_BACKEND=node autovpn run --detach` spawn the Node CLI worker instead of requiring the compatible Python CLI worker.

**Architecture:** Keep the existing Node job manager and job metadata format. Only change `startDetachedRun()` worker resolution: default production detached runs still use the compatible Python CLI, while `AUTOVPN_BACKEND=node` run workers execute `process.execPath bin/autovpn.mjs ...` so the child process enters the Node backend path. Detached resume/retry workers remain Python-compatible until non-detached `resume` and `retry-stage` are migrated.

**Tech Stack:** Node.js ESM, TypeScript, `node:test`, existing AutoVPN npm CLI job manager.

---

### Task 1: Add Node Worker Contract For Detached Run

**Files:**
- Modify: `npm/autovpn-cli/test/jobs/job-manager.test.mjs`
- Modify: `npm/autovpn-cli/test/backend-contract.test.mjs`

- [x] **Step 1: Write the failing test**

Add a job-manager test proving `AUTOVPN_BACKEND=node run --detach` spawns the Node executable and package `bin/autovpn.mjs`:

```js
test('AUTOVPN_BACKEND=node run --detach spawns the Node CLI worker', async () => {
  const projectRoot = await createProject();
  const spawns = [];
  const io = createIo();

  const code = await runCliShell(['run', '--project-root', projectRoot, '--skip-deploy', '--skip-verify', '--detach', '--json'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    env: runtimeEnv({ AUTOVPN_BACKEND: 'node', AUTOVPN_PYTHON_CLI: '/venv/bin/autovpn' }),
    io,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        throw new Error('detached run should not be forwarded to backend.executeCli');
      }
    }),
    runForwarder: async () => {
      throw new Error('detached run should not use direct forwarder');
    },
    spawn: fakeSpawn(spawns, 6789),
    now: () => '2026-06-28T00:01:00+00:00',
    jobId: () => '20260628-000100-node-worker'
  });

  const payload = JSON.parse(io.stdout);
  assert.equal(code, 0);
  assert.equal(spawns[0].command, process.execPath);
  assert.match(spawns[0].args[0], /bin[\\/]autovpn\.mjs$/);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `rtk proxy npm run build --prefix npm/autovpn-cli && rtk proxy node --test npm/autovpn-cli/test/jobs/job-manager.test.mjs`

Expected: FAIL because current code still spawns `/venv/bin/autovpn`.

- [x] **Step 3: Update backend-contract expectation**

Change the existing `Node backend allows detached run through the Node job manager` assertion to expect `process.execPath` plus `bin/autovpn.mjs` when `AUTOVPN_BACKEND=node`.

### Task 2: Resolve Node CLI Worker In startDetachedRun

**Files:**
- Modify: `npm/autovpn-cli/src/jobs/commands.ts`

- [x] **Step 1: Add Node worker resolver**

Add helpers:

```ts
function defaultResolveNodeCli(): ResolvedWorkerCli {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return { command: process.execPath, args: [path.join(packageRoot, 'bin', 'autovpn.mjs')] };
}

function wantsNodeWorker(env: NodeJS.ProcessEnv): boolean {
  return String(env.AUTOVPN_BACKEND ?? '').trim().toLowerCase() === 'node';
}
```

- [x] **Step 2: Use Node worker only for detached run**

Change `startDetachedRun()` to call `resolveDetachedRunWorker()`, returning Node CLI when `AUTOVPN_BACKEND=node` and Python CLI otherwise. Leave `startDetachedResume()` and `startDetachedRetry()` on `defaultResolvePythonCli()`.

- [x] **Step 3: Run target tests**

Run: `rtk proxy npm run build --prefix npm/autovpn-cli && rtk proxy node --test npm/autovpn-cli/test/jobs/job-manager.test.mjs npm/autovpn-cli/test/backend-contract.test.mjs`

Expected: PASS.

### Task 3: Docs And Full Validation

**Files:**
- Modify: `README.md`
- Modify: `npm/autovpn-cli/README.md`

- [x] **Step 1: Update docs**

Document that `AUTOVPN_BACKEND=node run --detach` uses the Node CLI worker and detached resume/retry workers remain Python-compatible until those runtimes are migrated.

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

- Spec coverage: This plan moves detached run worker execution to Node under `AUTOVPN_BACKEND=node`, keeps default production compatibility, records docs, tests, PR, cleanup, and packaging.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: `ResolvedWorkerCli` mirrors the existing resolved CLI shape and `startDetachedRun()` keeps the existing job metadata contract.
