# Node-only Electron and Speedtest Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every runnable Python core path, make Electron use the packaged Node CLI with live global dedupe events, and make Node speed testing resilient without weakening quality gates.

**Architecture:** Electron spawns the same Node CLI used by the web server and npm package, with a small command mapper and buffered NDJSON decoder. The Node orchestrator owns a single probe/rank/download flow, while packaging and CI ship/test only Node artifacts.

**Tech Stack:** Node.js 24, TypeScript, Electron 37, node:test, Playwright, SQLite, electron-builder

---

### Task 1: Electron Node CLI adapter and stream-safe events

**Files:**
- Modify: `electron/lib/backend.js`
- Modify: `electron/ipc.js`
- Modify: `electron/tests/backend.test.mjs`
- Modify: `electron/tests/process-lifecycle.test.mjs`

- [ ] **Step 1: Write failing tests for Node command mapping**

Assert development and packaged invocations resolve the npm CLI entry, translate `profile-save` to `profile save`, translate artifact commands, append `--output jsonl` to streaming commands, and set `ELECTRON_RUN_AS_NODE=1` only for the Electron executable.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `rtk node --test electron/tests/backend.test.mjs`

Expected: failures still show `python -m vpn_automation.backend`.

- [ ] **Step 3: Write failing fragmented-NDJSON tests**

Feed `{"type":"stage"` and `,"stage":"extract","status":"running"}\n` in separate chunks, followed by two events in one chunk; assert exactly three parsed events and no fake log fragments.

- [ ] **Step 4: Implement the Node invocation and decoder**

Expose focused helpers from `electron/lib/backend.js`: `resolveNodeCliEntry`, `buildBackendInvocation`, `buildBackendEnv`, and `createNdjsonDecoder`. Update both run and retry stdout handlers to use one decoder instance and flush it on close.

- [ ] **Step 5: Run focused tests**

Run: `rtk node --test electron/tests/backend.test.mjs electron/tests/process-lifecycle.test.mjs`

Expected: all pass.

- [ ] **Step 6: Commit**

Run: `rtk git add electron/lib/backend.js electron/ipc.js electron/tests/backend.test.mjs electron/tests/process-lifecycle.test.mjs && rtk git commit -m "feat(electron): run the Node backend"`

### Task 2: Live canonical dedupe parity

**Files:**
- Modify: `electron/renderer/app.js`
- Modify: `electron/tests/renderer-e2e.test.mjs`
- Modify: `npm/autovpn-cli/test/pipeline/extract.test.mjs`

- [ ] **Step 1: Write a failing H5 test**

Emit extract events from two sources whose nodes have different display names but identical canonical connection fields. Assert the dashboard raw count becomes 2 while `deduped_links` stays 1 before any summary event.

- [ ] **Step 2: Verify the test fails**

Run: `rtk node --test --test-name-pattern="live canonical dedupe" electron/tests/renderer-e2e.test.mjs`

Expected: dedupe count reports 2 or does not update.

- [ ] **Step 3: Align renderer event handling**

Require `new_item_fingerprints` for global live counts, preserve per-source local counts, and never fall back to summing raw counts once a run has started receiving canonical fingerprints.

- [ ] **Step 4: Verify Node extract fingerprints and H5 behavior**

Run: `rtk npm test --prefix npm/autovpn-cli -- --test-name-pattern="fingerprint"` and the focused renderer test.

Expected: all pass and no node URI appears in event fingerprints.

- [ ] **Step 5: Commit**

Run: `rtk git add electron/renderer/app.js electron/tests/renderer-e2e.test.mjs npm/autovpn-cli/test/pipeline/extract.test.mjs && rtk git commit -m "fix(electron): update dedupe counts live"`

### Task 3: Unify and harden Node speed testing

**Files:**
- Modify: `npm/autovpn-cli/src/pipeline/speedtest.ts`
- Modify: `npm/autovpn-cli/src/pipeline/orchestrator.ts`
- Modify: `npm/autovpn-cli/test/pipeline/speedtest.test.mjs`
- Modify: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`
- Modify: `electron/runtime/bundled-profile.toml`
- Modify: `electron/runtime/default-profile.toml`

- [ ] **Step 1: Write failing retry and fallback tests**

Test a probe sequence `502 -> 204`, a permanent 502, a primary download error followed by alternate success, and all downloads failing. Assert bounded attempts, accurate error classification, and no threshold relaxation.

- [ ] **Step 2: Verify failures**

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test --test-name-pattern="retry|alternate" npm/autovpn-cli/test/pipeline/speedtest.test.mjs`

Expected: retry/fallback assertions fail against the single-shot implementation.

- [ ] **Step 3: Implement bounded probe retry**

Add a small retry helper limited to transient HTTP 5xx, timeout, reset and fetch/socket failures. Emit one final probe result per node and keep individual attempt details redacted in logs.

- [ ] **Step 4: Write failing foreground candidate tests**

Run a streaming extract with three nodes, controlled latencies and `max_download_candidates=2`; assert all three are probed, only the two fastest are downloaded, and `speedtest_selected` reports 3 reachable / 2 candidates.

- [ ] **Step 5: Refactor orchestrator to one two-phase flow**

Collect canonical nodes during extraction, then call the shared probe/rank/download implementation. Preserve live probe/download events and artifact schema; remove the per-link full-download shortcut.

- [ ] **Step 6: Add a second default download endpoint**

Use HTTPS probe and two independent HTTPS download endpoints in the bundled/example profile. Aggregate successful samples only; a node remains failed if no endpoint succeeds.

- [ ] **Step 7: Run focused Node tests**

Run: `rtk npm run build --prefix npm/autovpn-cli && rtk node --test npm/autovpn-cli/test/pipeline/speedtest.test.mjs npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`

Expected: all pass.

- [ ] **Step 8: Commit**

Run: `rtk git add npm/autovpn-cli/src/pipeline/speedtest.ts npm/autovpn-cli/src/pipeline/orchestrator.ts npm/autovpn-cli/test/pipeline/speedtest.test.mjs npm/autovpn-cli/test/pipeline/orchestrator.test.mjs electron/runtime/bundled-profile.toml electron/runtime/default-profile.toml && rtk git commit -m "fix(speedtest): retry probes and rank candidates"`

### Task 4: Remove the Python core and compatibility surface

**Files:**
- Delete: `src/vpn_automation/**`
- Delete: `tests/**`
- Delete: `pyproject.toml`
- Delete: Python-only files under `scripts/`
- Delete: `npm/autovpn-cli/src/backend/python-backend.ts`
- Delete: `npm/autovpn-cli/lib/install-python-cli.mjs`
- Modify: all `npm/autovpn-cli/src/pipeline/*.ts` files containing Python helpers
- Modify: `npm/autovpn-cli/src/backend/select-backend.ts`
- Modify: `npm/autovpn-cli/src/backend/types.ts`
- Modify: relevant npm tests

- [ ] **Step 1: Add a Node-only boundary test**

Scan active source, scripts, manifests and workflows for `vpn_automation`, Python subprocess helpers, Python backend selectors, `pyproject.toml`, pytest, pip, wheel and PyPI publishing. Allow historical design documents only.

- [ ] **Step 2: Verify the boundary test fails**

Run the new Node-only boundary test and confirm it lists the existing runtime paths.

- [ ] **Step 3: Remove Python backend files and adapters**

Delete the Python package/tests/manifests/scripts. Collapse stage backend selectors and APIs to Node-only implementations, removing embedded helper strings and Python injection options instead of leaving dead compatibility branches.

- [ ] **Step 4: Update Node tests**

Delete parity-to-Python tests. Replace tests of rejected Python flags with one stable Node-only configuration test; keep behavior tests for every public command and stage.

- [ ] **Step 5: Run npm CLI tests and the boundary test**

Run: `rtk npm test --prefix npm/autovpn-cli`

Expected: all pass; boundary scan reports no active Python core path.

- [ ] **Step 6: Commit**

Run: `rtk git add -A && rtk git commit -m "refactor: remove the Python core"`

### Task 5: Node-only packaging, CI and documentation

**Files:**
- Modify: `package.json`
- Modify: `electron/build/package.mjs`
- Modify: `electron/paths.js`
- Modify: `electron/tests/package-build.test.mjs`
- Modify: `electron/tests/release-docs-workflow.test.mjs`
- Modify: `.github/workflows/headless-cli.yml`
- Modify: `.github/workflows/release-electron.yml`
- Modify: `README.md`
- Modify: active docs under `docs/headless-agent/` and `docs/npm-cli/`

- [ ] **Step 1: Write failing package-content tests**

Assert Electron package inputs include the built npm CLI and exclude `src`, `pyproject.toml`, Python vendor and Python dependency installation. Assert release workflow has no PyPI build/upload job.

- [ ] **Step 2: Verify failures**

Run: `rtk node --test electron/tests/package-build.test.mjs electron/tests/release-docs-workflow.test.mjs`

Expected: current Python packaging assertions conflict with Node-only requirements.

- [ ] **Step 3: Stage the npm CLI for Electron**

Build `npm/autovpn-cli`, include its `bin`, `dist`, `lib`, `package.json` and required Node dependencies in the Electron app, and remove all Python vendor preparation and package file entries.

- [ ] **Step 4: Simplify CI and release**

Remove setup-python, pip/pytest, wheel/sdist and PyPI jobs. Keep Node CLI, Electron platform builds, icons, release notes and npm publication. Replace JSON validation snippets with Node.

- [ ] **Step 5: Update user documentation**

Document Node 22+ only, remove Python installation/fallback instructions, and describe probe/download diagnostics without exposing secrets.

- [ ] **Step 6: Run package/workflow tests**

Run: `rtk node --test electron/tests/package-build.test.mjs electron/tests/release-docs-workflow.test.mjs`

Expected: all pass.

- [ ] **Step 7: Commit**

Run: `rtk git add package.json electron .github README.md docs/headless-agent docs/npm-cli && rtk git commit -m "build: ship AutoVPN with Node only"`

### Task 6: Full behavioral and release verification

**Files:**
- Update visual baselines only if deterministic UI output intentionally changes.

- [ ] **Step 1: Build and run all Node tests**

Run: `rtk npm test --prefix npm/autovpn-cli` and `rtk npm run test:electron`.

Expected: zero failures, with only documented platform skips.

- [ ] **Step 2: Test H5 first and perform one manual browser round**

Run the served renderer Playwright suite, open the H5 renderer, emit or run a two-source extraction, and visually confirm raw/deduped counts update independently with no console errors.

- [ ] **Step 3: Run Electron native e2e and visual regression**

Launch the actual Electron app, execute the renderer e2e suite, and compare desktop/mobile visual hashes. Confirm version text and layout remain unchanged.

- [ ] **Step 4: Run a safe end-to-end pipeline**

Use a temporary runtime root and `--skip-deploy --skip-verify`. Confirm extract, global dedupe, probe selection, download, availability and reports complete on Node without any Python executable present in `PATH`.

- [ ] **Step 5: Package and inspect the app**

Run `rtk npm run package:electron`. Confirm no default Electron icon warning, project-derived transparent icons exist, the npm CLI is included, and no Python source/vendor/manifest is present.

- [ ] **Step 6: Request independent code review**

Review the full diff from `2ae2973` to HEAD against the design, fix all Critical and Important findings, and repeat every affected test after any change.

- [ ] **Step 7: Open PR, pass checks, merge and package main**

Push `codex/node-only-electron-speedtest`, open a ready PR, wait for required checks, merge only after review resolution, update local main, and package the merged commit.
