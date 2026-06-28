# AutoVPN CLI

Node.js npm wrapper for the AutoVPN headless Python CLI.

## Usage

```bash
npx -y https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/swimmingliu-autovpn-<version>.tgz doctor --project-root . --output json
npm install -g https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/swimmingliu-autovpn-<version>.tgz
autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
```

The public npm registry package is not enabled in Phase 1. Use the GitHub Release `.tgz` until license, provenance, and idempotent publishing gates are complete.

## Backend Resolution

The wrapper resolves the Python backend in this order:

1. `AUTOVPN_PYTHON_CLI`
2. PATH `autovpn`, accepted only when `autovpn --version` matches this npm package version
3. wrapper-managed Python virtual environment under `AUTOVPN_CACHE_DIR` or the user cache

The wrapper forwards argv, stdin, stdout, stderr, and exit code. It does not parse AutoVPN business commands.

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
