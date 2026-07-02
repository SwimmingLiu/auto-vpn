# AutoVPN Linux Headless Guide

This guide installs and validates AutoVPN on a Linux server with terminal access only. The supported Linux surface is the `autovpn` CLI; Electron packaging remains macOS desktop-focused.

## Ubuntu/Debian Install

```bash
sudo apt-get update
sudo apt-get install -y \
  git curl ca-certificates build-essential \
  python3.12 python3.12-venv python3-pip \
  nodejs npm
```

Install Mihomo with your preferred distro package or release binary, then verify:

```bash
mihomo -v
```

Install the project:

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

## Runtime Configuration

Bootstrap the profile:

```bash
autovpn profile show --project-root /opt/autovpn/vpn-subscription-automation
autovpn profile summary --project-root /opt/autovpn/vpn-subscription-automation --json
```

Edit:

```bash
vim "$HOME/.auto-vpn/profile.toml"
```

Optional `.env`:

```env
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
VPN_AUTOMATION_UPSTREAM_PROXY=
VPN_AUTOMATION_DEPLOY_PROXY=
```

Do not place real secret values in documentation, tickets, screenshots, or Agent prompts.

## Dependency Matrix

| Dependency | Used By | Doctor Check |
|---|---|---|
| Python >= 3.12 | Python backend and CLI | `python_version`, `python_imports` |
| Mihomo | speed/connectivity runtime | `mihomo`, `localhost_port` |
| Node/npm/npx | availability probes, worker tooling | `node_binaries` |
| `javascript-obfuscator` through npx | worker obfuscation stage | `javascript_obfuscator` |
| Playwright package and Chromium/headless shell | availability checks | `playwright`, `playwright_browser` |
| Cloudflare credentials | deploy/verify stages | `cloudflare_credentials`, `cloudflare_account`, `wrangler`, `deploy_urls` |

## Validation

Run local readiness checks:

```bash
autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --output human
autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --output json
```

Run deploy readiness only after Cloudflare credentials are configured:

```bash
autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --deploy --strict --output human
```

Run without deploy first:

```bash
autovpn run --project-root /opt/autovpn/vpn-subscription-automation --skip-deploy --skip-verify --output human
autovpn artifacts latest --project-root /opt/autovpn/vpn-subscription-automation
```

Run deploy only after `doctor --deploy --strict` passes:

```bash
autovpn run --project-root /opt/autovpn/vpn-subscription-automation --output human
```

## Troubleshooting

| Symptom | Action |
|---|---|
| `mihomo` fails | Install Mihomo and ensure it is on `PATH`; run `mihomo -v`. |
| `node_binaries` fails | Install Node.js/npm and confirm `node`, `npm`, and `npx` are on `PATH`. |
| `playwright_browser` warns | Run `npx playwright install --with-deps chromium-headless-shell` from the project root. |
| `javascript_obfuscator` fails | Run `npm ci`; confirm `npx javascript-obfuscator --version` works. |
| `cloudflare_credentials` fails in deploy mode | Set `CLOUDFLARE_API_TOKEN` or profile Cloudflare credentials. |
| `cloudflare_account` fails | Set `CLOUDFLARE_ACCOUNT_ID` or profile `deploy.account_id`. |
| `network_reachability` fails | Check server outbound network, proxy env vars, and configured speed/availability URLs. |
| `profile_path` or `artifacts_root` fails | Fix ownership and write permissions under `$HOME/.auto-vpn/`, or set `VPN_AUTOMATION_RUNTIME_ROOT` to a writable directory. |

## Redaction Rules

Do not print, paste, upload, or attach:

- source keys or full source URLs with tokens
- Cloudflare API tokens, global keys, email/account identifiers when sensitive
- `deploy.secret_query`
- full subscription URLs or verification URLs with secrets
- full `vmess://` node links
- raw artifact files that contain node lists

When reporting status, use counts, stage names, check names, and artifact directory names instead of secret-bearing values.
