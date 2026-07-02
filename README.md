# AutoVPN

[![Release](https://img.shields.io/github/v/release/SwimmingLiu/auto-vpn?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
[![Downloads](https://img.shields.io/github/downloads/SwimmingLiu/auto-vpn/total?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-0e7490?style=flat-square)
[![Release CI](https://github.com/SwimmingLiu/auto-vpn/actions/workflows/release-electron.yml/badge.svg?event=push)](https://github.com/SwimmingLiu/auto-vpn/actions/workflows/release-electron.yml)

![AutoVPN desktop intro](assets/intro.png)

AutoVPN turns VPN node sources into tested subscription endpoints. It can run
as an Electron desktop app, a headless Linux/CI command, or an Agent-facing CLI,
then optionally deploys the result to Cloudflare Pages.

## Tech Stack

| Layer | Stack |
| --- | --- |
| Desktop | Electron 37 |
| CLI | Node.js `>=22.5.0`, Python 3.12 fallback |
| Backend | Node-first v3 pipeline, Python compatibility backend |
| Runtime state | `$HOME/.auto-vpn/profile.toml`, SQLite checkpoints |
| Automation | Mihomo, Playwright, Cloudflare Wrangler |
| Tests | pytest, node:test, Playwright-backed renderer checks |

## Installation

Download the latest desktop installer from [GitHub Releases](https://github.com/SwimmingLiu/auto-vpn/releases/latest).

| Platform | Assets |
| --- | --- |
| macOS | `.dmg` for Apple Silicon or Intel |
| Linux | `.deb` or `.rpm` for x64 or ARM64 |
| Windows | setup installer or portable `.exe` for x64 or ARM64 |

The desktop installer and terminal CLI are separate. Install the CLI only when
you need to run AutoVPN on a server, in CI, or from an Agent.

```bash
npm install -g @swimmingliu/autovpn
export PROJECT_ROOT=/path/to/vpn-subscription-automation
autovpn --version
autovpn doctor --project-root "$PROJECT_ROOT" --output human
autovpn run --project-root "$PROJECT_ROOT" --skip-deploy --skip-verify \
  --output jsonl
```

For long-running jobs, start the run in detached mode and inspect it later:

```bash
autovpn run --project-root "$PROJECT_ROOT" --skip-deploy --skip-verify \
  --detach --json
autovpn status --project-root "$PROJECT_ROOT" --json
autovpn logs --project-root "$PROJECT_ROOT" --tail 200
autovpn stop --project-root "$PROJECT_ROOT"
```

If npm is unavailable, install the CLI tarball from the latest GitHub Release:

```bash
export AUTOVPN_VERSION=1.4.1
npm install -g \
  "https://github.com/SwimmingLiu/auto-vpn/releases/download/v${AUTOVPN_VERSION}/swimmingliu-autovpn-${AUTOVPN_VERSION}.tgz"
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

## Runtime Configuration

AutoVPN reads and writes runtime files under `$HOME/.auto-vpn/` by default:

- profile: `$HOME/.auto-vpn/profile.toml`
- artifacts: `$HOME/.auto-vpn/artifacts/`
- detached job logs: `$HOME/.auto-vpn/jobs/`

The desktop app and CLI use the same default runtime root. When a packaged
desktop app starts and `$HOME/.auto-vpn/profile.toml` does not exist, it can
migrate the older Electron profile from
`$HOME/Library/Application Support/vpn-subscription-automation/state/profile.toml`.
If both files exist, `$HOME/.auto-vpn/profile.toml` remains the source of truth.

Set `VPN_AUTOMATION_RUNTIME_ROOT` to move them together.

## License

Copyright (c) SwimmingLiu. All rights reserved.

AutoVPN is proprietary software. No permission is granted to use, copy, modify,
publish, distribute, sublicense, sell, offer as a service, or use this project
for commercial purposes without prior written authorization from the copyright
holder.
