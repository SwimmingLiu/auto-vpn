# v3 Node Share Project Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Cloudflare Pages share-project `SUB` synchronization and share-project blocked fallback into the Node CLI deploy backend for plain deploy flows.

**Architecture:** Keep all work inside the existing Node deploy stage boundary in `npm/autovpn-cli/src/pipeline/deploy.ts`. Reuse the Node Cloudflare client added for primary blocked fallback, add share-project-specific config rewriting and redeploy helpers, and continue to reject custom-domain binding until that final v3 slice is migrated.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Cloudflare Pages REST API, Wrangler CLI via existing `runCommand`, `node:test`.

---

## File Map

- Modify `npm/autovpn-cli/src/pipeline/deploy.ts`
  - Add share worker source/bundle path helpers.
  - Add deployment config rewrite helper for `SUB`.
  - Add `syncShareProjectSub()` for normal sync, missing requested project recovery, blocked update fallback, and blocked redeploy fallback.
  - Let `deployPagesWithBackend()` allow `share_project_name` when `custom_domain` is empty.
- Modify `npm/autovpn-cli/test/pipeline/deploy.test.mjs`
  - Add Node share sync tests mirroring the Python integration tests.
  - Keep custom-domain rejection covered.
- Modify `README.md` and `npm/autovpn-cli/README.md`
  - Update the Node/Python boundary so share-project sync is no longer listed as Python-only for plain deploy flows.
- Create this plan document.

## Task 1: Add Share Sync Tests

**Files:**
- Modify: `npm/autovpn-cli/test/pipeline/deploy.test.mjs`

- [ ] **Step 1: Add a successful share sync test**

Add a test that deploys the primary project successfully, injects a fake Cloudflare deploy client, and asserts:
- `share_project_sync_ok === true`
- `share_project_name` remains requested name
- both preview and production `SUB` values are rewritten to `https://sub-nodes.pages.dev/?serect_key=swimmingliu`
- a second Wrangler deploy runs against the share bundle and requested share project.

- [ ] **Step 2: Add blocked update fallback test**

Add a test where `updatePagesProject("sub-links-share-03", ...)` throws a blocked Pages error. Assert:
- fallback `sub-links-share-04` is created
- source config is copied from requested share project to fallback
- fallback project is updated with rewritten `SUB`
- fallback share deploy succeeds
- result records `share_project_fallback_used`, `share_project_cleanup_blocked_project`, `share_project_fallback_last_used_suffix`, and `share_project_redeploy_attempts`.

- [ ] **Step 3: Add missing requested share project recovery test**

Add a test where `getPagesProject("sub-links-share-03")` throws `Cloudflare Pages project not found`. Assert the Node backend recovers latest existing `sub-links-share-05`, updates it, deploys it, and preserves `share_project_requested_name`.

- [ ] **Step 4: Run failing tests**

Run: `rtk proxy node --test npm/autovpn-cli/test/pipeline/deploy.test.mjs`

Expected before implementation: tests that expect share sync fail because Node deploy still rejects `share_project_name`.

## Task 2: Implement Share Config Rewrite and Worker Bundle

**Files:**
- Modify: `npm/autovpn-cli/src/pipeline/deploy.ts`

- [ ] **Step 1: Import `fs/promises`**

Add `mkdir`, `readFile`, and `writeFile` imports from `node:fs/promises`.

- [ ] **Step 2: Add helpers**

Implement:
- `resolveLatestExistingProjectName(baseName, existingNames)`
- `rewriteShareProjectSubValue(deploymentConfigs, envKey, subValue)`
- `buildShareProjectUpdatePayload(sourceProject, runtimeEnv, envKey, subValue)`
- `resolveShareProjectWorkerSourcePath(projectRoot, env)`
- `buildShareProjectBundleDir(projectRoot)`
- `stageShareProjectWorkerBundle(projectRoot, env)`

- [ ] **Step 3: Run helper tests**

Run: `rtk proxy node --test npm/autovpn-cli/test/pipeline/deploy.test.mjs`

Expected: share sync tests progress past the old rejection and expose remaining orchestration gaps.

## Task 3: Implement Share Sync Orchestration

**Files:**
- Modify: `npm/autovpn-cli/src/pipeline/deploy.ts`

- [ ] **Step 1: Add `syncShareProjectSub()`**

Implement Python-compatible behavior:
- No requested share project returns a successful no-op shape with empty `share_project_sub_value`.
- Build `subValue` from final `pagesProjectUrl` plus `secret_query`.
- Recover latest existing fallback share project when requested project is missing and auto fallback is enabled.
- Update requested/recovered project with rewritten deployment config.
- Redeploy share worker bundle.
- If update or redeploy is blocked and auto fallback is enabled, create fallback share project, copy project config, update fallback config, redeploy fallback, and record cleanup metadata.
- If sync fails, return `share_project_sync_ok: false` and error text.

- [ ] **Step 2: Wire into `deployPagesWithBackend()`**

Allow `share_project_name` when no custom domain is configured. After primary deploy succeeds, call `syncShareProjectSub()` and make the final deploy result fail with `returncode: 1` plus appended stderr when sync fails.

- [ ] **Step 3: Run deploy tests**

Run: `rtk proxy node --test npm/autovpn-cli/test/pipeline/deploy.test.mjs`

Expected: all deploy tests pass.

## Task 4: Documentation and Validation

**Files:**
- Modify: `README.md`
- Modify: `npm/autovpn-cli/README.md`

- [ ] **Step 1: Update docs**

State that Node deploy supports plain Wrangler deploy, primary blocked fallback, share-project `SUB` sync, share-project fallback, and verify. Keep custom-domain binding as Python-only.

- [ ] **Step 2: Run full validation**

Run sequentially:
- `rtk proxy npm test --prefix npm/autovpn-cli`
- `rtk proxy node --test electron/tests/*.test.mjs`
- `rtk proxy uv run --with pytest pytest tests -q`
- `rtk proxy npm pack --dry-run`

- [ ] **Step 3: Commit**

Commit message: `feat: add node share project sync`

## Self-Review

- Spec coverage: The plan covers normal share sync, missing requested share project recovery, blocked update fallback, blocked redeploy fallback, metadata parity, docs, and full validation.
- Placeholder scan: No TBD placeholders remain.
- Type consistency: Helper and result field names match the existing Python and Node deploy result shapes.
