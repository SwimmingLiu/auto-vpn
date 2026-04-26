# Configurable AI Streaming Pipeline Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editable AI availability targets, stream extract/speedtest/availability work, dedupe with the run database, keep only the latest artifact, show latest results on client startup, and fix Electron titlebar/window sizing/layout.

**Architecture:** Extend the profile schema with editable availability target tables, pass those targets to availability checks, and move controller heavy-stage execution to a producer/worker streaming flow. The run store owns per-run canonical dedupe. Electron receives latest artifact metadata through IPC and renders a dedicated titlebar-safe row with fit-to-display window defaults.

**Tech Stack:** Python 3.12, SQLite, pytest, Electron 37, native renderer JavaScript, Node test runner, Playwright.

---

## File Structure

- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/AGENTS.md`: local review workflow.
- Modify `/Users/swimmingliu/data/VPN/AGENTS.md`: parent workspace local review workflow.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/models.py`: add `AvailabilityTargetConfig`, defaults, profile parsing.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/store.py`: TOML render/load support for availability targets.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/availability.py`: target normalization, custom targets, batch target argument.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/run_store.py`: canonical raw link dedupe and artifact lookup helpers.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/controller.py`: streaming heavy-stage flow, artifact retention, latest artifact helper.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend.py`: `artifact-latest` command.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js`: `artifact:latest` IPC.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/preload.cjs`: expose latest artifact call.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/window-config.js`: display-aware window sizing.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/main.js`: pass display work area.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/index.html`: add titlebar row.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`: titlebar safe area and compact bottom spacing.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`: settings card and target editor markup/helpers.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`: target edit handlers and latest result hydration.
- Modify tests under `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests` and `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests`.

## Tasks

### Task 1: Profile schema and TOML persistence

- [ ] Add failing tests in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_store.py`:
  - `test_default_profile_has_editable_ai_availability_targets`
  - `test_profile_store_round_trips_custom_availability_target`
- [ ] Run `rtk ./scripts/run_pytest.sh tests/config/test_store.py -v` and verify those tests fail because `availability_targets` is missing.
- [ ] Implement `AvailabilityTargetConfig`, default target creation, `AppProfile.availability_targets`, `from_dict()`, and `to_dict()`.
- [ ] Extend `_render_profile_toml()` to write `[availability_targets.<name>]` tables with `url`, `enabled`, `allowed_hosts`, and `negative_phrases`.
- [ ] Re-run `rtk ./scripts/run_pytest.sh tests/config/test_store.py -v` and verify pass.

### Task 2: Configurable availability checks

- [ ] Add failing tests in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_availability.py`:
  - `test_normalize_provider_targets_uses_custom_profile_targets`
  - `test_check_link_availability_only_checks_enabled_targets`
- [ ] Run `rtk ./scripts/run_pytest.sh tests/pipeline/test_availability.py -v` and verify failures mention missing target support.
- [ ] Add target normalization in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/availability.py`.
- [ ] Update `check_link_availability()` and `check_link_availability_batch()` to accept `targets`.
- [ ] Keep default behavior unchanged when no targets are passed.
- [ ] Re-run `rtk ./scripts/run_pytest.sh tests/pipeline/test_availability.py -v` and verify pass.

### Task 3: DB-backed canonical dedupe

- [ ] Add failing tests in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_run_store.py`:
  - `test_run_store_dedupes_raw_links_by_canonical_key_across_sources`
  - `test_record_raw_link_returns_false_for_duplicate`
- [ ] Run `rtk ./scripts/run_pytest.sh tests/pipeline/test_run_store.py -v` and verify failures.
- [ ] Add `canonical_key` column and unique index/table constraint support in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/run_store.py`.
- [ ] Make `record_raw_link()` return a boolean insert result.
- [ ] Re-run `rtk ./scripts/run_pytest.sh tests/pipeline/test_run_store.py -v` and verify pass.

### Task 4: Streaming controller and artifact retention

- [ ] Add failing tests in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_controller.py`:
  - `test_pipeline_streams_speedtest_before_extract_finishes`
  - `test_pipeline_prunes_old_artifacts_after_new_run`
  - `test_pipeline_passes_profile_availability_targets`
- [ ] Run `rtk ./scripts/run_pytest.sh tests/pipeline/test_controller.py -v` and verify failures.
- [ ] Implement streaming heavy stages in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/controller.py`.
- [ ] Mark `dedupe` as DB-index completed and keep `deduped_links` count aligned to unique raw links.
- [ ] Persist speedtest/availability results as each worker completes.
- [ ] Add artifact pruning after new artifact directory creation with retention count one.
- [ ] Re-run `rtk ./scripts/run_pytest.sh tests/pipeline/test_controller.py -v` and verify pass.

### Task 5: Latest artifact startup hydration

- [ ] Add failing backend tests in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_backend_cli.py` for `artifact_latest_json`.
- [ ] Add failing Electron tests in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs` or `renderer-e2e.test.mjs` for latest artifact hydration.
- [ ] Run `rtk ./scripts/run_pytest.sh tests/backend/test_backend_cli.py -v` and `rtk node --test electron/tests/backend.test.mjs electron/tests/renderer-e2e.test.mjs`.
- [ ] Implement backend `artifact-latest` command and Electron `artifact:latest` IPC/preload call.
- [ ] In renderer bootstrap, load latest artifact after profile load and populate `artifactDir`, `counts`, `outputFiles`, and `nodeRows`.
- [ ] Re-run the backend and Electron tests above.

### Task 6: Settings UI for editable AI targets

- [ ] Add failing tests in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`:
  - target draft add/delete/edit helpers
  - settings markup includes the AI availability card and target table
- [ ] Run `rtk node --test electron/tests/ui-state.test.mjs` and verify failures.
- [ ] Add helper exports in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js` for availability target drafts.
- [ ] Add settings overview card and drawer body for AI targets.
- [ ] Add click/input handlers in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js` for add/delete/edit and save.
- [ ] Re-run `rtk node --test electron/tests/ui-state.test.mjs`.

### Task 7: Electron titlebar, sizing, and visual layout

- [ ] Add failing tests in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/window-config.test.mjs` for display-aware non-fullscreen sizing.
- [ ] Add/adjust renderer visual assertions for `.window-titlebar` and reduced subscriptions page blank area.
- [ ] Run `rtk node --test electron/tests/window-config.test.mjs electron/tests/renderer-visual.test.mjs` and verify expected failures.
- [ ] Update `window-config.js`, `main.js`, `index.html`, and `styles.css`.
- [ ] Re-run window and visual tests, then update visual hashes only after inspecting screenshots.

### Task 8: Full workflow, local review, PR, merge, package

- [ ] Run H5 renderer Playwright/manual browser round first.
- [ ] Run `rtk ./scripts/run_pytest.sh tests -v`.
- [ ] Run `rtk node --test electron/tests/*.test.mjs`.
- [ ] Run package test/build: `rtk npm run package:electron`.
- [ ] Perform local review against this plan and `rtk git diff`.
- [ ] Fix review findings and repeat affected tests.
- [ ] Commit implementation changes without staging unrelated user changes.
- [ ] Push branch to origin and open a PR.
- [ ] Merge the PR after tests and local review are clean.
- [ ] Package the merged project into a runnable Electron app.

## Self-Review

- Spec coverage: all user requirements map to tasks 1 through 8.
- Placeholder scan: no `TBD` or open implementation placeholder remains.
- Type consistency: profile field name is consistently `availability_targets`; runtime target object remains `ProviderTarget`.
