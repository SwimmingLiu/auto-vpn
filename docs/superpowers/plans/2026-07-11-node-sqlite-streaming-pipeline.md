# Node SQLite Streaming Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Node pipeline state in a run-local SQLite database and stream every unique extracted node immediately through speed testing and availability checks.

**Architecture:** Add a `RunStore` around Node's built-in SQLite API and a bounded asynchronous worker pool. Refactor the Node orchestrator so extractor callbacks atomically persist/dedupe nodes and submit them to the speed pool, whose passing results feed the availability pool; retain legacy artifact files as SQLite projections and retain serial downstream stages.

**Tech Stack:** TypeScript, Node.js 24 `node:sqlite`, `node:test`, existing Electron/Playwright test harness.

---

### Task 1: Run-local SQLite store

**Files:**
- Create: `npm/autovpn-cli/src/pipeline/run-store.ts`
- Create: `npm/autovpn-cli/test/pipeline/run-store.test.mjs`

- [ ] **Step 1: Write failing schema and canonical dedupe tests**

Create tests that open a temporary `run.db`, initialize `RunStore`, insert two equivalent vmess links from different sources, and assert that only the first insert returns a new node. Query through the public API, not direct implementation fields:

```js
const first = store.recordExtractedNode('alpha', vmessLink('first', 'same.example'));
const duplicate = store.recordExtractedNode('beta', vmessLink('renamed', 'same.example'));
assert.equal(first.inserted, true);
assert.equal(duplicate.inserted, false);
assert.deepEqual(store.rawLinks(), [first.link, duplicate.link]);
assert.deepEqual(store.dedupedLinks(), [first.link]);
```

Also assert that `run.db` contains `runs`, `stage_events`, `source_progress`, and `pipeline_nodes`, so existing `NodeBackend` and job reconciliation queries remain valid.

- [ ] **Step 2: Run the test and verify RED**

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test npm/autovpn-cli/test/pipeline/run-store.test.mjs`

Expected: failure because `dist/pipeline/run-store.js` does not exist.

- [ ] **Step 3: Implement the schema and insert/query API**

Implement `RunStore.open(path)`, `close()`, `initializeRun()`, `setRunStatus()`, `setStageStatus()`, `recordSourceProgress()`, and `recordExtractedNode()`. Use `createRequire(import.meta.url)` to load `node:sqlite`, prepared statements, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, and `PRAGMA busy_timeout=5000`. Allocate discovery sequence and canonical insert inside one SQLite transaction. Store every raw observation separately so `rawLinks()` preserves duplicates while `pipeline_nodes.canonical_key` remains unique.

Expose typed query methods for raw nodes, unique nodes, speed results, availability results, and counts. Keep canonicalization inside this module using existing vmess parsing helpers.

- [ ] **Step 4: Add transition and deterministic export tests**

Write tests that call:

```js
store.markSpeedRunning(node.id);
store.recordProbe(node.id, { reachable: true, latency_ms: 12, error: '' });
store.recordSpeedResult(node.id, { link: node.link, reachable: true, average_download_mb_s: 3, latency_ms: 12, error: '' }, true);
store.markAvailabilityRunning(node.id);
store.recordAvailabilityResult(node.id, { link: node.link, all_passed: true, provider_results: {} });
```

Assert monotonic state, discovery order, JSON roundtrip, counts, stage rows, and final run status. Assert interrupted running rows can be reset and listed for resume.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test npm/autovpn-cli/test/pipeline/run-store.test.mjs`

Expected: all RunStore tests pass with no warnings except Node's documented experimental SQLite warning if emitted by the runtime.

- [ ] **Step 6: Commit**

Run: `rtk git add npm/autovpn-cli/src/pipeline/run-store.ts npm/autovpn-cli/test/pipeline/run-store.test.mjs && rtk git commit -m "feat: persist pipeline state in sqlite"`

### Task 2: Bounded streaming worker pool

**Files:**
- Create: `npm/autovpn-cli/src/pipeline/streaming-coordinator.ts`
- Create: `npm/autovpn-cli/test/pipeline/streaming-coordinator.test.mjs`

- [ ] **Step 1: Write failing concurrency and backpressure tests**

Use deferred promises to submit six jobs to a pool with `concurrency: 2` and `capacity: 2`. Assert only two jobs execute, two wait in the internal pending queue, and the fifth `submit()` remains pending until capacity is released. Assert `close()` rejects later submissions and `drain()` waits for all accepted work.

- [ ] **Step 2: Run and verify RED**

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test npm/autovpn-cli/test/pipeline/streaming-coordinator.test.mjs`

Expected: failure because the coordinator module does not exist.

- [ ] **Step 3: Implement `BoundedWorkerPool`**

Implement a generic pool with this public contract:

```ts
export class BoundedWorkerPool<T> {
  constructor(options: { concurrency: number; capacity: number; worker: (item: T) => Promise<void> });
  submit(item: T): Promise<void>;
  close(): void;
  drain(): Promise<void>;
  abort(error: unknown): void;
}
```

`submit()` resolves when the item is admitted, not when processing completes. It awaits capacity when `active + queued` reaches `concurrency + capacity`. `drain()` rejects with the first infrastructure failure after all active workers settle. Do not treat expected per-node network outcomes as pool failures; those are returned by worker callbacks and persisted by the orchestrator.

- [ ] **Step 4: Add abort/failure tests and verify GREEN**

Assert first-error propagation, no new work after abort, capacity waiters reject, and active tasks settle without unhandled rejections.

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test npm/autovpn-cli/test/pipeline/streaming-coordinator.test.mjs`

Expected: all coordinator tests pass.

- [ ] **Step 5: Commit**

Run: `rtk git add npm/autovpn-cli/src/pipeline/streaming-coordinator.ts npm/autovpn-cli/test/pipeline/streaming-coordinator.test.mjs && rtk git commit -m "feat: add bounded pipeline worker pools"`

### Task 3: Stream extract through speedtest and availability

**Files:**
- Modify: `npm/autovpn-cli/src/pipeline/orchestrator.ts`
- Modify: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`

- [ ] **Step 1: Replace the old non-overlap assertion with a failing cross-stage overlap test**

Change the existing `does not claim speedtest or availability are running during extraction` test into a behavioral test. The extractor emits one node through `stream.onLinks()`, then waits on a deferred promise. Resolve that promise only after the speed worker and availability worker have observed the node. Assert both observations happen before extraction completes and assert the four running stage events precede `extract=success`.

- [ ] **Step 2: Add a failing no-global-wait test**

Emit a slow first source and a still-blocked second source. Assert the first link is probed and fully speed tested without waiting for either source result object. Configure `max_download_candidates = 1`, emit two unique nodes over time, and assert both are tested to prove pipeline mode no longer uses global candidate selection.

- [ ] **Step 3: Run the two tests and verify RED**

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test --test-name-pattern="streams extraction|does not globally rank" npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`

Expected: timeout or ordering assertion failure because speedtest currently starts after `Promise.all(sources)`.

- [ ] **Step 4: Wire RunStore and worker pools into `runNodePipeline()`**

Initialize `run.db` immediately after allocating the artifact directory. Mark `extract`, `dedupe`, `speedtest`, and `availability` running before launching extractors. In every `onLinks` callback:

```ts
const record = store.recordExtractedNode(sourceName, link);
if (record.inserted) {
  await speedPool.submit(record.node);
}
```

The speed worker calls `probeSpeedtestLinksInNode()` with one link, persists the probe, and calls `testSpeedtestLinkInNode()` immediately when reachable. A passing full result is submitted to the availability pool. The availability worker checks one speed result and persists its provider result. Injected test stage overrides continue to work.

Remove pipeline-mode use of `selectSpeedtestCandidates()` and the batch barrier. Keep the exported helper for compatibility with direct module tests if still used elsewhere. Close/drain pools in dependency order after every extractor settles.

- [ ] **Step 5: Generate compatibility artifacts from SQLite**

Add a focused orchestrator helper that queries RunStore and writes all existing raw, deduped, speed, and availability text/JSON files in discovery order. Call it at stage boundaries, run success, and run failure. Populate summary counts from SQLite rather than mutable arrays.

- [ ] **Step 6: Run focused overlap and existing orchestrator tests**

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`

Expected: every orchestrator test passes. Update assertions only where the approved semantics changed: overlapping stage order, dynamic progress totals, and removal of global candidate selection.

- [ ] **Step 7: Commit**

Run: `rtk git add npm/autovpn-cli/src/pipeline/orchestrator.ts npm/autovpn-cli/test/pipeline/orchestrator.test.mjs && rtk git commit -m "feat: stream extracted nodes across pipeline stages"`

### Task 4: SQLite-backed resume, retry, and job reconciliation

**Files:**
- Modify: `npm/autovpn-cli/src/pipeline/run-store.ts`
- Modify: `npm/autovpn-cli/src/pipeline/orchestrator.ts`
- Modify: `npm/autovpn-cli/src/backend/node-backend.ts`
- Modify: `npm/autovpn-cli/src/jobs/read.ts`
- Modify: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`
- Modify: `npm/autovpn-cli/test/backend-contract.test.mjs`
- Modify: `npm/autovpn-cli/test/jobs/job-manager.test.mjs`

- [ ] **Step 1: Write failing interrupted-run resume tests**

Create a run database containing one `speed_passed`, one interrupted `speed_running`, and one `availability_running` node. Resume pipeline and assert completed work is not repeated, interrupted states are reset and scheduled, availability resumes for both speed-passed nodes, and final artifacts contain each node once.

- [ ] **Step 2: Write failing legacy import and retry tests**

Create an old artifact directory with text/JSON artifacts but no database. Invoke resume and retry-stage. Assert `run.db` is created, data is imported in artifact order, and processing continues from the requested boundary.

- [ ] **Step 3: Run and verify RED**

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test --test-name-pattern="SQLite resume|legacy artifact import|retry seeds SQLite" npm/autovpn-cli/test/pipeline/orchestrator.test.mjs npm/autovpn-cli/test/backend-contract.test.mjs npm/autovpn-cli/test/jobs/job-manager.test.mjs`

Expected: failures because resume currently reads artifact files/event logs and new runs do not expose the required SQLite state.

- [ ] **Step 4: Implement database-first resume and compatibility import**

Add `RunStore.openOrImport(artifactDir)` that opens a current database or imports legacy artifacts. Reset interrupted states transactionally. Refactor pipeline and speedtest resume to schedule incomplete SQLite rows through the same worker logic used by foreground runs. Seed retry databases from the source store, filtering/resetting states at the requested retry boundary.

- [ ] **Step 5: Align backend/job readers with the concrete schema**

Keep `runs(status)` and `stage_events(stage_name,status)` compatible with existing queries. Replace duplicate raw SQLite access in `node-backend.ts` and `jobs/read.ts` with exported `readRunStatus()` and `readLatestStageStatuses()` RunStore helpers. Verify completed/failed/stopped reconciliation and `--resume-latest` selection.

- [ ] **Step 6: Run affected suites and verify GREEN**

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test npm/autovpn-cli/test/pipeline/orchestrator.test.mjs npm/autovpn-cli/test/backend-contract.test.mjs npm/autovpn-cli/test/jobs/job-manager.test.mjs`

Expected: all affected tests pass.

- [ ] **Step 7: Commit**

Run: `rtk git add npm/autovpn-cli/src/pipeline/run-store.ts npm/autovpn-cli/src/pipeline/orchestrator.ts npm/autovpn-cli/src/backend/node-backend.ts npm/autovpn-cli/src/jobs/read.ts npm/autovpn-cli/test/pipeline/orchestrator.test.mjs npm/autovpn-cli/test/backend-contract.test.mjs npm/autovpn-cli/test/jobs/job-manager.test.mjs && rtk git commit -m "feat: resume streaming runs from sqlite"`

### Task 5: User-facing progress compatibility and documentation

**Files:**
- Modify: `npm/autovpn-cli/README.md`
- Modify: `docs/headless-agent/headless-cli.md`
- Modify: `electron/renderer/app.js`
- Modify: `electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Add a failing renderer event-order test**

Feed stage events where extract, dedupe, speedtest, and availability are all running and progress totals grow as links are discovered. Assert the dashboard shows all active stages without regressing counts or treating an increasing total as a reset.

- [ ] **Step 2: Run renderer test and verify RED or existing compatibility**

Run: `rtk npm run build:autovpn-cli && rtk node --test --test-name-pattern="overlapping streaming stages" electron/tests/renderer-e2e.test.mjs`

Expected: fail until the test exists; after adding it, either a behavioral assertion fails and requires the minimal renderer fix, or it passes and proves no production UI change is necessary.

- [ ] **Step 3: Apply only the minimal renderer compatibility change if RED identified one**

Keep the existing Chinese UI and stage names. Do not add promotional copy. Make stage state and dynamic totals monotonic.

- [ ] **Step 4: Document persistence and changed speed selection semantics**

Document `run.db` as the authoritative per-run store, legacy artifact exports, immediate per-node processing, bounded concurrency, resume behavior, and the removal of global `max_download_candidates` ranking from pipeline mode.

- [ ] **Step 5: Run affected tests and commit**

Run: `rtk npm run build:autovpn-cli && rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: renderer E2E passes.

Commit the files with: `rtk git commit -m "docs: explain sqlite streaming runs"` after staging only changed documentation and any necessary renderer/test files.

### Task 6: Full verification, PR, review, merge, and packaging

**Files:**
- Modify only files required by review feedback or verified test failures.

- [ ] **Step 1: Run the complete npm CLI and Electron unit suites**

Run: `rtk npm test --prefix npm/autovpn-cli`

Run: `rtk npm run test:electron`

Expected: all tests pass.

- [ ] **Step 2: Run H5 browser E2E and manual browser verification first**

Run: `rtk node --test electron/tests/web-server-e2e.test.mjs`

Then launch the same `createAutoVpnServer()` fixture through a temporary one-shot Node command, open its printed local origin with Playwright/Computer Use, manually exercise one mocked streaming run, and confirm concurrent stage states, increasing counts, terminal summary, and no console errors. Stop the fixture process after the check.

- [ ] **Step 3: Run Electron E2E and pixel-level visual verification**

Run: `rtk node --test electron/tests/web-server-e2e.test.mjs electron/tests/web-server-visual.test.mjs electron/tests/renderer-e2e.test.mjs electron/tests/renderer-visual.test.mjs electron/tests/app-launch.test.mjs`

Expected: all E2E and visual tests pass with unchanged or intentionally reviewed baselines.

- [ ] **Step 4: Verify diff and create PR**

Run `rtk git diff --check`, inspect `rtk git status --short`, push `codex/sqlite-streaming-pipeline`, and open a ready GitHub PR describing the root cause, SQLite decision, changed candidate semantics, tests, and compatibility behavior.

- [ ] **Step 5: Perform code review and address every actionable finding**

Review concurrency, backpressure, SQLite transitions, resource closure, error redaction, resume idempotency, and artifact compatibility. If any file changes, rerun the H5 browser/manual round first, complete unit tests, E2E tests, visual checks, and update the PR.

- [ ] **Step 6: Merge only after required checks and review resolution**

Confirm the PR is mergeable, all checks pass, and no unresolved actionable review threads remain. Merge the PR into `main`.

- [ ] **Step 7: Package the merged application and verify branding**

On updated `main`, run `rtk npm run package:electron`. Verify `packaging.log` does not contain `default Electron icon is used`, verify the package contains the icon derived from `electron/renderer/assets/vpn-auto-logo-v2-minimal.svg`, and verify the produced app/installable package launches.
