# v3 Node Foreground Resume/Retry Adapter Plan

**Goal:** Move non-detached `retry-stage` and `resume` CLI commands off the generic `executeCli()` shell fallback when `AUTOVPN_BACKEND=node`, so the selected backend adapter owns their foreground event streams.

**Architecture:** Keep production behavior on the Python backend unchanged. For the Node backend, the npm shell should parse command options and consume `backend.retryStage()` / `backend.resume()` exactly like `backend.run()`. Node-native implementations of those backend methods remain the next migration slice.

## Tasks

- [x] Add failing tests proving `AUTOVPN_BACKEND=node retry-stage` streams `backend.retryStage()` events instead of calling `executeCli()`.
- [x] Add failing tests proving `AUTOVPN_BACKEND=node resume pipeline` streams `backend.resume()` events instead of calling `executeCli()`.
- [x] Extend foreground event rendering to `run`, `retry-stage`, and `resume`.
- [x] Widen backend option typing so `retry-stage` and `resume` preserve the existing `--output human` contract.
- [x] Update CLI docs to distinguish adapter dispatch from full Node-native resume/retry implementation.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Implement `NodeBackend.retryStage()` for retryable artifact stages.
- Implement `NodeBackend.resume()` for pipeline and speedtest sessions.
- Implement `NodeBackend.run({ resumeLatest: true })` and then migrate detached resume-latest workers off Python fallback.

## Validation

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy env AUTOVPN_NO_PYTHON=1 AUTOVPN_BACKEND=node node npm/autovpn-cli/bin/autovpn.mjs run --project-root . --skip-deploy --skip-verify --output jsonl
rtk proxy node --test electron/tests/*.test.mjs
rtk proxy uv run --with pytest pytest tests -q
rtk proxy npm pack --prefix npm/autovpn-cli --dry-run
```
