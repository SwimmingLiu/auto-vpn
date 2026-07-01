# v3 Node Native Resume Pipeline Plan

**Goal:** Implement non-detached `AUTOVPN_BACKEND=node autovpn resume pipeline` without falling back to the Python backend.

**Architecture:** Keep `resume speedtest` as a separate migration slice. `resume pipeline` reads the session `session.json`, reuses the original artifact directory, restores passed speedtest results from Node artifact files, emits `resume_pipeline_state`, and continues the Node pipeline from availability through verify. Event and human logs default to the paths stored in the session metadata unless CLI options override them.

## Tasks

- [x] Add failing tests proving `NodeBackend.resume({ mode: "pipeline" })` no longer reports the unsupported fallback.
- [x] Add failing tests proving `resumeNodePipeline()` continues a session in the original artifact and appends events/logs.
- [x] Add failure-path coverage proving incomplete resume state still emits a failed summary and `run_failed`.
- [x] Add compatibility coverage for Python-style `speedtest_result` event logs and malformed session metadata.
- [x] Implement session metadata loading, report restoration, and Node continuation through availability, postprocess, render, obfuscate, deploy, and verify.
- [x] Update CLI README boundaries so `resume pipeline` is no longer listed as Node-native follow-up work.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Implement `NodeBackend.resume({ mode: "speedtest" })` with probe/full-download resume state recovery.
- Implement `NodeBackend.run({ resumeLatest: true })`.
- Migrate detached resume worker commands from Python-compatible workers to Node workers after foreground speedtest resume is native.

## Validation

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy env AUTOVPN_NO_PYTHON=1 AUTOVPN_BACKEND=node node npm/autovpn-cli/bin/autovpn.mjs run --project-root . --skip-deploy --skip-verify --output jsonl
rtk proxy node --test electron/tests/*.test.mjs
rtk proxy uv run --with pytest pytest tests -q
rtk proxy npm pack --prefix npm/autovpn-cli --dry-run
```
