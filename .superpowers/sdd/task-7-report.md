# Task 7 Report

## Status

Implemented the pull-request and release mobile UX gates. Both workflows install the lockfile-pinned Playwright 1.59.1 Chromium headless shell and WebKit runtimes, execute the complete Electron matrix, and upload `electron/tests/visual-artifacts/**` on failure. Added the authoritative responsive/mobile contract and refreshed intentional Task 8/9 data-semantics visual baselines.

## TDD evidence

- RED: `rtk node --test electron/tests/release-docs-workflow.test.mjs` — 6 passed, 2 failed because neither workflow installed Chromium/WebKit, ran the full renderer matrix, or uploaded visual diffs.
- GREEN: the same command — 8 passed, 0 failed.

## Automated verification

- `rtk npm test --prefix npm/autovpn-cli`: 358 passed, 0 failed.
- `rtk npm run test:electron`: 155 passed, 0 failed. This includes native Electron launch, the 11-viewport layout matrix, WebKit safe-area/login/settings behavior, six-page renderer E2E, desktop hash baselines, H5 workflows, and 13 reviewable mobile PNG baselines.
- Workflow contract: 8 passed, 0 failed.
- `rtk git diff --check`: clean.

The first Electron run reported an incomplete local `node_modules/electron` installation. Investigation confirmed that `electron/dist` was absent and the GitHub binary download timed out. Rebuilding from `https://npmmirror.com/mirrors/electron/` installed Electron 37.10.3; both native app-launch tests then passed.

## H5 and desktop visual evidence

- H5 Chromium/WebKit exercised phone `390x844`, tablet `768x1024`, short landscape `844x390`, login, all six pages, running state, settings sheet, safe-area navigation, and fixed run actions. All mobile PNG comparisons passed after reviewing and accepting the intentional tablet dashboard count-semantics update.
- Desktop Electron opened through the native Playwright Electron launcher. The six-page navigation/E2E pass and six desktop visual hashes passed; focus restoration and settings cancel/save behavior are covered by the renderer matrix.
- Updated desktop/H5 hashes reflect the Task 8/9 `Unknown` GeoIP and independent raw/deduplicated source-count presentation; unchanged pages retained their previous hashes.

## Packaging, icon, and version

- Packaging produced `dist-electron/mac-arm64/AutoVPN.app` and reached the DMG builder. The app contains `Contents/Resources/icon.icns`; both the committed generated PNG and packaged ICNS report alpha transparency.
- Packaging output explicitly selected `electron/build/assets/app-icon-1024.png` and `electron/build/assets/app-icon.icns` and did not report `default Electron icon is used`.
- Root package, npm CLI, renderer, and packaged renderer all show version `1.7.0` / `v.1.7.0`.
- DMG creation is externally blocked: the GitHub download of `dmgbuild-bundle-arm64-75c8a6c.tar.gz` timed out, while the configured China electron-builder mirror returns 404 for this file. The runnable `.app`, icon, and version checks completed; no DMG was produced locally.

## Documentation

`docs/mobile-ux.md` documents breakpoints, navigation modes, safe-area variables, mobile run bar, sheet/focus semantics, the manual device checklist, baseline-update procedure, GeoIP unknown handling, and authoritative per-source raw/deduplicated count semantics. `DESIGN.md` points to this contract.
