# AutoVPN

[![Release](https://img.shields.io/github/v/release/SwimmingLiu/auto-vpn?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
[![Downloads](https://img.shields.io/github/downloads/SwimmingLiu/auto-vpn/total?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-0e7490?style=flat-square)
[![Release CI](https://github.com/SwimmingLiu/auto-vpn/actions/workflows/release-electron.yml/badge.svg?event=push)](https://github.com/SwimmingLiu/auto-vpn/actions/workflows/release-electron.yml)

![AutoVPN desktop intro](assets/intro.png)

AutoVPN turns VPN node sources into tested subscription endpoints. It can run
as an Electron desktop app, a headless Linux/CI command, an Agent-facing CLI,
or a token-protected server Web UI, then optionally deploys the result to
Cloudflare Pages.

## Tech Stack

| Layer | Stack |
| --- | --- |
| Desktop | Electron 37 |
| CLI / server | Node.js `>=22.5.0` |
| Backend | Node v3 pipeline |
| Runtime state | `$HOME/.auto-vpn/profile.toml`, SQLite checkpoints |
| Automation | Mihomo, Playwright, Cloudflare Wrangler |
| Tests | node:test, Playwright-backed renderer checks |

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
export PROJECT_ROOT=/path/to/autovpn
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

To operate AutoVPN through a browser on a server, start the built-in Web UI:

```bash
autovpn serve --project-root "$PROJECT_ROOT"
```

By default the server listens on `127.0.0.1:8765` and prints a one-time token
URL. For remote access, put it behind SSH port forwarding or a reverse proxy.
Binding to a non-loopback interface requires an explicit token or an explicit
no-auth override:

```bash
autovpn serve --project-root "$PROJECT_ROOT" --host 0.0.0.0 --port 8765 \
  --token "$AUTOVPN_SERVER_TOKEN"
```

Use `--no-auth` only on trusted private networks or behind another
authentication layer.

If npm is unavailable, install the CLI tarball from the latest GitHub Release:

```bash
export AUTOVPN_VERSION=1.6.7
npm install -g \
  "https://github.com/SwimmingLiu/auto-vpn/releases/download/v${AUTOVPN_VERSION}/swimmingliu-autovpn-${AUTOVPN_VERSION}.tgz"
```

Set `AUTOVPN_NO_INSTALL=1` in locked-down CI to prevent managed npm tool
installation.

AutoVPN manages npm runtime tools such as `javascript-obfuscator` and `wrangler`
under `$HOME/.auto-vpn/tools/npm/`. Doctor/preflight checks verify those tools
before a run, and runtime stages use the managed executables instead of relying
on a source checkout's `node_modules`. AutoVPN does not silently install
unmanaged OS-level dependencies such as Node.js, npm, or Mihomo; install those
explicitly and rerun `autovpn doctor`.

Runtime flags can be set per command:

```bash
VPN_AUTOMATION_RUNTIME_ROOT=/srv/autovpn autovpn run --project-root /opt/autovpn --output jsonl
AUTOVPN_NO_INSTALL=1 autovpn doctor --project-root /opt/autovpn --output json
```

## Project Structure

```text
autovpn/
├── electron/          # Electron app, runtime, packaging
├── npm/autovpn-cli/   # Node CLI package
├── templates/         # Cloudflare worker templates
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
- managed npm runtime tools: `$HOME/.auto-vpn/tools/npm/`

The desktop app and CLI use the same default runtime root. When a packaged
desktop app starts and `$HOME/.auto-vpn/profile.toml` does not exist, it can
migrate an older Electron profile into the unified runtime profile. If both
files exist, `$HOME/.auto-vpn/profile.toml` remains the source of truth.

Set `VPN_AUTOMATION_RUNTIME_ROOT` to move them together.

## License

AutoVPN is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0-only). See [LICENSE](LICENSE).
