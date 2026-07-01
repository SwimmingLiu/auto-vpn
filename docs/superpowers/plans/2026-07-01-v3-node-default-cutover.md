# v3 Node Default Cutover Plan

**Goal:** Make the npm `autovpn` CLI use the Node backend by default for terminal, server, and Agent workflows, while preserving the compatible Python CLI as an explicit rollback path.

**Architecture:** `AUTOVPN_BACKEND` becomes an override instead of the opt-in switch for Node. Empty or unset means Node. `AUTOVPN_BACKEND=python` routes the high-risk foreground pipeline and detached workers back to the Python adapter. Per-command and per-stage rollback flags remain available for migrated non-job commands and pipeline stages: `AUTOVPN_DOCTOR_BACKEND=python`, `AUTOVPN_PROFILE_BACKEND=python`, `AUTOVPN_ARTIFACTS_BACKEND=python`, `AUTOVPN_PIPELINE_BACKEND=python`, and `AUTOVPN_STAGE_BACKEND_<STAGE>=python`. Job state, logs, stop, detached run, detached resume, and detached retry command handling are Node-owned and intentionally ignore the old `AUTOVPN_JOBS_BACKEND` rollback flag.

## Phase 1: Backend Selection Contract

- [x] Change `selectBackend()` so unset `AUTOVPN_BACKEND` selects `NodeBackend`.
- [x] Keep `AUTOVPN_BACKEND=python` as the explicit full-backend rollback.
- [x] Reject unknown backend names instead of silently falling through.
- [x] Update backend contract tests to assert Node default and Python fallback.

## Phase 2: Runtime Stage Boundary

- [x] Remove implicit Python runtime stage injection from the Node orchestrator.
- [x] Preserve explicit stage rollback through `AUTOVPN_STAGE_BACKEND_<STAGE>=python`.
- [x] Preserve explicit full pipeline rollback through `AUTOVPN_PIPELINE_BACKEND=python`.
- [x] Keep `AUTOVPN_NO_PYTHON=1` as the strict cutover gate that also prevents fallback resolution.

## Phase 3: Native Command Python Fallback

- [x] Route migrated command fallback flags to an explicit Python backend even when the default backend is Node.
- [x] Keep default native commands Node-owned.
- [x] Update tests for `doctor`, `profile`, and `artifacts` Python fallback flags.

## Phase 4: Documentation

- [x] Update the project README to describe the Node default, npm installation flow, Agent usage, and Python rollback flags.
- [x] Update the npm CLI README to remove the old "experimental opt-in Node" framing.
- [x] Keep older implementation plans as historical records where they describe earlier migration boundaries.

## Phase 5: Validation

- [x] Run npm CLI unit and parity tests.
- [x] Run strict no-Python Node foreground pipeline smoke.
- [x] Run Electron tests.
- [x] Run Python pytest regression suite.
- [x] Run npm package dry-run and repository hygiene checks.

## Phase 6: Delivery

- [ ] Commit the cutover changes.
- [ ] Open a GitHub PR.
- [ ] Wait for CI to pass.
- [ ] Merge the PR.
- [ ] Build the npm CLI package artifact.
- [ ] Smoke test installation from the generated `.tgz`.
