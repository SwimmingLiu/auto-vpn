# AutoVPN CLI

Node-first npm CLI for AutoVPN headless and Agent workflows.

## Usage

```bash
npx -y https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/swimmingliu-autovpn-<version>.tgz doctor --project-root . --output json
npm install -g https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/swimmingliu-autovpn-<version>.tgz
autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
```

The public npm registry package is not enabled in Phase 1. Use the GitHub Release `.tgz` until license, provenance, and idempotent publishing gates are complete.

For Agent-friendly JSONL output, prefer foreground runs:

```bash
autovpn doctor --project-root . --output json
autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
autovpn artifacts latest --project-root .
```

## Runtime Shape

The CLI is currently hybrid:

- Node.js handles `--help`, `--version`, argument validation, `doctor --output json`, `profile summary --json`, `artifacts latest/list/preview`, `status --json`, `logs`, read-only `jobs` commands, and detached job management.
- Python remains the default backend for production pipeline actions, selected through the backend adapter boundary. Under `AUTOVPN_BACKEND=node`, `run --detach` now spawns the Node CLI worker; detached resume/retry workers still execute the compatible Python CLI command until those runtimes are migrated.
- The experimental Node backend can orchestrate foreground pipeline runs when explicitly selected with `AUTOVPN_BACKEND=node`. Plain Cloudflare Pages deploy, primary blocked-project fallback, share-project `SUB` sync, share-project fallback, custom-domain binding, custom-domain DNS upsert, and verify are Node-native. Python stage fallback remains available for rollback while the native Node runtime continues toward v3.

Experimental Node-orchestrated foreground run:

```bash
AUTOVPN_BACKEND=node \
autovpn run --project-root . --output jsonl
```

Current Node backend limits:

- Detached job management runs in Node for `run --detach`, `jobs resume --detach`, and `jobs retry --detach`; `AUTOVPN_BACKEND=node run --detach` also uses the Node CLI worker.
- Detached resume/retry worker commands remain Python-compatible until the worker runtimes are migrated.
- Non-detached `retry-stage` and `resume` are now dispatched through the selected backend adapter. The default Python backend remains production-compatible; Node-native `retryStage` and `resume` implementations are the next v3 migration boundary.
- Add `--skip-deploy --skip-verify` when you want an offline Node pipeline check.
- Plain Node foreground deploy/verify runs use Node for Wrangler deploy, primary blocked-project fallback, share-project sync/fallback, custom-domain binding, custom-domain DNS upsert, and verify.
- Deploy and verify can be rolled back with `AUTOVPN_STAGE_BACKEND_DEPLOY=python` and `AUTOVPN_STAGE_BACKEND_VERIFY=python`.
- `AUTOVPN_NO_PYTHON=1` disables implicit Python backend resolution and default Python runtime stage fallback. Use it as a v3 readiness gate. Empty offline runs now complete in Node, and Node has direct HTTP speedtest and availability runtimes. Node also has opt-in Mihomo-backed paths: set `AUTOVPN_SPEEDTEST_RUNTIME=mihomo` for controller delay probing and candidate downloads through the local Mihomo proxy, and set `AUTOVPN_AVAILABILITY_RUNTIME=mihomo` to check provider availability through the same per-node proxy runtime.
- `--resume-latest` is not implemented for the Node backend yet.
- Project `.env` is loaded before resolving profile and artifact paths. Explicit process environment values still win over `.env`.

Fallback flags for migrated commands:

```bash
AUTOVPN_CLI_SHELL=python autovpn <args>
AUTOVPN_BACKEND=python autovpn run --project-root . --output jsonl
AUTOVPN_DOCTOR_BACKEND=python autovpn doctor --output json
AUTOVPN_PROFILE_BACKEND=python autovpn profile summary --json
AUTOVPN_ARTIFACTS_BACKEND=python autovpn artifacts latest
AUTOVPN_JOBS_BACKEND=python autovpn status --json
```

## Python Backend Resolution

When a command still needs Python, the wrapper resolves the backend in this order:

1. `AUTOVPN_PYTHON_CLI`
2. PATH `autovpn`, accepted only when `autovpn --version` matches this npm package version
3. wrapper-managed Python virtual environment under `AUTOVPN_CACHE_DIR` or the user cache

For Python-backed commands, the wrapper forwards argv, stdin, stdout, stderr, and exit code.

## Environment

- `AUTOVPN_CACHE_DIR`
- `AUTOVPN_WHEEL_URL`
- `AUTOVPN_PYTHON_PACKAGE`
- `AUTOVPN_PIP_INDEX_URL`
- `AUTOVPN_PIP_EXTRA_INDEX_URL`
- `AUTOVPN_NO_INSTALL`
- `AUTOVPN_FORCE_INSTALL`
- `AUTOVPN_ALLOW_VERSION_MISMATCH`
- `AUTOVPN_PYTHON_CLI`
- `AUTOVPN_CLI_SHELL`
- `AUTOVPN_BACKEND`
- `AUTOVPN_PIPELINE_BACKEND`
- `AUTOVPN_STAGE_BACKEND_EXTRACT`
- `AUTOVPN_STAGE_BACKEND_DEDUPE`
- `AUTOVPN_STAGE_BACKEND_SPEEDTEST`
- `AUTOVPN_STAGE_BACKEND_AVAILABILITY`
- `AUTOVPN_STAGE_BACKEND_POSTPROCESS`
- `AUTOVPN_STAGE_BACKEND_RENDER`
- `AUTOVPN_STAGE_BACKEND_OBFUSCATE`
- `AUTOVPN_STAGE_BACKEND_DEPLOY`
- `AUTOVPN_STAGE_BACKEND_VERIFY`
- `AUTOVPN_DOCTOR_BACKEND`
- `AUTOVPN_PROFILE_BACKEND`
- `AUTOVPN_ARTIFACTS_BACKEND`
- `AUTOVPN_JOBS_BACKEND`
- `VPN_AUTOMATION_RUNTIME_ROOT`
- `VPN_AUTOMATION_PROFILE_PATH`
- `VPN_AUTOMATION_ARTIFACTS_ROOT`
- `VPN_AUTOMATION_UPSTREAM_PROXY`
