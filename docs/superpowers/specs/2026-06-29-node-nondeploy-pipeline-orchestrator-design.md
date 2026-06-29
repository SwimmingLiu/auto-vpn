# Node Non-deploy Pipeline Orchestrator Design

## Summary

AutoVPN is currently in the v2 Node-first hybrid phase. The npm CLI shell, low-risk commands, job manager, backend adapter boundary, and individual Node pipeline stage modules exist, but `AUTOVPN_BACKEND=node autovpn run --skip-deploy --skip-verify` does not yet run a full pipeline through Node. `NodeBackend` is still a placeholder, and backend selection rejects non-Python backends.

This design closes that v2 gap by adding a Node backend orchestrator for the non-deploy pipeline. The first supported Node run path is deliberately scoped to local generation:

```bash
AUTOVPN_BACKEND=node autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
```

The Node backend will own the orchestration and event stream for:

```text
extract -> dedupe -> speedtest -> availability -> postprocess -> render -> obfuscate
```

`deploy` and `verify` remain Python-backed Phase 7 work. The implementation must preserve Python fallback and all current user-facing CLI contracts while making measurable progress toward v3.

## Goals

- Add a real Node backend run path for non-deploy runs.
- Keep Python as the default backend until the Node path has proven parity under CI and local smoke tests.
- Preserve the existing JSONL event contract for Agents and Electron-compatible consumers.
- Write artifact files compatible with current artifact preview, retry, and result tooling.
- Reuse existing Node stage modules rather than duplicating stage logic inside the orchestrator.
- Keep runtime rollback flags working:
  - `AUTOVPN_BACKEND=python`
  - `AUTOVPN_PIPELINE_BACKEND=python`
  - `AUTOVPN_STAGE_BACKEND_<STAGE>=python`
- Make `.env` values such as `VPN_AUTOMATION_UPSTREAM_PROXY=off` effective for Python-backed runtime calls launched from CLI/backend paths.
- Add functional, performance, stability, and security-oriented tests appropriate to this v2 increment.

## Non-Goals

- Migrating Cloudflare deploy or subscription verify to Node.
- Running live deploy in default CI.
- Removing Python fallback.
- Making `AUTOVPN_BACKEND=node` the default for all users.
- Replacing Electron backend plumbing.
- Implementing v3 `AUTOVPN_NO_PYTHON=1` behavior.

## Current State

The existing migration has completed the stage-level work for:

- `npm/autovpn-cli/src/pipeline/dedupe.ts`
- `npm/autovpn-cli/src/pipeline/postprocess.ts`
- `npm/autovpn-cli/src/pipeline/render.ts`
- `npm/autovpn-cli/src/pipeline/obfuscate.ts`
- `npm/autovpn-cli/src/pipeline/availability.ts`
- `npm/autovpn-cli/src/pipeline/extract.ts`
- `npm/autovpn-cli/src/pipeline/speedtest.ts`

Those modules are tested independently with Python golden fixtures. However, they are not connected by a Node controller. The backend selector still only returns `PythonBackend`, and `NodeBackend` has no `run()` implementation.

The Python pipeline controller is still authoritative for full production runs, especially deploy and verify. Its behavior defines the compatibility target for event names, artifact file names, summary shape, redaction, and failure semantics.

## Design

### 1. Backend selection

`selectBackend()` will accept:

```text
AUTOVPN_BACKEND=python
AUTOVPN_BACKEND=node
```

Rules:

- Empty or `python` returns `PythonBackend`.
- `node` returns `NodeBackend`.
- Unknown values still fail with a clear error.
- Node backend may reject unsupported operations explicitly instead of silently falling back.

This keeps rollout explicit: operators must opt in with `AUTOVPN_BACKEND=node` until v3 cutover.

### 2. Node backend scope

`NodeBackend.run()` supports only:

```text
skipDeploy=true
skipVerify=true
output=jsonl|human
resumeLatest=false
```

Unsupported combinations return clear errors:

- Deploy requested: `Node backend deploy is not available yet; use AUTOVPN_BACKEND=python or --skip-deploy --skip-verify`
- Verify requested: same class of error
- Resume latest requested: Python fallback is required until resume orchestration is migrated

`NodeBackend` remains intentionally partial for:

- `retryStage`
- `resume`
- `startDetached`
- `stopJob`
- `readJob`
- `readLogs`

Those remain handled by the existing Node CLI/job manager or `PythonBackend` depending on command path.

### 3. Orchestrator module

Create a dedicated module:

```text
npm/autovpn-cli/src/pipeline/orchestrator.ts
```

Responsibilities:

- Load project profile from TOML.
- Resolve runtime root and artifact root using existing Node runtime path helpers.
- Create an artifact directory.
- Emit JSONL-compatible events.
- Execute the non-deploy stage order.
- Write artifact text files and `pipeline_report.json`.
- Return a summary compatible with current Python summary events.

The orchestrator should not own individual stage business logic. It calls the stage modules:

- `fetchSourceLinksWithBackend()`
- `dedupeVmessLinksWithBackend()`
- `speedtestLinksWithBackend()`
- `checkLinkAvailabilityBatchWithBackend()`
- postprocess helpers
- `renderMainDataWithBackend()`
- `buildWorkerArtifactsWithBackend()`

Network-heavy runtime stages keep their current boundary:

- Node can orchestrate them.
- Runtime extraction and proxy checks may still call Python fallback or injected implementations.
- Stage rollback flags still work per stage.

### 4. Artifact contract

The Node non-deploy run writes the same core files used by current preview and docs:

```text
pipeline_report.json
events.jsonl when requested through --event-log
human.log when requested through --human-log
vpn_node_raw.txt
vpn_node_deduped.txt
vpn_node_speedtest.txt
vpn_node_availability.txt
vpn_node_emoji.txt
worker.js or worker_transformed.js according to existing render/obfuscate contracts
_worker.js
pages_bundle/_worker.js
pages_bundle/modules/*.js
pages_bundle/manifest.json
```

If an exact Python artifact is expensive or not applicable before deploy, the Node run must still produce the files consumed by:

- `artifacts latest`
- `artifacts list`
- `artifacts preview`
- Electron result hydration
- Agent troubleshooting docs

The implementation plan must inspect the current Python controller output and keep names aligned with current tests.

### 5. Event contract

The Node run emits the existing top-level events:

```text
run_started
log
stage
summary
run_failed
```

It forwards or recreates stage-level events already documented in `docs/npm-cli/node-first-event-schema.md`, including:

```text
extract_source_started
extract_request_result
extract_decrypt_result
extract_iteration
extract_source_completed
speedtest_runtime
speedtest_probe_result
speedtest_selected
speedtest_result
availability_link_result
```

JSONL stdout must contain one JSON object per line. Human output must use the same `render_human_event()`-style semantics as the Python backend where practical.

### 6. `.env` runtime environment hardening

The user-facing expectation is that project `.env` values affect CLI/backend runs. Today, some code paths read `.env` into a local dictionary, while `resolve_upstream_proxy_url()` reads only `os.environ`. This means:

```env
VPN_AUTOMATION_UPSTREAM_PROXY=off
```

can be ignored by extract fallback logic.

The v2 hardening change is:

- When the Python backend or Python stage helper is spawned, merge project `.env` into the child process environment.
- Explicit process environment values win over `.env`.
- The merge must redact or avoid printing secrets.
- This applies to Python-backed stage helpers used by the Node orchestrator and to Python backend forwarding where the project root is known.

This avoids changing profile semantics and makes Linux/headless runs less surprising.

### 7. Error handling

Stage failure rules should match Python as closely as the first orchestrator increment can reasonably support:

- Mark the current stage `failed`.
- Emit `run_failed` with redacted error text.
- Emit a terminal `summary` with `run_status=failed`.
- Return a non-zero CLI exit code through the backend adapter.
- Preserve partially written artifact files for inspection.

Unsupported Node backend features fail early before creating misleading artifacts.

### 8. Rollout strategy

The Node run path is opt-in for v2:

```bash
AUTOVPN_BACKEND=node
```

Default CLI behavior remains Python-backed until:

- Node non-deploy run passes fixture, smoke, and CI gates.
- Deploy/verify Phase 7 is complete.
- Electron convergence Phase 8 is complete.
- v3 cutover checks pass without Python.

## Testing Requirements

### Functional tests

- `selectBackend()` returns `NodeBackend` when `AUTOVPN_BACKEND=node`.
- Node backend rejects deploy/verify runs with a clear error.
- Node backend emits `run_started`, ordered `stage` events, and terminal `summary`.
- Node backend writes the required artifact files for a fixture non-deploy run.
- Existing low-risk commands continue to pass.

### Parity tests

- A deterministic fixture run compares Node output to Python-compatible expected artifacts and summary fields.
- Stage rollback flags still dispatch to Python helpers.
- `.env` upstream proxy values are visible to spawned Python helpers.

### Performance tests

- Add a bounded fixture performance check that verifies the Node orchestrator handles a large deterministic link set without excessive runtime.
- This should be a unit/integration test using local fixtures, not live network.

### Stability tests

- Failure injection for extract, speedtest, availability, render, and obfuscate.
- Confirm failed runs produce a redacted `run_failed` and inspectable `pipeline_report.json`.
- Confirm repeated Node fixture runs create separate artifact directories without corrupting previous output.

### Security tests

- Secret-bearing fields from profile, `.env`, deployment config, and artifact summaries remain redacted.
- JSONL stdout does not print raw source keys, Cloudflare tokens, secret query strings, full tokenized subscription URLs, or proxy credentials.
- `.env` merge must not dump all environment variables in errors.

### Compatibility gates

Before merging a v2 orchestrator PR, run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh tests/pipeline -q
rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh -q
rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh tests/e2e -q
rtk proxy npm run test:electron
rtk proxy npm run package:electron
rtk proxy npm pack --pack-destination /tmp --prefix npm/autovpn-cli
```

The packaged Electron build must still use project icon assets and must not report the default Electron icon warning.

## Open Decisions Resolved by This Design

- v2 should be completed before Phase 7 deploy/verify migration.
- The next implementation target is a Node non-deploy orchestrator, not v3 cutover.
- `.env` runtime hardening is part of v2 because it directly affects CLI/headless usability.
- Deploy and verify remain Phase 7 so Cloudflare live-service risk stays isolated.

## Path to v3

After this design is implemented and verified:

1. Phase 7 migrates deploy and verify with dry-run and live-gated tests.
2. Phase 8 makes Electron consume the same Node backend service layer.
3. Phase 9 flips Node to the default, disables Python fallback by default, and verifies:

```bash
AUTOVPN_NO_PYTHON=1 autovpn --version
AUTOVPN_NO_PYTHON=1 autovpn doctor --project-root . --output json
AUTOVPN_NO_PYTHON=1 autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
```

v3 is complete only when Linux headless, Agent CLI, Electron packaged app, release workflow, and full regression suites pass without Python for normal operation.
