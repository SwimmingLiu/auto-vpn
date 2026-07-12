# Mobile UX Contract

This document is the release contract for the shared Electron renderer when it is served as an H5 UI or hosted by Electron.

## Responsive modes

| Width | Navigation | Settings detail |
| --- | --- | --- |
| `320px-720px` | Fixed bottom navigation | Bottom sheet |
| `721px-960px` | Top navigation | Centered drawer |
| `>=961px` | Left sidebar | Centered drawer |

The automated matrix covers `320x568`, `360x800`, `375x667`, `390x844`, `430x932`, `720x900`, `721x900`, `768x1024`, `960x900`, `961x900`, and short landscape `844x390`. Every visible interactive target is at least `44x44px`; pages must not scroll horizontally, and their final control must remain reachable above fixed navigation and action surfaces.

## Safe areas and fixed surfaces

The renderer maps `env(safe-area-inset-*)` into `--safe-area-top`, `--safe-area-right`, `--safe-area-bottom`, and `--safe-area-left`. Phone bottom navigation includes the bottom inset. The runs page places its fixed start/stop bar above that navigation and reserves matching content padding. Short landscape must preserve content reachability rather than forcing phone portrait spacing.

## Settings sheet semantics

Opening a settings card creates one modal dialog, moves focus into it, locks background scrolling, and exposes persistent cancel and save actions. Cancel, backdrop dismissal, and `Escape` discard edits; save validates and applies them. Closing restores focus to the card that opened the sheet. On phone widths the dialog is a bottom sheet sized against the visual viewport and safe area; on wider layouts it is a centered drawer.

## Data semantics

GeoIP classification is best effort. Public addresses with no country result are displayed as `Unknown`; private, loopback, link-local, multicast, unspecified, documentation, and other non-global addresses are not submitted as public GeoIP candidates and also remain unknown.

`source_counts` is per-source pipeline evidence, not a copy of global totals. `raw_links` records links extracted by that source. `deduped_links` records that source's surviving contribution after deduplication. During an active or recovered run, global deduplicated totals may be reconstructed by summing available per-source `deduped_links`; missing fields mean unknown/not-yet-produced, not zero and not `raw_links`.

## Manual release checklist

1. Serve the renderer as H5 and inspect all six pages at `390x844`, `768x1024`, and `844x390` in Chromium. Repeat login, safe-area navigation, runs start/stop bar, settings sheet, focus return, long content, empty/error states, and final-control reachability in WebKit.
2. Inspect the generated PNGs for login, six phone pages, running state, settings sheet, tablet dashboard, and short-landscape runs. Confirm there is no clipping, overlap, unexpected blank region, or unreadable text.
3. Launch Electron and inspect Dashboard, Runs, Results, Subscriptions, Logs, and Settings at desktop size. Verify keyboard focus, settings drawer cancel/save, version text, and the desktop visual baselines.
4. Package the app and confirm the log does not contain `default Electron icon is used`, the package contains an icon derived from `electron/renderer/assets/vpn-auto-logo-v2-minimal.svg`, transparency is preserved, and visible version text matches `package.json`.

## Updating visual baselines

Baseline updates require intentional UI review. Run `UPDATE_VISUAL_BASELINES=1 rtk node --test --test-concurrency=1 electron/tests/web-server-visual.test.mjs`, inspect every changed PNG in `electron/tests/visual-baselines/mobile`, then rerun without the environment variable. Do not accept a baseline solely because a test produced it. On mismatch, CI uploads `electron/tests/visual-artifacts/**`, including actual and diff PNGs, for review.

## CI and release gate

Both pull-request CI and the release test job install the lockfile-pinned Playwright Chromium headless shell and WebKit runtime, run the complete CLI and Electron suites, and upload renderer visual diffs on failure. Mobile layout, Chromium/WebKit workflows, PNG comparisons, desktop renderer tests, packaging metadata, and workflow contract tests are therefore required before merge and release.
