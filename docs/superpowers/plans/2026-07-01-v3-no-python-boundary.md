# v3 No-Python Boundary Implementation Plan

**Goal:** Make `AUTOVPN_NO_PYTHON=1` a reliable v3 readiness gate instead of allowing the Node CLI to silently install or launch the Python backend.

**Architecture:** Keep Python as the default production fallback for normal hybrid runs, but treat `AUTOVPN_NO_PYTHON=1` as an explicit cutover assertion. The Node orchestrator must not inject default Python runtime stages in this mode, and the npm wrapper must not resolve or install a Python backend.

## Tasks

- [x] Add a failing orchestrator test proving `AUTOVPN_NO_PYTHON=1` disables default Python runtime stage fallback.
- [x] Add a failing wrapper test proving `AUTOVPN_NO_PYTHON=1` prevents Python backend install fallback.
- [x] Update `defaultRuntimeStageEnv()` to skip default Python runtime stages when no-python mode is enabled.
- [x] Update Python CLI resolution to fail immediately when no-python mode is enabled.
- [x] Document the boundary in the root README and npm CLI README.
- [x] Run targeted validation and manual no-python smoke.
- [x] Run full local validation and local review.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Expected Behavior

`AUTOVPN_NO_PYTHON=1 AUTOVPN_BACKEND=node autovpn run --skip-deploy --skip-verify` must not install or launch Python. Empty offline runs can now complete fully in Node. Until non-empty speedtest and availability runtime implementations are complete, runs that reach those boundaries may still fail, but the failure must point at the first unmigrated Node boundary.

## Validation

```bash
rtk proxy npm run build --prefix npm/autovpn-cli
rtk proxy node --test npm/autovpn-cli/test/runner.test.mjs npm/autovpn-cli/test/pipeline/orchestrator.test.mjs
rtk proxy env AUTOVPN_NO_PYTHON=1 AUTOVPN_BACKEND=node node npm/autovpn-cli/bin/autovpn.mjs run --project-root . --skip-deploy --skip-verify --output jsonl
```
