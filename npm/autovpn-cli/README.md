# AutoVPN CLI

Node-first npm CLI for AutoVPN headless and Agent workflows.

## Usage

```bash
npx -y https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/swimmingliu-autovpn-<version>.tgz doctor --project-root . --output json
npm install -g https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/swimmingliu-autovpn-<version>.tgz
autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
```

The public npm registry package is not enabled in Phase 1. Use the GitHub Release `.tgz` until license, provenance, and idempotent publishing gates are complete.

## Runtime Shape

The CLI is currently hybrid:

- Node.js handles `--help`, `--version`, argument validation, `doctor --output json`, `profile summary --json`, `artifacts latest/list/preview`, `status --json`, `logs`, and read-only `jobs` commands.
- Python remains the backend for high-risk pipeline actions such as `run`, `retry-stage`, `resume`, detached job creation, stop, speedtest, deploy, and verify, selected through the backend adapter boundary.

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
- `AUTOVPN_DOCTOR_BACKEND`
- `AUTOVPN_PROFILE_BACKEND`
- `AUTOVPN_ARTIFACTS_BACKEND`
- `AUTOVPN_JOBS_BACKEND`
