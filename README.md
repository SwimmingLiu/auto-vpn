# AutoVPN

[![Release](https://img.shields.io/github/v/release/SwimmingLiu/auto-vpn?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
[![Downloads](https://img.shields.io/github/downloads/SwimmingLiu/auto-vpn/total?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-0e7490?style=flat-square)]()
[![CI](https://github.com/SwimmingLiu/auto-vpn/actions/workflows/release-electron.yml/badge.svg)](https://github.com/SwimmingLiu/auto-vpn/actions)

![AutoVPN desktop intro](assets/intro.png)

AutoVPN turns VPN node sources into tested subscription endpoints. It can run as an Electron desktop app, a headless Linux/CI command, or an Agent-facing CLI, then optionally deploys the result to Cloudflare Pages.

## Features

- Extract, dedupe, speed-test, availability-test, render, obfuscate, deploy, and verify nodes.
- Desktop workspace for normal users; `autovpn` CLI for servers, CI, and Agents.
- Recoverable runs with SQLite checkpoints and runtime files under `~/.auto-vpn/`.
- GitHub Release packaging for macOS, Linux, Windows, Python CLI, and npm CLI tarball.

## Tech Stack

| Layer | Stack |
| --- | --- |
| Desktop | Electron 37 |
| CLI | Node.js `>=22.5.0`, Python 3.12 fallback |
| Backend | Node-first v3 pipeline, Python compatibility backend |
| Runtime state | `~/.auto-vpn/profile.toml`, SQLite checkpoints |
| Automation | Mihomo, Playwright, Cloudflare Wrangler |
| Tests | pytest, node:test, Playwright-backed renderer checks |

## Installation

Download the latest installer from [GitHub Releases](https://github.com/SwimmingLiu/auto-vpn/releases). The current release is [AutoVPN v1.4.0](https://github.com/SwimmingLiu/auto-vpn/releases/tag/v1.4.0); replace `<version>` with `1.4.0`.

| Platform | Assets |
| --- | --- |
| macOS | `AutoVPN-<version>-arm64.dmg`, `AutoVPN-<version>-x64.dmg` |
| Linux | `AutoVPN-<version>-amd64.deb`, `AutoVPN-<version>-arm64.deb`, `AutoVPN-<version>-x86_64.rpm`, `AutoVPN-<version>-aarch64.rpm` |
| Windows | `AutoVPN-<version>-x64-setup.exe`, `AutoVPN-<version>-x64-portable.exe`, `AutoVPN-<version>-arm64-setup.exe`, `AutoVPN-<version>-arm64-portable.exe` |
| CLI | npm package `@swimmingliu/autovpn`, release assets `swimmingliu-autovpn-<version>.tgz`, `vpn_subscription_automation-<version>-py3-none-any.whl`, `vpn_subscription_automation-<version>.tar.gz` |

Desktop installers do not install the terminal `autovpn` command. Install the CLI separately for Linux servers, headless hosts, CI, or Agents.

## CLI Quickstart

The v3 npm CLI is the recommended Agent/server entrypoint. It exposes `autovpn`, defaults pipeline runs to the pure Node backend, and keeps `AUTOVPN_BACKEND=python` as rollback.

```bash
npx -y @swimmingliu/autovpn@1.4.0 --version
npm install -g @swimmingliu/autovpn@1.4.0
autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --output human
autovpn run --project-root /opt/autovpn/vpn-subscription-automation --skip-deploy --skip-verify --output jsonl
```

Detached runs are safer for long Agent jobs:

```bash
autovpn run --project-root /opt/autovpn/vpn-subscription-automation --skip-deploy --skip-verify --detach --json
autovpn status --project-root /opt/autovpn/vpn-subscription-automation --json
autovpn logs --project-root /opt/autovpn/vpn-subscription-automation --tail 200
autovpn stop --project-root /opt/autovpn/vpn-subscription-automation
```

Useful runtime flags:

```bash
VPN_AUTOMATION_RUNTIME_ROOT=/srv/autovpn autovpn run --project-root /opt/autovpn/vpn-subscription-automation --output jsonl
AUTOVPN_NO_PYTHON=1 autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --output json
AUTOVPN_BACKEND=python autovpn run --project-root /opt/autovpn/vpn-subscription-automation --output jsonl
```

For commands that still need Python fallback, the npm wrapper resolves `AUTOVPN_PYTHON_CLI`, a matching PATH `autovpn`, or a wrapper-managed virtualenv. Set `AUTOVPN_NO_INSTALL=1` in locked-down CI.

Pure Python install remains available:

```bash
python3.12 -m pip install --user pipx
python3.12 -m pipx ensurepath
pipx install https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/vpn_subscription_automation-<version>-py3-none-any.whl
python -m venv .venv
```

If the public npm registry is unavailable, install the release tarball directly:

```bash
npm install -g https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/swimmingliu-autovpn-<version>.tgz
```

## Project Structure

```text
vpn-subscription-automation/
├── electron/          # Electron app, runtime, packaging
├── npm/autovpn-cli/   # Node-first CLI package
├── src/               # Python compatibility backend
├── templates/         # Cloudflare worker templates
├── tests/             # Python tests
├── electron/tests/    # Electron and renderer tests
├── scripts/           # Run, monitor, package, release helpers
├── docs/              # Headless, Agent, and implementation docs
├── assets/            # README media
├── state/             # Optional ignored local seed profile
├── artifacts/         # Ignored local outputs
└── dist-electron/     # Ignored packaged app outputs
```

## Development

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
npm install
npm ci --prefix npm/autovpn-cli
npx playwright install chromium
```

Run locally:

```bash
npm run electron:dev
autovpn profile summary --project-root /opt/autovpn/vpn-subscription-automation --json
autovpn artifacts latest --project-root /opt/autovpn/vpn-subscription-automation
npm test --prefix npm/autovpn-cli
```

Package and smoke-test the npm CLI from source:

```bash
(cd npm/autovpn-cli && npm pack --pack-destination .)
npx -y ./npm/autovpn-cli/*.tgz doctor --project-root "$PWD" --output json
```

Run tests:

```bash
./scripts/run_pytest.sh tests -v
npm run test:electron
npm run test:all
```

## Runtime Configuration

AutoVPN reads and writes runtime files under `~/.auto-vpn/` by default:

- profile: `~/.auto-vpn/profile.toml`
- artifacts: `~/.auto-vpn/artifacts/`
- detached job logs: `~/.auto-vpn/jobs/`

Set `VPN_AUTOMATION_RUNTIME_ROOT` to move them together.

## Release Packaging

`.github/workflows/release-electron.yml` packages AutoVPN when a GitHub Release is published, a matching version tag is pushed, or a release rebuild is manually dispatched. It validates versions, runs tests, builds native installers, uploads CLI assets, and rewrites release notes.
The release workflow also publishes `@swimmingliu/autovpn` to npm with provenance, using either npm trusted publishing/OIDC or the `NPM_TOKEN` repository secret.

```bash
npm run package:electron
AUTOVPN_PACKAGE_PLATFORM=linux AUTOVPN_PACKAGE_ARCH=x64 npm run package:electron
AUTOVPN_PACKAGE_PLATFORM=win AUTOVPN_PACKAGE_ARCH=arm64 npm run package:electron
```

The build must not report `default Electron icon is used`. The icon source is `electron/renderer/assets/vpn-auto-logo-v2-minimal.svg`, and generated icon resources must preserve transparency.

## Trust & Security

- Local-first execution keeps runtime config and pipeline state on the host.
- Cloudflare Pages deployment requires an explicit `CLOUDFLARE_API_TOKEN`.
- Release artifacts are built by GitHub Actions from the matching tag.
- App branding comes from checked-in project assets, not Electron placeholders.

## License

No license file is currently checked into this repository. Add one before distributing AutoVPN outside private/internal use.
