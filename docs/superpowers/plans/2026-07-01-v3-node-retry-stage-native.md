# v3 Node Native Retry Stage Plan

**Goal:** Implement non-detached `AUTOVPN_BACKEND=node autovpn retry-stage` without falling back to the Python backend.

**Architecture:** Add a reusable pipeline-level `retryNodePipelineStage()` that seeds a fresh retry artifact from an existing artifact, copies the stage inputs required by the selected retry point, and continues the Node pipeline from `speedtest`, `availability`, `postprocess`, `render`, `obfuscate`, `deploy`, or `verify`. `NodeBackend.retryStage()` streams this native event flow through the existing backend adapter queue.

## Tasks

- [x] Add failing tests proving `NodeBackend.retryStage()` no longer reports the unsupported fallback.
- [x] Add failing tests proving Node retry creates a fresh artifact with `retry_context`, event logs, human logs, and continued stage statuses.
- [x] Add a regression test proving `speedtest` retry passes only speedtest winners into availability.
- [x] Implement artifact seeding for retry inputs and stage continuation through Node stage adapters.
- [x] Update CLI README boundaries so `retry-stage` is no longer listed as Node-native follow-up work.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Implement `NodeBackend.resume()` for pipeline and speedtest sessions.
- Implement `NodeBackend.run({ resumeLatest: true })`.
- Migrate detached retry/resume worker commands from Python-compatible workers to Node workers after foreground resume is native.

## Validation

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy env AUTOVPN_NO_PYTHON=1 AUTOVPN_BACKEND=node node npm/autovpn-cli/bin/autovpn.mjs run --project-root . --skip-deploy --skip-verify --output jsonl
rtk proxy node --test electron/tests/*.test.mjs
rtk proxy uv run --with pytest pytest tests -q
rtk proxy npm pack --prefix npm/autovpn-cli --dry-run
```
