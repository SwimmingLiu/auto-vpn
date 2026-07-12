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
