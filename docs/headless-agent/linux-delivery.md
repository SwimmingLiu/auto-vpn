# Linux Headless Delivery and Verification Plan

## Goal

Make AutoVPN usable on Linux servers with no screen. The supported Linux path is CLI/headless, not Electron packaging.

## Current Code Basis

Relevant files:

- `pyproject.toml`
- `src/vpn_automation/backend.py`
- `src/vpn_automation/pipeline/controller.py`
- `src/vpn_automation/pipeline/proxy_runtime.py`
- `src/vpn_automation/integrations/cloudflare.py`
- `scripts/run_backend_pipeline.sh`
- `scripts/resume_backend_pipeline.sh`
- `scripts/monitor_run.sh`
- `.github/workflows/release-electron.yml`

Important dependency note:

- Current speedtest runtime uses `mihomo`.
- README currently mentions `xray`; that should be corrected or clearly marked as outdated for Linux headless.

## Doctor Command

Add:

```bash
autovpn doctor --output human
autovpn doctor --output json
autovpn doctor --deploy --strict --output json
```

`doctor` should return pass/warn/fail checks. Failures return non-zero. `--strict` treats warnings as failures. `--deploy` makes Cloudflare deployment readiness required.

### Check Groups

#### Python Runtime

- Python version is `>=3.12`.
- Package imports work:
  - `vpn_automation.backend`
  - `vpn_automation.pipeline.controller`
  - `requests`
  - `dotenv`
  - `tomlkit`
  - `cryptography`
- `project_root` resolves through `resolve_repo_anchor()`.

#### Profile and Paths

- Profile path resolves correctly.
- `state/profile.toml` exists or can be created.
- `artifacts/` or `VPN_AUTOMATION_ARTIFACTS_ROOT` is writable.
- `templates/vmess_node.js` exists.
- `.env` presence is reported as status only.

#### Sources

- At least one enabled source has URL and key configured.
- Source iteration and timeout settings are valid.
- Keys are never printed. Output only `set` or `missing`.

#### Proxy Runtime

- `mihomo` exists and can run a version command.
- Localhost temporary port binding works.
- Current proxy environment variables are detected and reported without credentials.

#### Node and Worker Build

- `node`, `npm`, and `npx` exist.
- JavaScript obfuscation command path is available.
- `templates/share-worker/vpn.js` exists.

#### Playwright and Browser

- Node `playwright` package is installed.
- Chromium or headless shell is installed.
- Linux users are told to run:

```bash
npx playwright install --with-deps chromium-headless-shell
```

#### Network

- Speed probe URL is reachable from the host.
- At least one configured speed test URL is reachable.
- Availability target URLs are lightly checked from the host.
- Upstream/deploy proxy env values are validated without printing credentials.

#### Cloudflare

Default mode:

- Missing Cloudflare credentials are warnings.

Deploy/strict mode:

- `CLOUDFLARE_API_TOKEN` or profile token exists.
- Account ID exists if required by auth mode.
- `npx wrangler pages deploy --help` works.
- Project name, Pages URL, subscription URL, and verify URL are internally consistent.

`doctor` must not perform a real deploy.

## Linux Installation Guide

Create or update a Linux guide with this shape.

### Ubuntu/Debian System Packages

```bash
sudo apt-get update
sudo apt-get install -y \
  git curl ca-certificates build-essential \
  python3.12 python3.12-venv python3-pip \
  nodejs npm
```

### Project Install

```bash
sudo mkdir -p /opt/autovpn
sudo chown "$USER":"$USER" /opt/autovpn
git clone https://github.com/SwimmingLiu/vpn-subscription-automation.git /opt/autovpn/vpn-subscription-automation

cd /opt/autovpn/vpn-subscription-automation
python3.12 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e .[dev]
npm ci
npx playwright install --with-deps chromium-headless-shell
```

### mihomo

Install `mihomo` through the chosen distribution method and verify:

```bash
mihomo -v
```

The guide should not tell Linux users to install `xray` for the current speedtest runtime unless code changes reintroduce it.

### Profile and Env

```bash
autovpn profile show --project-root /opt/autovpn/vpn-subscription-automation
vim /opt/autovpn/vpn-subscription-automation/state/profile.toml
```

Example `.env` keys:

```env
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
VPN_AUTOMATION_UPSTREAM_PROXY=
VPN_AUTOMATION_DEPLOY_PROXY=
```

Do not include real secret values in docs.

### Validation and Run

```bash
autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --output human
autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --deploy --strict --output human
autovpn run --project-root /opt/autovpn/vpn-subscription-automation --skip-deploy --skip-verify --output human
```

Full deploy only after credentials are configured:

```bash
autovpn run --project-root /opt/autovpn/vpn-subscription-automation --output human
```

## Verification Matrix

| Layer | Goal | Command | Required |
|---|---|---|---|
| Python unit | Python behavior | `rtk ./scripts/run_pytest.sh tests -v` | Yes |
| Backend e2e | Controller flow | `rtk ./scripts/run_pytest.sh tests/e2e -v` | Yes |
| Script smoke | manual run/session scripts | `rtk ./scripts/run_pytest.sh tests/backend/test_run_script.py -v` | Yes |
| Electron/node unit | IPC, renderer, package logic | `rtk npm run test:electron` | Yes for full regression |
| Browser H5 e2e | UI behavior | `rtk node --test electron/tests/renderer-e2e.test.mjs` | Required for UI changes |
| Pixel/visual | visual regression | `rtk node --test electron/tests/renderer-visual.test.mjs` | Required for UI changes |
| Packaging | macOS DMG/icon | `rtk npm run package:electron` | Required for Electron release |
| Linux doctor | headless readiness | `autovpn doctor --strict --output json` | Required for headless |
| Linux smoke | non-deploy run | `autovpn run --skip-deploy --skip-verify` | Recommended before release |
| Deploy acceptance | Cloudflare deploy/verify | `autovpn run` | Required if release claims deploy readiness |

## CI Recommendations

Add a Linux PR workflow on `ubuntu-latest`:

```bash
python -m pip install -e .[dev]
npm ci
npx playwright install --with-deps chromium-headless-shell
./scripts/run_pytest.sh tests -v
node --test electron/tests/*.test.mjs
autovpn doctor --project-root "$PWD" --output json
```

Do not require real Cloudflare secrets in normal PR CI. Add a separate deploy acceptance job only when secrets are configured and the run is explicitly requested.

Add tests that assert:

- `doctor` classifies missing `mihomo`, `npx`, and Playwright correctly.
- `doctor --deploy` fails without Cloudflare credentials.
- `doctor` redacts source keys, Cloudflare tokens, proxy passwords, and secret URLs.
- CLI smoke does not require Electron.

## PR, Review, and Packaging

Per project `AGENTS.md`, file-changing tasks require tests, PR, review, follow-up fixes, and reruns.

Review should focus on:

- Secret leakage.
- Linux dependency accuracy.
- CLI exit codes.
- Electron compatibility.
- `mihomo`/README consistency.
- Doctor false positives and false negatives.

Packaging for headless does not have to be Electron DMG. Valid headless deliverables include:

- Python wheel/sdist.
- Source install guide.
- Docker image.
- systemd unit and install bundle.

If Electron packaging is part of the deliverable, existing macOS icon requirements still apply.

## Future Server Mode

Do not implement server mode in the Linux readiness stage.

Consider it only when there is a concrete need for:

- Remote browser dashboard.
- Multi-user operation.
- Webhook-triggered runs.
- Queueing and scheduling.
- Centralized secret storage.
- Shared API for Electron and headless clients.

Server mode should wrap the same CLI/core service layer.

## Risks

- README may mislead users by mentioning `xray` while code uses `mihomo`.
- Playwright Linux dependencies are easy to miss; use `--with-deps`.
- Missing Cloudflare credentials should not block local generation by default.
- Availability target checks are network- and region-sensitive; doctor can only validate host reachability, not node unlock success.
- Profile and artifacts may contain secrets or full node payloads. Doctor, logs, and CI artifacts must redact.
- Full Electron and visual test suites may be slow on Linux; distinguish required PR CI from final release verification while still satisfying project workflow before merge.
- Linux Electron packaging would expand scope. Keep the first Linux deliverable CLI/headless.
