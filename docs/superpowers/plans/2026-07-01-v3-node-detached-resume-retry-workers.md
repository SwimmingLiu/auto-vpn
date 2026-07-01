# v3 Node Detached Resume Retry Workers Plan

**Goal:** Make detached resume/retry workers Node-native under `AUTOVPN_BACKEND=node`, matching the already migrated foreground resume/retry/resume-latest paths.

**Architecture:** Keep the Node job manager and job metadata format unchanged. Replace the special Python-only worker selection in `startDetachedResume()` and `startDetachedRetry()` with the same worker resolver used by detached run. When `AUTOVPN_BACKEND=node`, the spawned worker is `process.execPath bin/autovpn.mjs ...`; otherwise the default production path remains the compatible Python CLI.

## Tasks

- [x] Add failing job-manager tests proving `AUTOVPN_BACKEND=node jobs resume --detach`, `jobs retry --detach`, and detached resume-latest spawn the Node CLI worker.
- [x] Update detached worker resolution so run, resume, retry, and resume-latest share the same backend-aware worker choice.
- [x] Update backend contract coverage for detached retry under the Node backend.
- [x] Update README and historical v3 plan boundaries.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Run the final v3 cutover audit with `AUTOVPN_NO_PYTHON=1`.
- Decide whether the default production backend should switch from Python to Node after the audit evidence is clean.

## Validation

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy env AUTOVPN_NO_PYTHON=1 AUTOVPN_BACKEND=node node npm/autovpn-cli/bin/autovpn.mjs run --project-root . --skip-deploy --skip-verify --output jsonl
rtk proxy node --test electron/tests/*.test.mjs
rtk proxy uv run --with pytest pytest tests -q
rtk proxy npm pack --prefix npm/autovpn-cli --dry-run
```
