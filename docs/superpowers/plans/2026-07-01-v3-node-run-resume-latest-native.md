# v3 Node Native Run Resume Latest Plan

**Goal:** Implement non-detached `AUTOVPN_BACKEND=node autovpn run --resume-latest` without falling back to the Python backend.

**Architecture:** Node resume-latest keeps the Python-compatible `run.db` discovery contract. It scans the configured artifacts root for artifact directories with `run.db`, skips terminal runs (`success`, `failed`, `stopped`) and runs whose `verify` stage already succeeded, then constructs a temporary session metadata file for the latest incomplete artifact. The actual continuation reuses the existing Node `resume pipeline` path so event handling, artifact writes, and downstream stage behavior stay centralized.

## Tasks

- [x] Add a failing backend contract test proving `NodeBackend.run({ resumeLatest: true })` uses the latest incomplete `run.db` instead of rejecting as unsupported.
- [x] Implement Python-compatible latest incomplete `run.db` discovery in the Node backend.
- [x] Construct a temporary session for the selected artifact and continue through `resumeNodePipeline`.
- [x] Preserve `--skip-deploy` and `--skip-verify` semantics during Node resume pipeline continuation.
- [x] Update README boundaries so `run --resume-latest` is no longer listed as Node-native follow-up work.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Migrate detached resume/retry worker commands from Python-compatible workers to Node workers.
- Replace direct `node:sqlite` usage with the shared Node job/run-store abstraction if the run database grows beyond resume-latest discovery.
- Run the final v3 cutover audit after all foreground and detached high-risk paths are Node-native.

## Validation

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy env AUTOVPN_NO_PYTHON=1 AUTOVPN_BACKEND=node node npm/autovpn-cli/bin/autovpn.mjs run --project-root . --skip-deploy --skip-verify --output jsonl
rtk proxy node --test electron/tests/*.test.mjs
rtk proxy uv run --with pytest pytest tests -q
rtk proxy npm pack --prefix npm/autovpn-cli --dry-run
```
