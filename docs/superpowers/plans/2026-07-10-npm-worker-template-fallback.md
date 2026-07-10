# npm Worker Template Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clean global npm installs render, deploy, and verify without requiring a repository checkout.

**Architecture:** A focused runtime helper resolves the project override first and the npm-bundled Worker template second. Pipeline and doctor consumers share that helper, while packaging tests enforce that the fallback asset ships and remains synchronized with the canonical repository template.

**Tech Stack:** Node.js 22, TypeScript, node:test, npm pack, SSH integration testing.

---

### Task 1: Lock Template Resolution Behavior

**Files:**
- Create: `npm/autovpn-cli/test/runtime/templates.test.mjs`
- Create: `npm/autovpn-cli/src/runtime/templates.ts`
- Modify: `npm/autovpn-cli/test/parity/low-risk-commands.test.mjs`

- [ ] **Step 0: Repair the inherited parity fixture**

Add the already-generated `postprocess_links` count to the Python/Node parity fixture so both implementations compare the same complete report shape. The existing failing parity test is the regression proof.

- [ ] **Step 1: Write failing tests**

Add tests that import `resolveWorkerTemplatePath`, assert a project-local template wins, and assert a project without templates resolves to the package-owned template.

- [ ] **Step 2: Verify RED**

Run `rtk npm run build && rtk node --test test/runtime/templates.test.mjs` from `npm/autovpn-cli`. Expect failure because `dist/runtime/templates.js` does not exist.

- [ ] **Step 3: Implement the resolver**

Use `fileURLToPath(import.meta.url)` to locate the npm package root from both `src` and compiled `dist`, test the project candidate first, and return the packaged candidate second. Throw an error listing both paths if neither exists.

- [ ] **Step 4: Verify GREEN**

Rerun the focused test and expect all cases to pass.

### Task 2: Route Pipeline and Doctor Through the Resolver

**Files:**
- Modify: `npm/autovpn-cli/src/pipeline/orchestrator.ts`
- Modify: `npm/autovpn-cli/src/doctor/checks.ts`
- Modify: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`
- Modify: `npm/autovpn-cli/test/doctor/checks.test.mjs`

- [ ] **Step 1: Write failing integration tests**

Remove the project template in a pipeline fixture and assert render succeeds with the bundled fallback. Remove it in a doctor fixture and assert `worker_template` passes while reporting the bundled path.

- [ ] **Step 2: Verify RED**

Run the two focused suites. Expect the pipeline to fail with `ENOENT` and doctor to report `worker_template=fail`.

- [ ] **Step 3: Replace hard-coded reads**

Resolve the Worker template once through the shared helper in run, retry, resume, and doctor paths. Preserve project override precedence.

- [ ] **Step 4: Verify GREEN**

Rerun both focused suites and expect all tests to pass.

### Task 3: Ship and Audit the Template

**Files:**
- Create: `npm/autovpn-cli/templates/vmess_node.js`
- Modify: `npm/autovpn-cli/package.json`
- Create: `npm/autovpn-cli/test/package-contents.test.mjs`

- [ ] **Step 1: Write a failing package-content test**

Assert the npm-owned template equals the canonical root template and `package.json.files` includes `templates/`.

- [ ] **Step 2: Verify RED**

Run the focused test and expect failure because the npm template and allowlist entry are absent.

- [ ] **Step 3: Add the package asset**

Copy the canonical template into the npm package and add `templates/` to the package files allowlist.

- [ ] **Step 4: Verify GREEN and inspect tarball**

Run the focused test and `rtk npm pack --dry-run --json`; assert `templates/vmess_node.js` appears in the manifest.

### Task 4: Validate on the SSH Server Without Publishing

**Files:**
- Generated outside git: local npm `.tgz`

- [ ] **Step 1: Run repository verification**

Run npm unit tests, root unit tests, Electron H5/e2e tests, and visual regression checks required by `AGENTS.md`.

- [ ] **Step 2: Pack and upload the exact candidate**

Create a local npm tarball, calculate its SHA-256, upload it over SSH, and verify the remote checksum matches.

- [ ] **Step 3: Install candidate and restart the service**

Install the tarball globally with the server's Node 22 npm, restart the existing tmux service, and confirm its authenticated health boundary responds without exposing credentials.

- [ ] **Step 4: Retry from render through verify**

Run `autovpn retry-stage --artifact-dir /home/lighthouse/.auto-vpn/artifacts/20260710-130540 --stage render` using the existing server profile. Confirm render, obfuscate, deploy, and verify are successful and summarize only stage statuses/counts.

### Task 5: Review, Release, and Reconfirm Production Install

**Files:**
- Modify version metadata and release documentation discovered by the repository release workflow.

- [ ] **Step 1: Update to v1.6.6**

Synchronize root, npm, Python, Electron renderer, lockfiles, tests, and release documentation using the established release scripts and assertions.

- [ ] **Step 2: Repeat all verification**

Rerun all tests, package inspection, H5/manual browser verification, end-to-end checks, and visual regression after the version edits.

- [ ] **Step 3: Open PR and review**

Push a `codex/` branch, open a PR, complete code review, address all findings, and rerun required verification after any behavior change.

- [ ] **Step 4: Merge and release**

Merge only after checks and review pass, publish `v1.6.6` through the established release workflow, and verify npm and GitHub release assets.

- [ ] **Step 5: Reinstall from npm and smoke test**

Replace the server's local tarball with `@swimmingliu/autovpn@1.6.6`, restart the service, verify the installed version, and confirm the server remains healthy.
