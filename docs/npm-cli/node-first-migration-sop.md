# AutoVPN Node-first CLI Migration SOP

## Purpose

This SOP defines the route for converting AutoVPN from a Python-first CLI into a Node.js-first npm CLI while preserving the current working Python automation backend until each capability has been safely migrated.

The goal is to make AutoVPN feel like npm-native tools such as OpenCLI:

```bash
npx -y @swimmingliu/autovpn doctor --project-root . --output json
npm install -g @swimmingliu/autovpn
autovpn run --project-root . --output jsonl
```

This document is not a one-step rewrite plan. It is a staged migration SOP:

```text
v1: npm wrapper + Python backend
v2: Node-first CLI + Python pipeline fallback
v3: full Node.js backend
```

## Research Summary

OpenCLI is npm-native: as of June 28, 2026, its public docs document `npm install -g @jackwener/opencli`, expose an `opencli` command for humans and AI agents, and require a Node runtime. Its npm page currently lists Node.js >= 20, while its installation guide currently lists Node.js >= 21; before implementation, verify the authoritative version from OpenCLI's `package.json` rather than copying either number blindly. AutoVPN is currently different: the public terminal entry is a Python console script from `pyproject.toml`:

```toml
[project.scripts]
autovpn = "vpn_automation.cli:main"
```

Current AutoVPN responsibilities are split as follows:

- `src/vpn_automation/cli.py`: Python CLI routing and stdout/stderr behavior.
- `src/vpn_automation/backend.py`: Electron/backend command surface.
- `src/vpn_automation/doctor.py`: runtime readiness checks.
- `src/vpn_automation/jobs.py`: detached job lifecycle.
- `src/vpn_automation/artifact_preview.py`: safe artifact summaries.
- `src/vpn_automation/config/`: profile and runtime path handling.
- `src/vpn_automation/pipeline/`: extraction, dedupe, speedtest, availability, render, obfuscate, deploy, verify.
- `.github/workflows/release-electron.yml`: Electron and Python CLI package publishing.
- `docs/npm-cli/`: npm wrapper SOP, test SOP, release/CI plan, Agent docs plan.

The risk is concentrated in the pipeline modules. The low-risk CLI shell and read-only inspection commands can move to Node earlier.

Research references:

- OpenCLI repository: <https://github.com/jackwener/OpenCLI>
- OpenCLI npm package name from README: `@jackwener/opencli`
- OpenCLI npm package page: <https://www.npmjs.com/package/@jackwener/opencli>
- OpenCLI installation guide: <https://github.com/jackwener/opencli/blob/main/docs/guide/installation.md>

## Python Source to Node Target Map

Use this map when planning each implementation PR. Every migration task must identify the source module, the target module, the data contract, the fixture, the rollback flag, and the completion evidence before code changes begin.

| Area | Current Python source | Node target | Data contract | Rollback flag |
| --- | --- | --- | --- | --- |
| CLI shell | `src/vpn_automation/cli.py` | `npm/autovpn-cli/src/cli/**` | argv, help text, exit codes, stdout/stderr | `AUTOVPN_CLI_SHELL=python` |
| profile summary | `src/vpn_automation/cli.py`, `src/vpn_automation/config/**` | `npm/autovpn-cli/src/config/profile.ts` | redacted profile JSON | `AUTOVPN_PROFILE_BACKEND=python` |
| doctor | `src/vpn_automation/doctor.py` | `npm/autovpn-cli/src/doctor/checks.ts` | doctor JSON/human output | `AUTOVPN_DOCTOR_BACKEND=python` |
| artifacts | `src/vpn_automation/artifact_preview.py`, `src/vpn_automation/backend.py` | `npm/autovpn-cli/src/artifacts/**` | artifact list/latest/preview JSON | `AUTOVPN_ARTIFACTS_BACKEND=python` |
| jobs | `src/vpn_automation/jobs.py`, `src/vpn_automation/cli.py` | `npm/autovpn-cli/src/jobs/**` | `state/jobs/**` files, process lifecycle, logs | Node-owned in v3; `AUTOVPN_JOBS_BACKEND` is ignored |
| backend events | `src/vpn_automation/backend.py`, pipeline `event_callback` emitters | `npm/autovpn-cli/src/events/schema.ts` | JSONL events and redaction | `AUTOVPN_BACKEND=python` |
| dedupe | `src/vpn_automation/pipeline/dedupe.py` | `npm/autovpn-cli/src/pipeline/dedupe.ts` | link list in/out | `AUTOVPN_STAGE_BACKEND_DEDUPE=python` |
| postprocess | `src/vpn_automation/pipeline/postprocess.py` | `npm/autovpn-cli/src/pipeline/postprocess.ts` | filtered/decorated links | `AUTOVPN_STAGE_BACKEND_POSTPROCESS=python` |
| render | `src/vpn_automation/pipeline/render.py`, `worker_build.py` | `npm/autovpn-cli/src/pipeline/render.ts` | worker render artifacts | `AUTOVPN_STAGE_BACKEND_RENDER=python` |
| obfuscate | `src/vpn_automation/pipeline/package.py`, `worker_build.py` | `npm/autovpn-cli/src/pipeline/obfuscate.ts` | worker bundle files | `AUTOVPN_STAGE_BACKEND_OBFUSCATE=python` |
| availability | `src/vpn_automation/pipeline/availability.py` | `npm/autovpn-cli/src/pipeline/availability.ts` | availability JSON and link results | `AUTOVPN_STAGE_BACKEND_AVAILABILITY=python` |
| extract | `src/vpn_automation/pipeline/extract.py` | `npm/autovpn-cli/src/pipeline/extract.ts` | source progress and raw links | `AUTOVPN_STAGE_BACKEND_EXTRACT=python` |
| speedtest | `src/vpn_automation/pipeline/speedtest.py` | `npm/autovpn-cli/src/pipeline/speedtest.ts` | probe events and fast links | `AUTOVPN_STAGE_BACKEND_SPEEDTEST=python` |
| deploy | `src/vpn_automation/integrations/cloudflare.py`, `backend_resume.py` | `npm/autovpn-cli/src/pipeline/deploy.ts` | redacted deployment result | `AUTOVPN_STAGE_BACKEND_DEPLOY=python` |
| verify | `src/vpn_automation/integrations/cloudflare.py`, `backend_resume.py` | `npm/autovpn-cli/src/pipeline/verify.ts` | redacted verification result | `AUTOVPN_STAGE_BACKEND_VERIFY=python` |

## Migration Principles

- npm is the user-facing distribution layer.
- Node.js becomes the long-term CLI runtime.
- Python remains the authoritative backend only until a command or stage has parity tests and a Node implementation.
- Do not reimplement business behavior twice without a parity test.
- Do not migrate pipeline stages before the CLI contract, artifact model, redaction rules, and release checks are stable.
- JSON/JSONL stdout must stay clean for Agents.
- stderr is diagnostics-only and must never contain secrets.
- npm package, Python package, and Electron app versions must stay synchronized until Python is fully retired.

## Target Repository Layout

The migration should converge on this structure:

```text
npm/autovpn-cli/
├── package.json
├── README.md
├── bin/
│   └── autovpn.mjs
├── src/
│   ├── cli/
│   │   ├── main.ts
│   │   ├── commands/
│   │   └── output.ts
│   ├── config/
│   ├── artifacts/
│   ├── jobs/
│   ├── doctor/
│   ├── python-adapter/
│   ├── pipeline/
│   └── runtime/
├── test/
└── tsconfig.json
```

Existing Python code remains under `src/vpn_automation/` until the v3 cutover.

## Phase 0: Baseline Audit and Contract Freeze

### Goal

Create an authoritative inventory of current Python behavior before changing the runtime shape.

### Tasks

1. Inventory current CLI commands.
2. Inventory Electron backend calls that depend on Python.
3. Freeze stdout/stderr/exit-code behavior.
4. Define a command risk classification.
5. Create fixtures for profile, artifacts, jobs, and pipeline outputs.
6. Inventory the full JSONL event schema emitted by `src/vpn_automation/backend.py` and every pipeline `event_callback`.

### Implementation Details

Create:

```text
docs/npm-cli/node-first-command-inventory.md
docs/npm-cli/node-first-contract.md
docs/npm-cli/node-first-event-schema.md
tests/fixtures/node-migration/
```

The command inventory must list:

```text
autovpn profile show/save/summary
autovpn doctor
autovpn artifacts latest/list/preview
autovpn jobs list/status/logs/stop/resume/retry
autovpn status/logs/stop
autovpn run
autovpn retry-stage
autovpn resume pipeline
autovpn resume speedtest
```

Risk levels:

- Low: help, version, profile summary, artifact list, artifact preview, doctor static checks.
- Medium: profile save, jobs status/logs/stop, detached jobs, resume metadata.
- High: run, retry-stage, speedtest, availability, render, obfuscate, deploy, verify.

The event schema inventory must include, at minimum, events emitted directly by `backend.py` and events forwarded from pipeline stages:

```text
run_started
log
stage
summary
run_failed
extract_source_started
extract_source_completed
extract_source_failed
speedtest_probe_result
availability_link_result
```

The inventory must be generated from source inspection and fixture runs, not from memory. If additional event types are found, they must be added to `docs/npm-cli/node-first-event-schema.md` before Phase 4 starts.

### Completion Evidence

```bash
rtk proxy ./scripts/run_pytest.sh tests/backend/test_headless_cli.py tests/backend/test_doctor_cli.py tests/backend/test_jobs_cli.py -v
rtk proxy node --test electron/tests/backend.test.mjs electron/tests/process-lifecycle.test.mjs
```

The phase is complete when every existing Python CLI command has documented inputs, outputs, exit codes, and redaction requirements.
It is not complete until `node-first-command-inventory.md`, `node-first-contract.md`, `node-first-event-schema.md`, and the fixture directory all exist and list the source files they were derived from.

## Phase 1: npm Wrapper MVP

### Goal

Ship an npm package that gives users and Agents the Node.js installation experience while using the current Python wheel as the backend.

### Tasks

1. Create `npm/autovpn-cli`.
2. Expose npm bin `autovpn`.
3. Locate or install the matching Python backend.
4. Forward argv, stdin, stdout, stderr, and exit code.
5. Package a local npm `.tgz` and upload it to GitHub Release.
6. Defer public npm registry publishing until the license and provenance gates are complete.

### Implementation Details

Create:

```text
npm/autovpn-cli/package.json
npm/autovpn-cli/bin/autovpn.mjs
npm/autovpn-cli/lib/runner.mjs
npm/autovpn-cli/lib/install-python-cli.mjs
npm/autovpn-cli/lib/cache.mjs
npm/autovpn-cli/lib/errors.mjs
npm/autovpn-cli/test/runner.test.mjs
```

Phase 1 intentionally uses runnable `.mjs` modules and no TypeScript build step. TypeScript starts in Phase 2, after the npm wrapper MVP is already packaged and tested.

Resolution order:

1. `AUTOVPN_PYTHON_CLI`
2. PATH `autovpn`, only when `autovpn --version` matches npm package version
3. wrapper-managed venv under user cache

Required environment overrides:

```text
AUTOVPN_CACHE_DIR
AUTOVPN_WHEEL_URL
AUTOVPN_PYTHON_PACKAGE
AUTOVPN_PIP_INDEX_URL
AUTOVPN_PIP_EXTRA_INDEX_URL
AUTOVPN_NO_INSTALL
AUTOVPN_FORCE_INSTALL
AUTOVPN_ALLOW_VERSION_MISMATCH
```

The wrapper must not parse AutoVPN business commands. It only handles wrapper runtime discovery and process forwarding.

### Completion Evidence

```bash
rtk proxy npm ci --prefix npm/autovpn-cli
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy bash -lc 'cd npm/autovpn-cli && npm pack --json --pack-destination .'
rtk proxy env AUTOVPN_PYTHON_CLI="$PWD/.venv/bin/autovpn" AUTOVPN_NO_INSTALL=1 npx -y ./npm/autovpn-cli/*.tgz --help
rtk proxy env AUTOVPN_PYTHON_CLI="$PWD/.venv/bin/autovpn" AUTOVPN_NO_INSTALL=1 npx -y ./npm/autovpn-cli/*.tgz doctor --project-root "$PWD" --output json
```

Phase 1 is complete when `npx` works from a packed local tarball and release workflow uploads an npm `.tgz`.
Public `npm publish` is not part of Phase 1 completion unless the repository license has been decided, provenance is configured, and the release workflow has an idempotent publish guard.

## Phase 2: Node-native CLI Shell

### Goal

Move the CLI command framework, help/version output, error formatting, JSON handling, and command routing into Node.js while Python remains the backend adapter.

### Tasks

1. Add TypeScript build tooling.
2. Implement Node-native command router.
3. Implement shared output helpers.
4. Implement global flags.
5. Keep Python backend adapter for all business actions.

### Implementation Details

Create:

```text
npm/autovpn-cli/src/cli/main.ts
npm/autovpn-cli/src/cli/commands/index.ts
npm/autovpn-cli/src/cli/output.ts
npm/autovpn-cli/src/cli/errors.ts
npm/autovpn-cli/src/cli/global-options.ts
npm/autovpn-cli/test/cli-shell.test.mjs
```

Use a small CLI framework such as Commander, or a local parser if dependency minimization is preferred. The shell owns:

```text
--help
--version
--project-root normalization
command-specific output flag validation
top-level command discovery
wrapper-only diagnostics
```

Output flags must preserve the current Python contract rather than introducing a new global format matrix:

```text
run/retry-stage/resume: --output jsonl|human
doctor: --output human|json
profile summary/artifacts preview/status/jobs list/jobs status/jobs resume/jobs retry: --json
top-level logs/jobs logs: --format human|jsonl
```

The shell must call the Python adapter for command execution until the command has been migrated to Node-native implementation.

### Completion Evidence

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy npx -y ./npm/autovpn-cli/*.tgz --help
rtk proxy npx -y ./npm/autovpn-cli/*.tgz --version
rtk proxy env AUTOVPN_PYTHON_CLI="$PWD/.venv/bin/autovpn" AUTOVPN_NO_INSTALL=1 npx -y ./npm/autovpn-cli/*.tgz doctor --project-root "$PWD" --output json
```

Phase 2 is complete when help/version/argument errors are produced by Node.js, while command behavior still matches Python.

## Phase 3: Node-native Low-risk Commands

### Goal

Migrate read-only and low-risk commands to Node.js while keeping Python as a fallback.

### Tasks

1. Migrate `doctor` static checks.
2. Migrate `profile summary`.
3. Migrate `artifacts latest/list/preview`.
4. Migrate `status` and `logs` read paths.
5. Add Node/Python parity tests.

### Implementation Details

Create:

```text
npm/autovpn-cli/src/config/profile.ts
npm/autovpn-cli/src/doctor/checks.ts
npm/autovpn-cli/src/artifacts/list.ts
npm/autovpn-cli/src/artifacts/preview.ts
npm/autovpn-cli/src/jobs/read.ts
npm/autovpn-cli/test/parity/*.test.mjs
```

Parsing guidance:

- Use TOML parser for `state/profile.toml`.
- Use structured JSON parsing for job and artifact metadata.
- Do not parse raw node files unless redacted preview requires it.
- Port redaction logic before exposing artifact summaries.

Parity rule:

```text
For the same fixture input:
Node stdout JSON == Python stdout JSON after normalizing path separators and timestamps.
```

Commands to migrate first:

```bash
autovpn doctor --output json
autovpn profile summary --json
autovpn artifacts latest
autovpn artifacts list
autovpn artifacts preview <artifact-dir> --json
autovpn status --json
autovpn logs --tail 50
```

### Completion Evidence

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern parity
rtk proxy ./scripts/run_pytest.sh tests/backend/test_artifact_preview_cli.py tests/backend/test_doctor_cli.py -v
```

Phase 3 is complete when these commands default to Node-native execution and Python fallback can be enabled explicitly for comparison.

## Phase 4: Backend Adapter Boundary

### Goal

Define a stable boundary between Node CLI and Python pipeline so high-risk stages can migrate incrementally without changing user-facing behavior.

### Tasks

1. Create a backend adapter interface.
2. Normalize event schemas.
3. Normalize job metadata.
4. Normalize artifact paths and previews.
5. Define fallback behavior.

### Implementation Details

Create:

```text
npm/autovpn-cli/src/backend/types.ts
npm/autovpn-cli/src/backend/python-backend.ts
npm/autovpn-cli/src/backend/node-backend.ts
npm/autovpn-cli/src/backend/select-backend.ts
npm/autovpn-cli/src/events/schema.ts
npm/autovpn-cli/test/backend-contract.test.mjs
```

Backend interface:

```ts
interface AutoVpnBackend {
  run(options: RunOptions): AsyncIterable<AutoVpnEvent>;
  retryStage(options: RetryOptions): AsyncIterable<AutoVpnEvent>;
  resume(options: ResumeOptions): AsyncIterable<AutoVpnEvent>;
  startDetached(options: DetachedRunOptions): Promise<JobSummary>;
  stopJob(jobId: string): Promise<JobSummary>;
  readJob(jobId: string): Promise<JobSummary>;
  readLogs(options: LogOptions): AsyncIterable<string>;
}
```

Event names must remain compatible with the full Python JSONL output documented in `docs/npm-cli/node-first-event-schema.md`. The adapter contract must include top-level backend events and lower-level pipeline events such as:

```text
run_started
log
stage
summary
run_failed
extract_source_started
extract_source_completed
extract_source_failed
speedtest_probe_result
availability_link_result
```

Do not start Phase 4 until Phase 0 has produced the full event schema inventory. The list above is a minimum compatibility set, not the complete contract.

### Completion Evidence

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern backend-contract
rtk proxy npx -y ./npm/autovpn-cli/*.tgz run --project-root "$PWD" --skip-deploy --skip-verify --output jsonl
```

Phase 4 is complete when all high-risk commands use a backend interface and no command calls Python directly outside the adapter.

## Phase 5: Node-native Job Manager

### Goal

Move detached jobs, status, logs, stop, resume dispatch, and retry dispatch to Node.js.

### Tasks

1. Recreate `state/jobs/` metadata handling in Node.
2. Implement process group management cross-platform.
3. Implement logs and event streaming.
4. Keep Python pipeline process as child backend during this phase.
5. Add crash recovery tests.

### Implementation Details

Create:

```text
npm/autovpn-cli/src/jobs/store.ts
npm/autovpn-cli/src/jobs/process.ts
npm/autovpn-cli/src/jobs/logs.ts
npm/autovpn-cli/src/jobs/commands.ts
npm/autovpn-cli/test/jobs/*.test.mjs
```

State files must remain compatible:

```text
state/jobs/<job-id>/job.json
state/jobs/<job-id>/events.jsonl
state/jobs/<job-id>/human.log
state/jobs/<job-id>/stdout.log
state/jobs/<job-id>/stderr.log
```

Cross-platform process rules:

- Linux/macOS: use process groups where available.
- Windows: use child process tree termination strategy and verify child cleanup.
- Never kill only the direct wrapper process if pipeline children may remain.

### Completion Evidence

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern jobs
rtk proxy npx -y ./npm/autovpn-cli/*.tgz run --project-root "$PWD" --skip-deploy --skip-verify --detach --json
rtk proxy npx -y ./npm/autovpn-cli/*.tgz status --project-root "$PWD" --json
rtk proxy npx -y ./npm/autovpn-cli/*.tgz logs --project-root "$PWD" --tail 50
rtk proxy npx -y ./npm/autovpn-cli/*.tgz stop --project-root "$PWD"
rtk proxy npx -y ./npm/autovpn-cli/*.tgz jobs status <job-id> --project-root "$PWD" --json
rtk proxy npx -y ./npm/autovpn-cli/*.tgz jobs logs <job-id> --project-root "$PWD" --format human --tail 50
rtk proxy npx -y ./npm/autovpn-cli/*.tgz jobs stop <job-id> --project-root "$PWD"
rtk proxy npx -y ./npm/autovpn-cli/*.tgz jobs resume <job-id> --project-root "$PWD" --detach --json
rtk proxy npx -y ./npm/autovpn-cli/*.tgz jobs retry --project-root "$PWD" --artifact-dir <artifact-dir> --stage <stage> --detach --json
```

Phase 5 is complete when Node owns job lifecycle and Python is only a pipeline worker process.

## Phase 6: Pipeline Stage Migration

### Goal

Migrate high-risk pipeline stages to Node.js one stage at a time.

### Migration Order

Recommended order:

1. `dedupe`
2. `postprocess`
3. `render`
4. `obfuscate`
5. `availability`
6. `extract`
7. `speedtest`

This order starts with deterministic transforms before network-heavy stages.
Deployment and verification are intentionally excluded from Phase 6 and owned by Phase 7 because they require Cloudflare credentials, live-service safety gates, and separate release validation.

### Tasks Per Stage

For every stage:

1. Write fixture inputs.
2. Capture Python golden output.
3. Implement Node stage.
4. Compare Node output to Python output.
5. Add rollback flag.
6. Run stage in full pipeline dry run.

### Implementation Details

Create stage modules under:

```text
npm/autovpn-cli/src/pipeline/
```

Examples:

```text
npm/autovpn-cli/src/pipeline/dedupe.ts
npm/autovpn-cli/src/pipeline/render.ts
npm/autovpn-cli/src/pipeline/availability.ts
npm/autovpn-cli/test/pipeline/*.test.mjs
tests/fixtures/node-migration/pipeline/
```

Each stage migration PR must include a table like this in its PR description or implementation doc:

| Stage | Python source | Node target | Fixture input | Golden output | Rollback flag |
| --- | --- | --- | --- | --- | --- |
| `dedupe` | `src/vpn_automation/pipeline/dedupe.py` | `npm/autovpn-cli/src/pipeline/dedupe.ts` | `tests/fixtures/node-migration/pipeline/dedupe/input.txt` | `tests/fixtures/node-migration/pipeline/dedupe/output.txt` | `AUTOVPN_STAGE_BACKEND_DEDUPE=python` |

Stage flags:

```text
AUTOVPN_PIPELINE_BACKEND=python
AUTOVPN_PIPELINE_BACKEND=node
AUTOVPN_PIPELINE_BACKEND=hybrid
AUTOVPN_STAGE_BACKEND_<STAGE>=python|node
```

Network-heavy stages must support deterministic fixtures and live integration tests separately. `deploy` and `verify` remain Phase 7-only.

### Completion Evidence

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern pipeline
rtk proxy ./scripts/run_pytest.sh tests/pipeline -v
rtk proxy npx -y ./npm/autovpn-cli/*.tgz run --project-root "$PWD" --skip-deploy --skip-verify --output jsonl
```

Phase 6 is complete when the default local non-deploy pipeline can run fully in Node.js and Python fallback still passes parity tests.

## Phase 7: Deploy and Verify Migration

### Goal

Move Cloudflare deployment and subscription verification to Node.js without breaking production deployment safety.

### Tasks

1. Port Cloudflare credential checks.
2. Port Wrangler invocation.
3. Port Pages project and worker deployment flow.
4. Port verification request logic.
5. Add deploy dry-run and live-gated integration tests.

### Implementation Details

Create:

```text
npm/autovpn-cli/src/integrations/cloudflare.ts
npm/autovpn-cli/src/integrations/commands.ts
npm/autovpn-cli/src/pipeline/deploy.ts
npm/autovpn-cli/src/pipeline/verify.ts
npm/autovpn-cli/test/integrations/cloudflare.test.mjs
```

Migration map:

| Capability | Python source | Node target | Contract | Rollback flag |
| --- | --- | --- | --- | --- |
| credential checks | `src/vpn_automation/doctor.py`, `integrations/cloudflare.py` | `npm/autovpn-cli/src/integrations/cloudflare.ts` | redacted readiness JSON | `AUTOVPN_STAGE_BACKEND_DEPLOY=python` |
| Wrangler command | `src/vpn_automation/integrations/commands.py`, `node_tools.py` | `npm/autovpn-cli/src/integrations/commands.ts` | command result with redacted stderr | `AUTOVPN_STAGE_BACKEND_DEPLOY=python` |
| deploy stage | `src/vpn_automation/backend_resume.py`, `integrations/cloudflare.py` | `npm/autovpn-cli/src/pipeline/deploy.ts` | deployment summary JSON | `AUTOVPN_STAGE_BACKEND_DEPLOY=python` |
| verify stage | `src/vpn_automation/backend_resume.py`, `integrations/cloudflare.py` | `npm/autovpn-cli/src/pipeline/verify.ts` | verification summary JSON | `AUTOVPN_STAGE_BACKEND_VERIFY=python` |

Safety rules:

- Never run live deploy in default CI.
- Require explicit `CLOUDFLARE_API_TOKEN` and CI opt-in for live tests.
- Redact account IDs, emails, tokens, secret query, and full subscription URLs.
- Keep `--skip-deploy` and `--skip-verify` behavior identical.

### Completion Evidence

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "cloudflare|deploy|verify"
rtk proxy env AUTOVPN_FAKE_WRANGLER=1 npm test --prefix npm/autovpn-cli -- --test-name-pattern deploy
rtk proxy env AUTOVPN_FAKE_CLOUDFLARE_CLIENT=1 npm test --prefix npm/autovpn-cli -- --test-name-pattern verify
rtk proxy npx -y ./npm/autovpn-cli/*.tgz doctor --project-root "$PWD" --deploy --strict --output json
```

Live deployment validation is a separate opt-in gate and must not run in default CI:

```bash
rtk proxy env AUTOVPN_LIVE_CLOUDFLARE=1 CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npm test --prefix npm/autovpn-cli -- --test-name-pattern "live cloudflare deploy verify"
```

Phase 7 is complete when deploy/verify dry-run and gated live tests pass and Python deploy is no longer required for release validation.

## Phase 8: Electron Backend Convergence

### Goal

Make Electron use the same Node backend modules as the npm CLI.

### Tasks

1. Replace Electron-only Python backend calls with Node service calls where migrated.
2. Keep Python backend only for fallback stages.
3. Ensure renderer event streams stay compatible.
4. Verify packaged app includes the Node CLI backend assets.

### Implementation Details

Modify:

```text
electron/lib/backend.js
electron/main.js
electron/build/package.mjs
package.json build.files
electron/tests/backend.test.mjs
electron/tests/process-lifecycle.test.mjs
```

Electron should call a shared Node service layer rather than shelling into Python for migrated commands.

Packaging must include:

```text
npm/autovpn-cli/dist/**
templates/**
electron/**
```

Python files remain packaged only while fallback is still supported.

### Completion Evidence

```bash
rtk proxy npm run test:electron
rtk proxy npm run package:electron
```

Package verification must still confirm:

- no `default Electron icon is used`
- project icon assets are packaged
- app can launch
- backend commands work without a terminal

## Phase 9: v3 Cutover

### Goal

Make Node.js the default and complete AutoVPN runtime, with Python either removed or kept only as a legacy compatibility package.

### Tasks

1. Set Node backend as default for all commands.
2. Disable Python fallback by default.
3. Update release assets and README.
4. Publish npm-native release.
5. Deprecate or freeze Python CLI.

### Implementation Details

Cutover requirements:

- `npx -y @swimmingliu/autovpn run ...` works without Python installed.
- Electron packaging no longer requires Python backend files for normal operation.
- CI release workflow builds npm and Electron artifacts from Node source.
- Python wheel publishing is either stopped or explicitly marked legacy.

Versioning:

```text
v1.x: wrapper + Python backend
v2.x: Node-first hybrid
v3.0.0: Node-only default runtime
```

### Completion Evidence

```bash
rtk proxy env AUTOVPN_NO_PYTHON=1 npx -y @swimmingliu/autovpn --version
rtk proxy env AUTOVPN_NO_PYTHON=1 npx -y @swimmingliu/autovpn doctor --project-root "$PWD" --output json
rtk proxy env AUTOVPN_NO_PYTHON=1 npx -y @swimmingliu/autovpn run --project-root "$PWD" --skip-deploy --skip-verify --output jsonl
```

Phase 9 is complete when Linux headless, Agent, Electron packaged app, and release workflows all pass without Python for normal operation.

## CI and Release SOP

Every phase must update CI before being considered complete.

Required CI gates:

```text
Python legacy tests while Python remains supported
Node CLI unit tests
Node/Python parity tests while hybrid
npm pack dry-run
npm tarball allowlist audit
wheel build while Python package remains supported
Electron headless tests
Electron packaging tests
Release notes generation tests
Version sync checks
```

Release workflow must publish:

```text
Electron installers
Python wheel/sdist while supported
npm .tgz GitHub Release asset
npm registry package only after license, provenance, and idempotent publish gates are complete
```

Public npm publishing requires a repository license decision before enabling `npm publish --access public`.

## Testing SOP

Use [npm-wrapper-test-sop.md](./npm-wrapper-test-sop.md) as the base test checklist. Add the following Node-first migration checks:

- Node/Python parity tests for each migrated command.
- Node/Python parity tests for each migrated pipeline stage.
- `AUTOVPN_NO_PYTHON=1` smoke tests after v3 cutover.
- Fixture-based tests for all deterministic pipeline stages.
- Live-gated tests for deploy and verify.
- Electron packaged app tests using Node backend.

## Rollback SOP

Every phase must preserve a rollback path:

- Phase 1 rollback: publish npm wrapper patch that points to the previous Python wheel.
- Phase 2 rollback: disable Node shell and forward all commands to Python.
- Phase 3 rollback: set migrated command backend to Python.
- Phase 4 rollback: select `AUTOVPN_BACKEND=python`.
- Phase 5 rollback: set `AUTOVPN_BACKEND=python` for detached workers while keeping job state, logs, stop, and detached command handling Node-owned.
- Phase 6 rollback: set `AUTOVPN_STAGE_BACKEND_<STAGE>=python`.
- Phase 7 rollback: keep Python deploy/verify backend.
- Phase 8 rollback: package Python backend in Electron and switch service adapter.
- Phase 9 rollback: release v3 patch re-enabling Python fallback, or issue v2 LTS patch.

## Completion Matrix

| Version | User-facing runtime | Backend runtime | Release shape | Completion signal |
| --- | --- | --- | --- | --- |
| v1 | npm CLI | Python | npm wrapper + Python wheel + Electron | `npx` works, Python backend remains required |
| v2 | Node-first CLI | Hybrid Node/Python | npm package + Python fallback + Electron | low/medium risk commands are Node-native |
| v3 | Node CLI | Node | npm package + Electron | normal operation works with `AUTOVPN_NO_PYTHON=1` |

## Decision Rule

Do not start a higher-risk migration phase until the previous phase has:

- automated tests
- local smoke evidence
- CI coverage
- docs updates
- rollback flag or fallback path
- release notes coverage

The project should optimize for npm-native user experience first, then runtime consolidation. v3 is the correct long-term target only after v2 has proven behavior parity under real AutoVPN workloads.
