# AutoVPN Mobile UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all AutoVPN H5 features usable and polished on phones and tablets while preserving the existing desktop experience.

**Architecture:** Keep the current shared renderer state and page builders, but add semantic view states and mobile-specific structural variants inside the same components. CSS uses content-driven breakpoints for phone, tablet, desktop, and short landscape; JavaScript updates stable DOM nodes and owns focus, log-following, QR state, and reversible actions.

**Tech Stack:** Vanilla ES modules, semantic HTML, CSS media/container behavior, Node.js test runner, Playwright Chromium/WebKit, Electron.

## Global Constraints

- Mobile and desktop must expose the same complete feature set.
- Phone touch targets are at least 44×44 CSS px; primary actions are at least 48px high.
- Root documents may not overflow horizontally; explicitly scoped internal scrollers are allowed.
- Phone sheets use `100dvh`, safe-area padding, modal semantics, focus trapping, Escape dismissal, and opener focus restoration.
- Support 320, 360, 375, 390, 430, 720, 768px and phone landscape.
- Preserve the existing indigo brand and desktop information density.
- Motion lasts 150–250ms and respects `prefers-reduced-motion`.
- H5 browser verification precedes Electron verification after every behavior or UI change.

---

### Task 1: Responsive Shell, Navigation, and Shared Interaction Contracts

**Files:**
- Modify: `electron/renderer/index.html`
- Modify: `electron/renderer/views.js`
- Modify: `electron/renderer/styles.css`
- Modify: `electron/tests/ui-state.test.mjs`
- Modify: `electron/tests/web-server-e2e.test.mjs`

**Interfaces:**
- Produces: navigation buttons with `aria-current="page"` on the active item.
- Produces: CSS tokens `--z-sticky`, `--z-bottom-nav`, `--z-backdrop`, `--z-sheet`, `--z-toast`.
- Produces: phone/tablet/desktop shell contracts consumed by every later task.

- [ ] **Step 1: Add failing view-state tests for navigation semantics**

Add assertions equivalent to:

```js
const nav = buildSidebarNav(getMessages('zh-CN'), 'runs');
assert.match(nav, /id="navRuns"[^>]*aria-current="page"/);
assert.doesNotMatch(nav, /id="navDashboard"[^>]*aria-current/);
```

- [ ] **Step 2: Add failing mobile shell contract tests**

In the 390×844 H5 test, assert all six navigation items are visible, each bounding box is at least 44×44, the active item changes `aria-current`, the final page control can scroll above the bottom navigation, and `documentElement.scrollWidth <= clientWidth`.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `rtk node --test electron/tests/ui-state.test.mjs electron/tests/web-server-e2e.test.mjs`

Expected: FAIL on missing `aria-current`, 42px actions, or mobile layout contracts.

- [ ] **Step 4: Implement semantic navigation and viewport-safe shell**

Update the viewport to `viewport-fit=cover`. Render the active button as:

```js
`<button id="nav${capitalize(page)}" class="nav-item active" data-page="${page}" aria-current="page">…</button>`
```

Define semantic z-index tokens and change the phone shell to use safe-area padding, 44px minimum controls, a scrollable six-item navigation at very narrow widths, and a labeled tablet navigation for 721–960px. Ensure Electron retains a 38px drag region.

- [ ] **Step 5: Add short-landscape and reduced-motion rules**

Add `(orientation: landscape) and (max-height: 500px)` rules that remove nonessential sticky headers and use compact dynamic heights. Add a reduced-motion block that disables nonessential transforms/transitions.

- [ ] **Step 6: Run focused tests and commit**

Run: `rtk node --test electron/tests/ui-state.test.mjs electron/tests/web-server-e2e.test.mjs`

Expected: PASS.

Commit: `feat: establish mobile shell contracts`

---

### Task 2: Accessible Full-Screen Settings Sheets and Mobile Field Groups

**Files:**
- Modify: `electron/renderer/app.js`
- Modify: `electron/renderer/views.js`
- Modify: `electron/renderer/styles.css`
- Modify: `electron/tests/ui-state.test.mjs`
- Modify: `electron/tests/renderer-e2e.test.mjs`
- Modify: `electron/tests/web-server-e2e.test.mjs`

**Interfaces:**
- Produces: `openSettingsDrawer(section, opener)` and `closeSettingsDrawer({ restoreFocus: true })` behavior.
- Produces: `[data-settings-dialog]` with dialog semantics and no focusable closed state.
- Consumes: shell safe-area and z-index contracts from Task 1.

- [ ] **Step 1: Add failing rendering tests for dialog and field names**

Assert a closed drawer renders with `hidden` and no cancel/save controls. Assert an open drawer contains:

```html
<aside data-settings-dialog role="dialog" aria-modal="true" aria-labelledby="settingsDrawerTitle">
```

Assert source fields expose names such as `aria-label="雷霆：地址"` and availability fields expose names such as `aria-label="Gemini：URL"`.

- [ ] **Step 2: Add failing browser tests for modal behavior**

At 390×844, open each settings section and verify: focus moves inside, Tab/Shift+Tab remain inside, Escape closes, focus returns to the opener, backdrop closes, Save and Cancel remain visible after viewport height shrinks, and no root horizontal overflow occurs.

- [ ] **Step 3: Run tests and verify failure**

Run: `rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs electron/tests/web-server-e2e.test.mjs`

Expected: FAIL because the current drawer is always focusable and has no focus lifecycle.

- [ ] **Step 4: Implement modal lifecycle**

Store the opener element, focus the first enabled field or close button after render, handle Escape and focus wrapping from a `keydown` listener, and restore opener focus on close. Render the closed sheet as `hidden inert`; render the open sheet with dialog attributes and a titled close button.

- [ ] **Step 5: Implement mobile settings field groups**

Keep desktop tables, but add row labels/data attributes so phone CSS renders each row as a vertically stacked field group. Place destructive row actions at the end, make every label explicit, and remove the 720px minimum width on phone.

- [ ] **Step 6: Implement dynamic viewport and safe areas**

Make the backdrop `position:absolute; inset:0`; place the sheet above it. At phone widths use `height:100vh; height:100dvh`, independent body scrolling, safe-area padding on header/footer, and a sticky action footer visible above the software keyboard.

- [ ] **Step 7: Verify and commit**

Run the focused tests, then manually inspect source, availability, deploy, and about sheets at 390×844 and 844×390.

Expected: all focused tests PASS; all fields and actions remain reachable.

Commit: `feat: rebuild settings as accessible mobile sheets`

---

### Task 3: Mobile Run Workspace and Focus-Stable Live Updates

**Files:**
- Modify: `electron/renderer/app.js`
- Modify: `electron/renderer/views.js`
- Modify: `electron/renderer/styles.css`
- Modify: `electron/tests/ui-state.test.mjs`
- Modify: `electron/tests/renderer-e2e.test.mjs`
- Modify: `electron/tests/web-server-e2e.test.mjs`

**Interfaces:**
- Produces: `[data-mobile-run-bar]` containing only start/stop actions.
- Produces: `updateChromeState()` that mutates stable title, badge, and button state without replacing navigation DOM.
- Consumes: phone shell positioning from Task 1.

- [ ] **Step 1: Add failing tests for compact run controls**

Assert mobile markup separates the two primary actions from retry history/options and that only `[data-mobile-run-bar]` is a `position: fixed` bottom action surface above bottom navigation. Assert the run workspace uses bottom padding/scroll-margin avoidance, shows secondary or stage content in the initial viewport without a large normal-flow gap, and keeps final content reachable above the action surface. Assert each pipeline stage exposes textual status.

- [ ] **Step 2: Add failing high-frequency focus test**

Focus `#navLogs` or the stop button, emit repeated stage/log events, and assert `document.activeElement` remains the same DOM node after every event.

- [ ] **Step 3: Run tests and verify failure**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs electron/tests/web-server-e2e.test.mjs`

Expected: FAIL because `renderChrome()` replaces navigation/actions on events.

- [ ] **Step 4: Split stable chrome rendering from state updates**

Render navigation only when language or active page changes. Implement `updateChromeState()` to set `textContent`, badge classes, and `disabled`/`aria-busy` attributes on existing nodes. Preserve stable button identity during event streams.

- [ ] **Step 5: Restructure the run workspace**

Render primary start/stop actions in a dedicated bar. Keep retry, stage selection, options, and help in normal flow using `<details>` on phone while preserving expanded desktop presentation. Use a single-column stage timeline under 720px.

- [ ] **Step 6: Verify and commit**

Run focused tests and inspect idle, running, stopping, failed, and retry states at 360×800, 390×844, and 844×390.

Expected: tests PASS; controls never obscure stages; focus survives event updates.

Commit: `feat: optimize mobile run workflow`

---

### Task 4: Responsive Results and Reliable Subscription Actions

**Files:**
- Modify: `electron/renderer/state.js`
- Modify: `electron/renderer/app.js`
- Modify: `electron/renderer/views.js`
- Modify: `electron/renderer/styles.css`
- Modify: `electron/tests/ui-state.test.mjs`
- Modify: `electron/tests/renderer-e2e.test.mjs`
- Modify: `electron/tests/web-server-e2e.test.mjs`

**Interfaces:**
- Produces: `state.qr = { status: 'idle'|'loading'|'success'|'error'|'unavailable', dataUrl: '', message: '' }`.
- Produces: responsive node rows with `.node-card-field` labels on phone and table presentation on desktop.
- Produces: copy controls with `aria-busy` and redacted activity logs.

- [ ] **Step 1: Add failing state/view tests**

Assert QR error and unavailable states render actionable copy and retry controls, selected subscription formats expose `aria-pressed="true"`, and node rows include mobile field labels without duplicating data.

- [ ] **Step 2: Add failing mobile workflows**

At 390×844, navigate to Results and Subscriptions; verify node details are readable without root horizontal scrolling, formats switch, copy is debounced while pending, QR failure offers retry, and activity logs never contain the copied URL or node payload.

- [ ] **Step 3: Run tests and verify failure**

Run: `rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs electron/tests/web-server-e2e.test.mjs`

Expected: FAIL on QR state, accessible selection, or mobile node presentation.

- [ ] **Step 4: Implement explicit QR state machine**

Set `loading` before generation, `success` with `dataUrl`, `unavailable` when the bridge cannot generate QR, and `error` with a retry action after exceptions. Never map every empty data URL to loading.

- [ ] **Step 5: Implement responsive results and safe copy feedback**

Add field labels to node cells and switch rows to grid field groups on phone. While copying, disable the initiating control and set `aria-busy`; log only action type (for example, “已复制订阅链接”), never the value.

- [ ] **Step 6: Verify and commit**

Run focused tests and visually inspect long URLs, long node names, empty results, QR loading, success, error, and unavailable states.

Expected: PASS and no root overflow.

Commit: `feat: adapt results and subscriptions for mobile`

---

### Task 5: Mobile Log Reading, Follow Mode, and Reversible Clear

**Files:**
- Modify: `electron/renderer/state.js`
- Modify: `electron/renderer/app.js`
- Modify: `electron/renderer/views.js`
- Modify: `electron/renderer/styles.css`
- Modify: `electron/tests/ui-state.test.mjs`
- Modify: `electron/tests/renderer-e2e.test.mjs`
- Modify: `electron/tests/web-server-e2e.test.mjs`

**Interfaces:**
- Produces: `state.logView = { follow: true, unseenCount: 0, clearedSnapshot: null }`.
- Produces: `[role="log"]`, `[data-log-jump-latest]`, and `[data-log-undo-clear]` behaviors.

- [ ] **Step 1: Add failing log view tests**

Assert the stream has `role="log"`, selected filters use `aria-pressed`, destructive clear is visually separated, and an unseen-message action appears only when `follow` is false and new events arrive.

- [ ] **Step 2: Add failing browser interaction tests**

Test that near-bottom users follow appended logs; scrolled-up users retain position and get an unseen count; “回到底部” resumes following; clear exposes Undo; Undo restores the snapshot; phone landscape retains a usable log viewport.

- [ ] **Step 3: Run tests and verify failure**

Run: `rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs electron/tests/web-server-e2e.test.mjs`

Expected: FAIL because current log updates replace HTML without scroll intent.

- [ ] **Step 4: Implement scroll-aware log updates**

Before rendering, record whether the container is within 32px of its bottom and its scroll anchor. Append or update content, then scroll only when following; otherwise increment `unseenCount` and preserve the anchor.

- [ ] **Step 5: Implement reversible clear and mobile toolbar**

Save the current filtered log snapshot when clearing, show an Undo action in the toast/log toolbar, and discard the snapshot when the toast expires or another clear occurs. Group filters separately from copy/open/clear actions and apply 44px controls.

- [ ] **Step 6: Verify and commit**

Run focused tests and inspect long log streams at 390×844 and 844×390.

Expected: PASS; reading position is stable; bottom navigation remains usable.

Commit: `feat: improve mobile log reading`

---

### Task 6: Complete Mobile, Tablet, Accessibility, and Visual Regression Matrix

**Files:**
- Modify: `electron/tests/web-server-e2e.test.mjs`
- Modify: `electron/tests/web-server-visual.test.mjs`
- Create: `electron/tests/mobile-layout-contract.test.mjs`
- Create: `electron/tests/visual-baselines/mobile/*.png`
- Modify: `electron/renderer/styles.css`

**Interfaces:**
- Produces: reusable `assertMobileLayout(page, { width, height })` contract covering overflow, touch targets, safe content end, and active navigation.
- Consumes: all user-facing behaviors from Tasks 1–5.

- [ ] **Step 1: Add breakpoint contract tests**

Cover 320×568, 360×800, 375×667, 390×844, 430×932, 720×900, 721×900, 768×1024, 960×900, 961×900, and 844×390. For each relevant page assert root width, navigation mode, target sizes, and final-element reachability.

- [ ] **Step 2: Expand six-page mobile workflows**

At 390×844 exercise Dashboard, Runs, Results, Subscriptions, Logs, and all Settings sheets. Include login error/success, run start/stop, results copy, QR error/retry, log follow/undo, and settings save/cancel/focus behavior.

- [ ] **Step 3: Add WebKit high-risk coverage**

Run login, safe-area bottom navigation, run action bar, and settings sheet/visual viewport tests through Playwright WebKit. If the installed browser is missing, install the pinned Playwright WebKit runtime in setup rather than skipping the tests.

- [ ] **Step 4: Replace hash-only mobile visual evidence with PNG baselines**

Capture deterministic PNGs for all six 390×844 pages plus running state, open settings sheet, login, 360px small screen, 768px tablet, and 844×390 landscape. On mismatch, emit actual/diff artifacts while keeping deterministic assertions.

- [ ] **Step 5: Run the complete browser matrix**

Run: `rtk node --test --test-concurrency=1 electron/tests/mobile-layout-contract.test.mjs electron/tests/web-server-e2e.test.mjs electron/tests/web-server-visual.test.mjs`

Expected: all tests PASS with reviewable PNG output.

- [ ] **Step 6: Manual H5 visual and interaction review**

In a plain browser, manually complete all six phone pages at 390×844, the settings sheet at 360×800, Runs/Logs at 844×390, and tablet navigation at 768×1024. Confirm no clipped text, trapped scrolling, inaccessible controls, or page-level horizontal scrolling.

- [ ] **Step 7: Commit**

Commit: `test: add complete mobile ux regression matrix`

---

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

---

### Task 8: Persist and Report Per-Source Canonical Dedupe Counts

**Files:**
- Modify: `npm/autovpn-cli/src/pipeline/run-store.ts`
- Modify: `npm/autovpn-cli/src/pipeline/orchestrator.ts`
- Modify: `npm/autovpn-cli/test/pipeline/run-store.test.mjs`
- Modify: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`
- Modify: `electron/renderer/app.js`
- Modify: `electron/tests/ui-state.test.mjs`

**Interfaces:**
- Produces: `RunStore.sourceDedupedCounts(): Record<string, number>` from persisted first-seen canonical ownership.
- Produces: `source_counts[source].deduped_links` for normal, retry, resume, and final summaries.

- [ ] **Step 1: Add failing first-seen ownership tests**

Use two sources where A observes `shared + uniqueA` and B observes `shared + uniqueB`. Assert SQLite assigns `shared` to A, returns `{ A: 2, B: 1 }`, and the sum equals global canonical count 3 after reopen/resume.

- [ ] **Step 2: Add failing orchestrator producer tests**

Assert the returned result and `pipeline_report.json` contain raw and deduped source counts for normal and resume paths. Verify legacy artifacts with missing dedupe counts are normalized as unknown rather than zero in the renderer.

- [ ] **Step 3: Run RED tests**

Run: `rtk node --test npm/autovpn-cli/test/pipeline/run-store.test.mjs npm/autovpn-cli/test/pipeline/orchestrator.test.mjs electron/tests/ui-state.test.mjs`

Expected: FAIL because `pipeline_nodes` has no source owner and reports omit per-source dedupe counts.

- [ ] **Step 4: Add SQLite ownership migration and authoritative query**

Add a nullable `first_source` column through the existing migration system. Set it atomically only when inserting a new canonical node; preserve it on duplicate observations. Backfill from the earliest matching raw observation where possible. Implement `sourceDedupedCounts()` and use it for every summary path.

- [ ] **Step 5: Preserve legacy artifact semantics**

Make renderer normalization distinguish a missing `deduped_links` field from a numeric zero; render missing historical data as `—` while rendering real zero as `0`.

- [ ] **Step 6: Verify and commit**

Run focused CLI/Electron tests plus `rtk git diff --check`.

Commit: `fix: report per-source dedupe counts`

---

### Task 9: Restore Production GeoIP Lookup Without False-US Fallback

**Files:**
- Create: `npm/autovpn-cli/src/pipeline/geoip.ts`
- Create: `npm/autovpn-cli/test/pipeline/geoip.test.mjs`
- Modify: `npm/autovpn-cli/src/pipeline/orchestrator.ts`
- Modify: `npm/autovpn-cli/src/pipeline/postprocess.ts`
- Modify: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`
- Modify: `npm/autovpn-cli/test/pipeline/postprocess.test.mjs`
- Modify: `electron/lib/artifact-preview.js`
- Modify: `electron/tests/artifact-preview.test.mjs`

**Interfaces:**
- Produces: `createGeoIpLookup(options?): (address: string) => Promise<string>` returning ISO alpha-2 or `ZZ`.
- Consumes: VMess server `add` values from postprocess nodes.

- [ ] **Step 1: Add failing provider and resolver tests**

Cover public-safe fixtures for IPv4 AU, IPv6, domain A/AAAA, primary success, primary 429 with `Retry-After` then fallback success, malformed schema, timeout, and dual failure returning `ZZ`. Use injected fetch/resolver clocks; no live network dependency in tests.

- [ ] **Step 2: Add failing production-path tests**

Run the orchestrator without a test `countryLookup` override and assert a non-US provider result reaches node `ps`; cover normal, retry, and resume. Assert empty/invalid/`ZZ` postprocess country never becomes US and UI preview labels it as other/unknown.

- [ ] **Step 3: Run RED tests**

Run: `rtk node --test npm/autovpn-cli/test/pipeline/geoip.test.mjs npm/autovpn-cli/test/pipeline/postprocess.test.mjs npm/autovpn-cli/test/pipeline/orchestrator.test.mjs electron/tests/artifact-preview.test.mjs`

Expected: FAIL because production defaults to `US` and no GeoIP service exists.

- [ ] **Step 4: Implement bounded GeoIP service**

Resolve literals/domains with IPv4 and IPv6 support, query the primary provider with timeout, validate schema/status, honor bounded `Retry-After`, then query fallback. Cache successful country codes; use a short negative TTL for `ZZ`; deduplicate concurrent lookups by resolved IP.

- [ ] **Step 5: Wire every pipeline path and remove false-US defaults**

Create one lookup per run and reuse it in normal, retry, and resume paths. Keep injected lookup support for deterministic tests. Change every unknown/invalid fallback from `US` to `ZZ`, map it to neutral “其他/未知” UI presentation, and retain explicit real US results.

- [ ] **Step 6: Verify and commit**

Run focused tests, the full CLI suite, Electron artifact/UI tests, and `rtk git diff --check`.

Commit: `fix: restore reliable geoip lookup`

---

## Plan Self-Review

- Every explicit page and audit P1 issue maps to Tasks 1–5.
- Phone, tablet, breakpoint, landscape, WebKit, visual, accessibility, and CI evidence map to Tasks 6–7.
- Shared state contracts (`qr`, `logView`) and DOM contracts are defined before their consumers.
- The plan contains no deferred implementation markers or unspecified test commands.
