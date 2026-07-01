# AutoVPN CLI

Node-first npm CLI for AutoVPN headless and Agent workflows.

## Usage

```bash
npx -y @swimmingliu/autovpn@1.4.0 doctor --project-root . --output json
npm install -g @swimmingliu/autovpn@1.4.0
autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
```

GitHub Release tarballs remain available for pinned/offline installs:

```bash
npm install -g https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/swimmingliu-autovpn-<version>.tgz
```

For Agent-friendly JSONL output, prefer foreground runs:

```bash
autovpn doctor --project-root . --output json
autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
autovpn artifacts latest --project-root .
```

## Runtime Shape

The CLI is currently Node-first with explicit Python rollback:

- Node.js handles `--help`, `--version`, argument validation, `doctor --output json`, `profile summary --json`, `artifacts latest/list/preview`, `status --json`, `logs`, read-only `jobs` commands, and detached job management.
- Node is the default backend for pipeline actions. Detached run/resume/retry workers spawn the Node CLI worker.
- Plain Cloudflare Pages deploy, primary blocked-project fallback, share-project `SUB` sync, share-project fallback, custom-domain binding, custom-domain DNS upsert, and verify are Node-native. Python backend and stage fallback remain available for rollback.

Node-orchestrated foreground run:

```bash
autovpn run --project-root . --output jsonl
```

Current Node backend notes:

- Detached job management runs in Node for `run --detach`, `jobs resume --detach`, and `jobs retry --detach`; detached run/resume/retry workers also use the Node CLI worker.
- Non-detached `retry-stage` runs through the Node backend for retryable artifact stages from `speedtest` through `verify`; non-detached `resume pipeline`, `resume speedtest`, and `run --resume-latest` continue existing sessions through the Node backend.
- Add `--skip-deploy --skip-verify` when you want an offline Node pipeline check.
- Plain Node foreground deploy/verify runs use Node for Wrangler deploy, primary blocked-project fallback, share-project sync/fallback, custom-domain binding, custom-domain DNS upsert, and verify.
- Deploy and verify can be rolled back with `AUTOVPN_STAGE_BACKEND_DEPLOY=python` and `AUTOVPN_STAGE_BACKEND_VERIFY=python`.
- `AUTOVPN_NO_PYTHON=1` disables implicit Python backend resolution and default Python runtime stage fallback. Use it as a v3 readiness gate. Empty offline runs now complete in Node, and Node has direct HTTP speedtest and availability runtimes. Node also has opt-in Mihomo-backed paths: set `AUTOVPN_SPEEDTEST_RUNTIME=mihomo` for controller delay probing and candidate downloads through the local Mihomo proxy, and set `AUTOVPN_AVAILABILITY_RUNTIME=mihomo` to check provider availability through the same per-node proxy runtime.
- Project `.env` is loaded before resolving profile and artifact paths. Explicit process environment values still win over `.env`.

Fallback flags for migrated commands:

```bash
AUTOVPN_CLI_SHELL=python autovpn <args>
AUTOVPN_BACKEND=python autovpn run --project-root . --output jsonl
AUTOVPN_DOCTOR_BACKEND=python autovpn doctor --output json
AUTOVPN_PROFILE_BACKEND=python autovpn profile summary --json
AUTOVPN_ARTIFACTS_BACKEND=python autovpn artifacts latest
```

Job state, logs, stop, detached run, detached resume, and detached retry commands are Node-owned in v3 and intentionally ignore the old `AUTOVPN_JOBS_BACKEND` rollback flag.

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
- `VPN_AUTOMATION_RUNTIME_ROOT`
- `VPN_AUTOMATION_PROFILE_PATH`
- `VPN_AUTOMATION_ARTIFACTS_ROOT`
- `VPN_AUTOMATION_UPSTREAM_PROXY`
