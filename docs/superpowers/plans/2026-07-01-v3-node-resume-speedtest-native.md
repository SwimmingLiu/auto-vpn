# v3 Node Native Resume Speedtest Plan

**Goal:** Implement non-detached `AUTOVPN_BACKEND=node autovpn resume speedtest` without falling back to the Python backend.

**Architecture:** `resume speedtest` stays scoped to the speedtest stage. It reads the session metadata, reuses the original artifact directory, restores completed probe and download results from the session event log, probes only unprobed deduped links, downloads only candidate links without full results, writes updated speedtest artifacts, and leaves availability/deploy/verify for a later `resume pipeline` call. Native production resume requires `AUTOVPN_SPEEDTEST_RUNTIME=mihomo` so the probe/download work actually runs through each vmess node instead of the host network.

## Tasks

- [x] Add failing tests proving `NodeBackend.resume({ mode: "speedtest" })` uses the native path.
- [x] Add failing tests proving partial probe/full-download event logs are resumed instead of rerun from scratch.
- [x] Add failure-path coverage for sessions where no node passes the speed threshold.
- [x] Add regression coverage for output log overrides and direct-runtime safety.
- [x] Add regression coverage for partial speedtest stage injection and per-result resume durability.
- [x] Expose Node speedtest probe and single-link download primitives for resume orchestration.
- [x] Implement session metadata loading, event-log recovery, remaining probe/download execution, artifact writes, and failed summary emission.
- [x] Update README boundaries so `resume speedtest` is no longer listed as Node-native follow-up work.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Implement `NodeBackend.run({ resumeLatest: true })`.
- Migrate detached resume/retry worker commands from Python-compatible workers to Node workers after foreground resume-latest is native.
- Run the final v3 cutover audit after all foreground and detached high-risk paths are Node-native.

## Validation

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy env AUTOVPN_NO_PYTHON=1 AUTOVPN_BACKEND=node node npm/autovpn-cli/bin/autovpn.mjs run --project-root . --skip-deploy --skip-verify --output jsonl
rtk proxy node --test electron/tests/*.test.mjs
rtk proxy uv run --with pytest pytest tests -q
rtk proxy npm pack --prefix npm/autovpn-cli --dry-run
```
