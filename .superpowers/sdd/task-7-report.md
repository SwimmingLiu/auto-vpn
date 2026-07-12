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

## Review follow-up: ordered H5 and native gates

- RED: strengthened the workflow contract to parse named workflow steps and package scripts; the test failed because `test:h5`/`test:electron-native` and ordered H5/native steps did not exist.
- GREEN: both PR and release workflows now run `Run H5 mobile Chromium and WebKit gate` before `Run Electron native and desktop gate`.
- `test:h5` explicitly owns `mobile-layout-contract`, `web-server-e2e`, and `web-server-visual`; `test:electron-native` explicitly owns every remaining Electron test, including app launch, desktop E2E, and desktop visual verification.
- Contract validation compares both script file lists with the directory inventory, proving exactly-once coverage with no overlap, and rejects exclusion/test-name filtering inside either gate regardless of quote style.
- Fresh verification: workflow 8/8, H5 19/19, native/desktop 136/136 (155/155 equivalent total), CLI 358/358.

## Review follow-up: fail-closed gate commands

- RED: added mutation fixtures for package-script filters/failure swallowing and workflow command/condition bypasses; the contract failed because the shared validator did not yet exist.
- GREEN: the validator now inspects both package script bodies and both named workflow steps. It rejects `--test-name-pattern`, exclude/filter/grep selectors, `|| true`, `; true`, extra workflow shell commands, `continue-on-error`, and conditional `if` gates.
- Workflow gate `run` values must normalize to exactly `npm run test:h5` and `npm run test:electron-native`; mutation fixtures prove each bypass is detected.
- Fresh verification after this follow-up: workflow contract 9/9, H5 19/19, native/desktop 137/137. The extra native test is the new contract fixture, so complete coverage is now 156/156.

## Final review follow-up: strict script allowlist

- RED: added mutations for `| cat`, `|| :`, `; exit 0`, redirection, an unknown flag, and a duplicate test path; the prior blacklist missed the pipe bypass.
- GREEN: package gate scripts are now normalized only for whitespace and compared with exact allowlisted commands. H5 must contain only Node's test runner, `--test-concurrency=1`, and the exact three H5 files; native must contain the same approved runner/flag and every remaining test exactly once in directory order.
- Any shell operator, redirection, command substitution/extra token, unknown flag, duplicate, missing file, or reordered/subset command fails the contract. Workflow steps retain their exact-command and unconditional/fail-closed validation.
- Fresh verification: workflow contract 9/9, H5 19/19, native/desktop 137/137.

## Final fixture coverage

- Added an explicit missing-file mutation that removes `web-server-visual.test.mjs` from `test:h5` and proves the strict validator rejects the incomplete gate.
- Fresh workflow contract verification: 9/9; `git diff --check` clean. H5/native were not rerun because this follow-up changes only the contract fixture and report.
