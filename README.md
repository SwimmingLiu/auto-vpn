# AutoVPN

[![Release](https://img.shields.io/github/v/release/SwimmingLiu/auto-vpn?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
[![Downloads](https://img.shields.io/github/downloads/SwimmingLiu/auto-vpn/total?style=flat-square&color=0e7490)](https://github.com/SwimmingLiu/auto-vpn/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-0e7490?style=flat-square)]()
[![CI](https://github.com/SwimmingLiu/auto-vpn/actions/workflows/release-electron.yml/badge.svg)](https://github.com/SwimmingLiu/auto-vpn/actions)

![AutoVPN desktop screenshot](assets/vpn-sub-所有页面.png)

AutoVPN is a local-first Electron desktop app for collecting VPN nodes, testing connectivity and regional availability, generating subscription worker assets, and deploying the final subscription endpoint to Cloudflare Pages.

## 🚀 Features

- **Six-page desktop workspace**: Chinese-only dashboard for overview, run control, results, subscription links, logs, and settings.
- **Automated node pipeline**: Extracts multiple sources, deduplicates vmess links, runs Xray connectivity checks, averages speedtest results, and filters by Gemini / ChatGPT / Claude availability.
- **Cloudflare Pages deployment**: Renders `vmess_node.js`, transforms and obfuscates the worker, packages sidecar modules, deploys to the `sub-nodes` Pages project, and verifies the final subscription URL.
- **Runtime recovery**: Stores checkpoints in SQLite `run.db`, resumes unfinished runs, and exposes script-based monitoring for long backend jobs.
- **Configurable worker build**: Uses `state/profile.toml` as the canonical runtime profile, including `[worker_build]` options for entry filenames, module output, identifier randomization, and keyword fragmentation.
- **Packaged desktop app**: Builds macOS, Linux, and Windows installers with project-derived transparent icon assets from `electron/renderer/assets/vpn-auto-logo-v2-minimal.svg`.

## ✨ Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Electron 37 |
| Renderer | Native HTML / CSS / ES modules |
| Backend | Python 3.12 package under `src/vpn_automation` |
| Runtime config | TOML profile + SQLite checkpoints |
| Automation | Xray, Playwright, Cloudflare Wrangler |
| Packaging | electron-builder DMG / AppImage / DEB / RPM / NSIS / portable |
| Tests | pytest, node:test, Playwright-powered Electron tests |
| CI release | GitHub Actions on `release.published` |

## 📦 Installation

### Release Builds

Download the latest installer for your operating system and CPU from [Releases](https://github.com/SwimmingLiu/auto-vpn/releases):

- macOS Apple Silicon: `AutoVPN-<version>-arm64.dmg`
- macOS Intel: `AutoVPN-<version>-x64.dmg`
- Linux x64: `AutoVPN-<version>-x86_64.AppImage`, `AutoVPN-<version>-amd64.deb`, or `AutoVPN-<version>-x86_64.rpm`
- Linux ARM64: `AutoVPN-<version>-arm64.AppImage`, `AutoVPN-<version>-arm64.deb`, or `AutoVPN-<version>-aarch64.rpm`
- Windows x64: `AutoVPN-<version>-x64-setup.exe` or `AutoVPN-<version>-x64-portable.exe`
- Windows ARM64: `AutoVPN-<version>-arm64-setup.exe` or `AutoVPN-<version>-arm64-portable.exe`

The installer packages the Electron desktop shell, project runtime seed files, Python dependencies, browser probe runtime, and the share-worker template. Pipeline execution still expects external runtime tools such as `xray` and Cloudflare Wrangler/npm tooling to be available where those stages are used.

### Local Development Install

```bash
cd ~/data/VPN/vpn-subscription-automation
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
npm install
npx playwright install chromium
brew install xray
```

Create `~/data/VPN/vpn-subscription-automation/.env` with the Cloudflare token used by deploy stages:

```env
CLOUDFLARE_API_TOKEN=...
```

## 📁 Project Structure

```text
vpn-subscription-automation/
├── electron/                    # Electron main, preload, renderer, packaging runtime
│   ├── build/package.mjs         # Packaging pipeline and icon generation
│   ├── renderer/                 # Desktop UI source
│   └── runtime/                  # Packaged seed profile and staged runtime dependencies
├── src/vpn_automation/           # Python backend and pipeline modules
├── templates/                    # Worker templates
├── tests/                        # Python unit, integration, and e2e tests
├── electron/tests/               # Electron, renderer, and packaging tests
├── scripts/                      # Manual run, resume, and monitor helpers
├── docs/                         # Deployment notes and implementation plans
├── assets/                       # README screenshots
├── state/                        # Local runtime profile, ignored by git
├── artifacts/                    # Pipeline outputs, ignored by git
└── dist-electron/                # Electron build outputs, ignored by git
```

## 🔧 Development

Run the desktop app:

```bash
cd ~/data/VPN/vpn-subscription-automation
npm run electron:dev
```

Run the backend pipeline without Electron:

```bash
cd ~/data/VPN/vpn-subscription-automation
./scripts/run_backend_pipeline.sh
```

Preview the backend plan without starting network work:

```bash
cd ~/data/VPN/vpn-subscription-automation
./scripts/run_backend_pipeline.sh --dry-run
```

Deploy and verify the subscription worker:

```bash
cd ~/data/VPN/vpn-subscription-automation
./scripts/run_backend_pipeline.sh --with-deploy --with-verify
```

Monitor the latest run:

```bash
cd ~/data/VPN/vpn-subscription-automation
./scripts/monitor_run.sh --once
```

Run tests:

```bash
cd ~/data/VPN/vpn-subscription-automation
./scripts/run_pytest.sh tests -v
npm run test:electron
npm run test:all
```

Package the desktop app for the current host OS and CPU:

```bash
cd ~/data/VPN/vpn-subscription-automation
npm run package:electron
```

Override the target platform and CPU when the host can build that target:

```bash
AUTOVPN_PACKAGE_PLATFORM=linux AUTOVPN_PACKAGE_ARCH=x64 npm run package:electron
AUTOVPN_PACKAGE_PLATFORM=win AUTOVPN_PACKAGE_ARCH=arm64 npm run package:electron
```

Default local macOS output:

- `dist-electron/mac-<arch>/AutoVPN.app`
- `dist-electron/AutoVPN-<version>-<arch>.dmg`

## ⚙️ Runtime Configuration

AutoVPN uses one canonical runtime profile:

- `~/data/VPN/vpn-subscription-automation/state/profile.toml`

The file is local runtime state and is ignored by git. Electron and the Python backend both read and write this TOML profile. When running from `.worktrees/`, profile resolution still anchors to the main repository `state/profile.toml`.

The packaged seed profile is generated during packaging:

- `electron/runtime/default-profile.toml` is the tracked fallback seed.
- `electron/runtime/bundled-profile.toml` is generated by `electron/build/package.mjs`.
- If `state/profile.toml` exists, it is copied into `bundled-profile.toml`; otherwise the default seed is used.

Do not edit `electron/runtime/bundled-profile.toml` by hand.

## ☁️ Cloudflare Pages Model

The production deploy target is `sub-nodes`. The deploy flow is:

1. Render `artifacts/<run>/vmess_node.js`.
2. Transform it into `artifacts/<run>/worker_transformed.js`.
3. Obfuscate it into `artifacts/<run>/_worker.js`.
4. Package `artifacts/<run>/pages_bundle/_worker.js`, `modules/*.js`, and `manifest.json`.
5. Deploy with `npx wrangler pages deploy <pages_bundle> --project-name <project_name> --branch main`.

The explicit `--branch main` is required because `https://sub-nodes.pages.dev` follows the Production deployment, not preview branches.

## 🚢 Release Packaging

`.github/workflows/release-electron.yml` runs after a GitHub Release is published. It checks out the release tag, installs Node.js 24 and Python 3.12, runs the shared test gate once on Ubuntu, then builds native installer matrices for macOS Apple Silicon, macOS Intel, Linux x64, Linux ARM64, Windows x64, and Windows ARM64. Each matrix job uploads its `dist-electron` assets back to the release.

The CI packaging path intentionally uses the same command as local builds:

```bash
npm run package:electron
```

Matrix jobs select their target with `AUTOVPN_PACKAGE_PLATFORM` and `AUTOVPN_PACKAGE_ARCH`, mirroring the local override variables.

The build must not report `default Electron icon is used`. The icon source is `electron/renderer/assets/vpn-auto-logo-v2-minimal.svg`, and generated icon resources must preserve the transparent background.

## 😇 Trust & Security

- **Local-first runtime**: The desktop app runs the pipeline locally and stores runtime config in `state/profile.toml`.
- **Explicit deploy credentials**: Cloudflare deployment requires `CLOUDFLARE_API_TOKEN`; without it, deploy stages are blocked.
- **Auditable release builds**: Release packaging runs in GitHub Actions and uploads generated macOS, Linux, and Windows installers to the matching release.
- **Project-derived branding**: The packaged app icon is generated from an in-repo SVG, never from the default Electron placeholder.

## 📜 License

No license file is currently checked into this repository. Add one before distributing AutoVPN outside private/internal use.
