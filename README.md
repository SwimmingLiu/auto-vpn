# AutoVPN

[![Release](https://img.shields.io/github/v/release/SwimmingLiu/auto-vpn?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
[![Downloads](https://img.shields.io/github/downloads/SwimmingLiu/auto-vpn/total?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-0e7490?style=flat-square)]()
[![CI](https://github.com/SwimmingLiu/auto-vpn/actions/workflows/release-electron.yml/badge.svg)](https://github.com/SwimmingLiu/auto-vpn/actions)

![AutoVPN desktop intro](assets/intro.png)

AutoVPN is a desktop control center for turning raw VPN node sources into tested subscription endpoints. It keeps the pipeline local, verifies node quality and service availability, then publishes the final Cloudflare Pages worker when deployment credentials are available.

## Features

- Six focused workspace pages for overview, runs, results, subscriptions, logs, and settings.
- Automated node extraction, deduplication, Xray connectivity checks, speed tests, and availability filters.
- Cloudflare Pages deployment with worker rendering, transformation, obfuscation, packaging, and verification.
- Recoverable runs backed by SQLite checkpoints and `state/profile.toml`.
- Multi-platform Electron packaging with project-owned transparent icon assets.

## Tech Stack

| Layer | Stack |
| --- | --- |
| Desktop | Electron 37, native HTML/CSS/ES modules |
| Backend | Python 3.12 under `src/vpn_automation` |
| Runtime state | TOML profile, SQLite checkpoints |
| Automation | Xray, Playwright, Cloudflare Wrangler |
| Packaging | electron-builder for DMG, DEB, RPM, NSIS, portable EXE |
| Tests | pytest, node:test, Playwright-backed renderer checks |

## Installation

Download the latest installer from [GitHub Releases](https://github.com/SwimmingLiu/auto-vpn/releases).

| Platform | Assets |
| --- | --- |
| macOS | `AutoVPN-<version>-arm64.dmg`, `AutoVPN-<version>-x64.dmg` |
| Linux | `AutoVPN-<version>-amd64.deb`, `AutoVPN-<version>-x86_64.rpm`, `AutoVPN-<version>-arm64.deb`, `AutoVPN-<version>-aarch64.rpm` |
| Windows | `AutoVPN-<version>-x64-setup.exe`, `AutoVPN-<version>-x64-portable.exe`, `AutoVPN-<version>-arm64-setup.exe`, `AutoVPN-<version>-arm64-portable.exe` |

The app bundles the Electron shell, runtime seed files, Python dependencies, browser probe runtime, and worker template. Pipeline stages that call external tools still require those tools locally, including `xray` and Cloudflare Wrangler/npm tooling.

## Project Structure

```text
vpn-subscription-automation/
├── electron/          # Electron main, preload, renderer, runtime, packaging
├── src/               # Python automation backend
├── templates/         # Worker templates
├── tests/             # Python tests
├── electron/tests/    # Electron and renderer tests
├── scripts/           # Run, resume, monitor, and release helpers
├── docs/              # Notes and implementation plans
├── assets/            # README media
├── state/             # Local runtime profile, ignored by git
├── artifacts/         # Pipeline outputs, ignored by git
└── dist-electron/     # Packaged app outputs, ignored by git
```

## Development

Install local dependencies:

```bash
cd ~/data/VPN/vpn-subscription-automation
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
npm install
npx playwright install chromium
brew install xray
```

Run the desktop app:

```bash
npm run electron:dev
```

Run the backend pipeline:

```bash
./scripts/run_backend_pipeline.sh --dry-run
./scripts/run_backend_pipeline.sh --with-deploy --with-verify
./scripts/monitor_run.sh --once
```

Run tests:

```bash
./scripts/run_pytest.sh tests -v
npm run test:electron
npm run test:all
```

Build local packages:

```bash
npm run package:electron
AUTOVPN_PACKAGE_PLATFORM=linux AUTOVPN_PACKAGE_ARCH=x64 npm run package:electron
AUTOVPN_PACKAGE_PLATFORM=win AUTOVPN_PACKAGE_ARCH=arm64 npm run package:electron
```

## Runtime Configuration

AutoVPN reads and writes one local runtime profile:

- `~/data/VPN/vpn-subscription-automation/state/profile.toml`

Packaged builds seed that profile from `electron/runtime/default-profile.toml` or a generated `electron/runtime/bundled-profile.toml`. The generated bundled profile is build output; do not edit it by hand.

## Release Packaging

`.github/workflows/release-electron.yml` packages AutoVPN when a GitHub Release is published, a matching version tag is pushed, or a release rebuild is manually dispatched. The workflow validates the tag against `package.json`, runs the shared test gate, builds native macOS/Linux/Windows installers, uploads release assets, and rewrites the release notes.

The local and CI packaging entrypoint is the same:

```bash
npm run package:electron
```

The build must not report `default Electron icon is used`. The icon source is `electron/renderer/assets/vpn-auto-logo-v2-minimal.svg`, and generated icon resources must preserve transparency.

## Trust & Security

- Local-first execution keeps runtime config and pipeline state on the host.
- Cloudflare deployment requires an explicit `CLOUDFLARE_API_TOKEN`.
- Release artifacts are built by GitHub Actions from the matching tag.
- App branding comes from checked-in project assets, not Electron placeholders.

## License

No license file is currently checked into this repository. Add one before distributing AutoVPN outside private/internal use.
