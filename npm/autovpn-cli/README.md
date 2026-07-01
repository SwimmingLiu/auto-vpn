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

- Node.js handles `--help`, `--version`, argument validation, `doctor --output json`, `profile summary --json`, `artifacts latest/list/preview`, `status --json`, `logs`, and read-only `jobs` commands.
- Python remains the default backend for high-risk pipeline actions such as `run`, `retry-stage`, `resume`, detached job creation, stop, speedtest, deploy, and verify, selected through the backend adapter boundary.
- The experimental Node backend can orchestrate foreground pipeline runs when explicitly selected with `AUTOVPN_BACKEND=node`. Deploy and verify remain disabled by default and require explicit Python stage fallback while the native Node Cloudflare implementation is still being migrated.

Experimental Node-orchestrated dry run:

```bash
AUTOVPN_BACKEND=node \
autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
```

Current Node backend limits:

- `--detach`, `retry-stage`, and `resume` remain Python-backed.
- A Node foreground non-deploy run requires both `--skip-deploy` and `--skip-verify`.
- Plain Node foreground deploy/verify runs use Node for Wrangler deploy and verify. Deploys that need custom-domain binding, share-project sync, or blocked-project fallback require `AUTOVPN_STAGE_BACKEND_DEPLOY=python` and an absolute `AUTOVPN_PYTHON_CLI` path. Verify can be rolled back with `AUTOVPN_STAGE_BACKEND_VERIFY=python`.
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
- `AUTOVPN_DOCTOR_BACKEND`
- `AUTOVPN_PROFILE_BACKEND`
- `AUTOVPN_ARTIFACTS_BACKEND`
- `AUTOVPN_JOBS_BACKEND`
- `VPN_AUTOMATION_RUNTIME_ROOT`
- `VPN_AUTOMATION_PROFILE_PATH`
- `VPN_AUTOMATION_ARTIFACTS_ROOT`
- `VPN_AUTOMATION_UPSTREAM_PROXY`
