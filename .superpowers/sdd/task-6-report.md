# Task 6 report — mobile/tablet/accessibility/visual matrix

## RED

- `rtk node --test --test-name-pattern="mobile PNGs" electron/tests/web-server-visual.test.mjs`
  failed with `ENOENT ... visual-baselines/mobile/dashboard-390x844.png`, proving the PNG baseline contract was active before baselines existed.
- `rtk node --test --test-name-pattern="login PNG" electron/tests/web-server-visual.test.mjs`
  failed with `ENOENT ... visual-baselines/mobile/login-390x844.png`.
- WebKit's mobile sheet opacity assertion failed with actual
  `rgba(255, 255, 255, 0.96)` vs required opaque `rgb(255, 255, 255)`; the screenshot exposed underlying settings copy through the sheet.
- The first complete matrix run found hidden controls being measured and the stale desktop Runs digest; those contracts were corrected by opening the secondary controls and restricting final reachability to visible controls.

## Implementation

- Added reusable exported `assertMobileLayout(page, { width, height })` covering root width/no horizontal overflow, bottom/top/sidebar navigation modes, 44 px navigation targets, exactly one active navigation item, and reachable final visible controls.
- Covered 320×568, 360×800, 375×667, 390×844, 430×932, 720×900, 721×900, 768×1024, 960×900, 961×900, and 844×390; all six pages are exercised at phone width, with explicit landscape Logs and tablet Dashboard checks.
- Added pinned Playwright WebKit coverage for safe-area bottom navigation, Runs action bar, Settings sheet/visual viewport, and login failure/success. `rtk npx playwright install webkit` confirmed the pinned runtime setup.
- Replaced mobile hash-only evidence with reviewable PNG baselines for six pages/state views, running Runs, Settings sheet, login, 360 small screen, 768 tablet, and 844×390 landscape. Mismatches retain `*-actual.png`, `*-diff.png`, and a digest manifest under `electron/tests/visual-artifacts/mobile/`.
- Made the settings dialog surface opaque (`#fff`) to eliminate bleed-through discovered during manual review.

## Verification

- Build assets: `rtk npm run build:autovpn-cli` — PASS.
- Baseline generation: `rtk env UPDATE_VISUAL_BASELINES=1 node --test --test-name-pattern="mobile PNGs" electron/tests/web-server-visual.test.mjs` — PASS (1/1).
- Chromium + WebKit contract: `rtk node --test electron/tests/mobile-layout-contract.test.mjs` — PASS (3/3).
- Complete requested matrix: `rtk node --test --test-concurrency=1 electron/tests/mobile-layout-contract.test.mjs electron/tests/web-server-e2e.test.mjs electron/tests/web-server-visual.test.mjs` — PASS (19/19, 16.59 s), including the explicit landscape/tablet contract assertions.

## Manual H5 visual/interaction review

- Reviewed the generated browser screenshots for all six 390×844 page baselines, the 360×800 Settings view/sheet, 844×390 Runs, and 768×1024 tablet navigation.
- Confirmed fixed bottom navigation/action bars do not cover reachable controls, no page-level horizontal scrolling occurs, controls remain at least 44 px, and landscape content remains vertically scrollable.
- Found and fixed translucent Settings sheet bleed-through; regenerated and re-reviewed the opaque sheet PNG.
- Automated H5 interactions cover login error/success, run start/stop, result/subscription copy, QR generation path, log filtering/copy/clear, and all Settings sheet save/cancel/focus-return paths in `web-server-e2e.test.mjs`; WebKit repeats the high-risk login/navigation/action-bar/sheet paths.

## Commit

- Intended commit: `test: add complete mobile ux regression matrix`

## Review focus

- PNG comparison is intentionally byte-deterministic. On a mismatch, the baseline and `actual` PNG are retained, `diff.png` renders changed pixels in magenta, and `diff.txt` records exact digests.
- Baselines use Playwright Chromium at CSS scale with fixed time/language and disabled animations. Browser/runtime upgrades require an intentional baseline refresh.

## Spec-review remediation (2026-07-12)

- RED: the expanded control contract failed on six 34–38 px landscape Logs controls; the injected 24 px WebKit safe-area assertion failed because production CSS consumed `env()` directly; and the visual test failed until a distinct idle Runs baseline existed.
- GREEN: the six-page workflow now remains at a real 390×844 mobile viewport for Runs, Results, Subscriptions, Logs, and Settings (including all sheets), with mobile QR failure/retry and log clear/undo/follow/jump-latest exercised in the same flow.
- Safe areas are represented by production `--safe-area-*` properties backed by `env(..., 0px)`. WebKit injects non-zero 18/24/9/11 px values and proves the 100 px run-bar bottom offset, 32 px bottom-nav padding, and 36 px sheet action padding.
- `assertMobileLayout` now checks every visible page `button`, `input`, `select`, and `[tabindex="0"]` target for 44×44 minimum, excluding controls under `[hidden]` or `[aria-hidden="true"]`; landscape toolbar controls were fixed to satisfy it.
- Cleanup timeouts now reject with `cleanup timed out...` and always clear their timer instead of silently continuing.
- Baseline/artifact paths now resolve from `import.meta.url`. Runs has separate `runs-idle-390x844.png` and `runs-running-390x844.png` evidence; both were manually reviewed after regeneration.
- Final requested matrix after remediation: 19/19 PASS in 17.96 s.

## Settings phone-flow follow-up

- RED: the new persisted-value contract caught that the availability row is normalized/reordered after save (`gemini` was last rather than the newly added `custom` row). The test now supplies a valid custom URL and verifies the saved row by membership rather than incidental ordering.
- At 390×844, every Sources, Speed Test, Availability Targets, and Deploy sheet now edits a representative field, saves, closes, restores focus to its opener, reopens, and verifies the persisted value.
- Each sheet additionally reopens at 844×390 for the landscape visibility/overflow check, then cancels and restores opener focus; landscape remains additive rather than replacing phone editing.
- A distinct 390×844 Deploy Cancel path verifies visibility, closure, and opener focus restoration.
- Final complete matrix: 19/19 PASS in 14.60 s.
