### Task 7: CI Gates, Documentation, Full Verification, and Release Handoff

**Files:**
- Modify: `.github/workflows/ci.yml` or the repository's PR workflow that owns renderer verification
- Modify: `.github/workflows/release-electron.yml`
- Modify: `electron/tests/release-docs-workflow.test.mjs`
- Modify: `DESIGN.md`
- Create: `docs/mobile-ux.md`

**Interfaces:**
- Produces: CI jobs that run mobile Chromium/WebKit E2E and visual tests before merge and release.
- Consumes: complete test matrix from Task 6.

- [ ] **Step 1: Add failing workflow contract tests**

Require PR and release workflows to install pinned Playwright Chromium/WebKit runtimes, run mobile layout/E2E/visual tests, and upload visual diffs on failure. Remove assertions that intentionally exclude these suites.

- [ ] **Step 2: Run workflow tests and verify failure**

Run: `rtk node --test electron/tests/release-docs-workflow.test.mjs`

Expected: FAIL because release CI currently excludes renderer and mobile suites.

- [ ] **Step 3: Update workflows and mobile documentation**

Add explicit renderer test commands and artifact upload steps. Document supported breakpoints, navigation modes, safe-area behavior, sheet semantics, manual device checklist, and baseline update procedure. Update `DESIGN.md` so the responsive system is authoritative.

- [ ] **Step 4: Run full automated verification**

Run:

```bash
rtk npm test --prefix npm/autovpn-cli
rtk npm run test:electron
```

Expected: all CLI, Electron, H5, mobile, visual, and workflow tests PASS.

- [ ] **Step 5: Run final browser and Electron verification**

First complete the H5 manual test and pixel review from Task 6. Then launch Electron, repeat one manual six-page desktop pass, and verify desktop visual baselines, focus behavior, settings sheets, packaging icon, and version display remain correct.

- [ ] **Step 6: Commit and enter delivery workflow**

Commit: `ci: gate releases on mobile ux tests`

Open a PR, request code review, apply all feedback, rerun every affected browser/Electron/visual test after each behavior change, update the PR, merge only when checks and review pass, then perform the repository's version bump, packaging, tag, push, and release workflow.

## Implementation record

- [x] Workflow contract changed test-first and observed failing before workflow edits.
- [x] PR and release workflows install pinned Chromium headless shell and WebKit runtimes, execute the complete Electron matrix, and upload visual artifacts on failure.
- [x] Responsive breakpoints, safe areas, sheet behavior, manual checks, baseline updates, GeoIP unknown behavior, and per-source count semantics are documented.

---
