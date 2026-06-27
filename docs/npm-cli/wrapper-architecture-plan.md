# npm Wrapper Architecture Plan

## Decision

Add an independent npm package at `npm/autovpn-cli`. The package name should be `@swimmingliu/autovpn`, and it should expose one bin command:

```json
{
  "bin": {
    "autovpn": "./bin/autovpn.mjs"
  }
}
```

The wrapper launches the Python `autovpn` console script. It must not reimplement AutoVPN commands.

## Proposed File Structure

```text
npm/autovpn-cli/
├── package.json
├── README.md
├── LICENSE
├── bin/
│   └── autovpn.mjs
├── lib/
│   ├── runner.mjs
│   ├── python.mjs
│   ├── cache.mjs
│   ├── install-python-cli.mjs
│   ├── pipx.mjs
│   ├── uv.mjs
│   └── errors.mjs
└── test/
    ├── runner.test.mjs
    ├── python.test.mjs
    └── smoke.test.mjs
```

Responsibilities:

- `package.json`: npm metadata, `bin`, version, engines, files, scripts.
- `bin/autovpn.mjs`: thin executable entry.
- `lib/runner.mjs`: command resolution, process spawning, exit code propagation.
- `lib/python.mjs`: Python discovery and `>=3.12` validation.
- `lib/cache.mjs`: platform-specific cache directories and install locks.
- `lib/install-python-cli.mjs`: wheel or package install into the selected backend.
- `lib/pipx.mjs`: optional pipx backend.
- `lib/uv.mjs`: optional uvx backend.
- `lib/errors.mjs`: consistent wrapper diagnostics.
- `test/*.test.mjs`: unit and smoke tests using `node:test`.

## Command Resolution Order

MVP order:

1. `AUTOVPN_PYTHON_CLI`
2. Real existing `autovpn` on PATH, excluding the npm wrapper itself, only if `autovpn --version` matches the npm package version
3. Wrapper-managed venv

Enhanced order:

1. `AUTOVPN_PYTHON_CLI`
2. Real existing `autovpn` on PATH, only if its version matches the npm package version
3. pipx-managed `autovpn`
4. uvx execution
5. Wrapper-managed venv

The wrapper must avoid recursive execution when the npm bin command is also named `autovpn`.
If the PATH command version differs, the wrapper must ignore it and install or use the managed backend. A mismatch can be allowed only through an explicit override such as `AUTOVPN_ALLOW_VERSION_MISMATCH=1`.

## Python Discovery

Linux/macOS:

```text
python3.12
python3
python
```

Windows:

```text
py -3.12
python
python3
```

The selected interpreter must report Python `>=3.12`.

## Cache Layout

Default cache locations:

```text
macOS:   ~/Library/Caches/autovpn/npm-wrapper/
Linux:   ~/.cache/autovpn/npm-wrapper/
Windows: %LOCALAPPDATA%\AutoVPN\npm-wrapper\
```

Internal structure:

```text
<cache>/
├── state.json
├── locks/
│   └── install-<version>.lock
└── venvs/
    └── <version>/
```

Use an install lock to prevent concurrent `npx` invocations from corrupting the same venv.

## Environment Variables

Supported overrides:

```bash
AUTOVPN_PYTHON_CLI=/opt/autovpn/bin/autovpn
AUTOVPN_CACHE_DIR=/var/cache/autovpn-user
AUTOVPN_WHEEL_URL=file:///mnt/wheels/vpn_subscription_automation-1.3.0-py3-none-any.whl
AUTOVPN_PYTHON_PACKAGE=vpn-subscription-automation==1.3.0
AUTOVPN_PIP_INDEX_URL=https://pypi.company.local/simple
AUTOVPN_PIP_EXTRA_INDEX_URL=https://mirror.example/simple
AUTOVPN_PYTHON_BACKEND=venv
AUTOVPN_NO_INSTALL=1
AUTOVPN_FORCE_INSTALL=1
```

## package.json Baseline

```json
{
  "name": "@swimmingliu/autovpn",
  "version": "1.3.0",
  "description": "npm wrapper for the AutoVPN Python CLI",
  "type": "module",
  "bin": {
    "autovpn": "./bin/autovpn.mjs"
  },
  "files": [
    "bin/",
    "lib/",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=20"
  },
  "os": [
    "darwin",
    "linux",
    "win32"
  ],
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "pack:check": "npm pack --dry-run",
    "smoke": "node ./bin/autovpn.mjs doctor --output json"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/SwimmingLiu/auto-vpn.git",
    "directory": "npm/autovpn-cli"
  },
  "license": "UNLICENSED",
  "private": false
}
```

`UNLICENSED` is acceptable only while distributing the npm wrapper as an internal GitHub Release tarball. Before publishing publicly to the npm registry, choose and document the repository license, then update this field accordingly.

## Runtime Rules

- Use `child_process.spawn` with argument arrays and `shell: false`.
- Use `stdio: "inherit"` for normal proxy execution.
- Preserve Python process exit code exactly.
- Do not print wrapper banners to stdout before JSON/JSONL commands.
- Write wrapper diagnostics to stderr only.
- Do not default to `sudo`.
- Do not write into the project root or npm package installation directory.

## MVP Tests

```bash
npm ci --prefix npm/autovpn-cli
npm test --prefix npm/autovpn-cli
npm pack --dry-run --prefix npm/autovpn-cli
node npm/autovpn-cli/bin/autovpn.mjs --help
node npm/autovpn-cli/bin/autovpn.mjs doctor --output json
```

Test cases:

- `AUTOVPN_PYTHON_CLI` is honored.
- Missing Python produces a clear stderr error.
- Python exit code `1` and `2` are preserved.
- Path with spaces is passed as one argument.
- `profile save` receives stdin unchanged through the wrapper.
- Python stderr is passed through without wrapper rewriting.
- Recursive `autovpn` detection does not call the npm bin itself.
- A stale PATH `autovpn` is rejected unless `AUTOVPN_ALLOW_VERSION_MISMATCH=1` is set.
- `AUTOVPN_NO_INSTALL=1` prevents venv creation.
- `AUTOVPN_WHEEL_URL=file://...` is passed to pip install.

## Post-MVP Enhancements

- Add `pipx` backend.
- Add `uvx` backend.
- Add wrapper-only `--wrapper-doctor` for install diagnostics.
- Add checksum verification for GitHub Release wheel downloads.
- Add npm workspace integration only after confirming it does not affect Electron packaging.
