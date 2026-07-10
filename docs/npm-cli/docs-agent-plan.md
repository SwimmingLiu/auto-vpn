# Documentation and Agent Experience Plan

> Historical migration record. Use `docs/headless-agent/` for current Agent
> operating instructions.

## Decision

Document three separate user paths:

1. Electron installers for desktop users.
2. Python wheel/pipx for stable Linux and server installs.
3. npm/npx wrapper for Agents, temporary environments, and Node-oriented users.

The docs must explicitly state that the npm wrapper calls the Python CLI and is not a replacement implementation.

## README Changes

Update `README.md` by replacing the current single installation section with "Choose an Installation Path".

Recommended table:

| Path | User | Install | Command | Agent fit |
| --- | --- | --- | --- | --- |
| Electron installer | Desktop users | GitHub Release DMG/DEB/RPM/EXE | GUI | No |
| Python wheel / pipx | Linux, servers, long-lived CLI hosts | `pipx install <wheel>` | `autovpn` | Yes |
| npm / npx wrapper | Agents, CI, temporary hosts, Node users | `npx -y @swimmingliu/autovpn` | `npx ...` or `autovpn` | Recommended |

Required statements:

- Electron installers do not install the terminal `autovpn` command.
- Python wheel is the actual AutoVPN Python CLI distribution.
- npm wrapper is a launcher/distribution layer that eventually calls the Python CLI.
- Headless pipeline stages still require local dependencies such as `mihomo`, Node/npm/npx, Playwright, and Wrangler when deploy is enabled.

Recommended commands:

```bash
npx -y @swimmingliu/autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --output json

autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --output json

cd /opt/autovpn/vpn-subscription-automation
source .venv/bin/activate
autovpn doctor --project-root "$PWD" --output json
```

## Agent Skill Changes

Update `.codex/skills/autovpn-agent/SKILL.md` with a command resolution section.

Recommended priority:

1. Agent default:

```bash
npx -y @swimmingliu/autovpn doctor --project-root "$PWD" --output json
```

2. Installed CLI:

```bash
command -v autovpn >/dev/null && autovpn doctor --project-root "$PWD" --output json
```

3. Project virtual environment:

```bash
source .venv/bin/activate
autovpn doctor --project-root "$PWD" --output json
```

4. Last-resort development fallback:

```bash
PYTHONPATH=src python -m vpn_automation.cli doctor --project-root "$PWD" --output json
```

The skill should continue to avoid raw `profile show` unless explicitly needed, and should prefer:

```bash
npx -y @swimmingliu/autovpn profile summary --project-root "$PWD" --json
```

## Linux Headless Guide

Update `docs/headless-agent/linux-headless-guide.md` with an npx quick start near the top.

Recommended quick start:

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates python3.12 python3.12-venv nodejs npm

node --version
npm --version
python3.12 --version

sudo mkdir -p /opt/autovpn
sudo chown "$USER":"$USER" /opt/autovpn
git clone https://github.com/SwimmingLiu/auto-vpn.git /opt/autovpn/vpn-subscription-automation

cd /opt/autovpn/vpn-subscription-automation

npx -y @swimmingliu/autovpn doctor --project-root "$PWD" --output human
npx -y @swimmingliu/autovpn run --project-root "$PWD" --skip-deploy --skip-verify --output jsonl
npx -y @swimmingliu/autovpn artifacts latest --project-root "$PWD"
```

Long-lived server install:

```bash
python3.12 -m pip install --user pipx
python3.12 -m pipx ensurepath
pipx install https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/vpn_subscription_automation-<version>-py3-none-any.whl
autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --output human
```

## Troubleshooting Coverage

Add or update a troubleshooting document such as `docs/headless-agent/troubleshooting.md`.

Cover these issues:

- Node/npm/npx missing:

```bash
node --version
npm --version
npx --version
```

- Python missing or too old:

```bash
python3.12 --version
python3.12 -m pip --version
```

- Wheel download failure:
  - GitHub Releases unreachable
  - proxy missing
  - version tag missing
  - temp/cache directory not writable
  - fallback to `AUTOVPN_WHEEL_URL=file://...`

- PATH problem:

```bash
command -v autovpn || true
python3.12 -m site --user-base
pipx ensurepath
```

- Permission problem:
  - `state/profile.toml` not writable
  - `artifacts/` not writable
  - npm cache not writable
  - pipx or wrapper cache not writable

- Playwright:

```bash
npx playwright install --with-deps chromium-headless-shell
```

- Mihomo:

```bash
command -v mihomo
mihomo -v
```

- Wrangler:

```bash
npx wrangler --version
```

## Acceptance SOP Content

Add a user-facing acceptance SOP such as `docs/headless-agent/npm-wrapper-acceptance-sop.md`.

Manual checks:

```bash
node --version
npm --version
python3.12 --version

npx -y @swimmingliu/autovpn --help
npx -y @swimmingliu/autovpn --version
npx -y @swimmingliu/autovpn doctor --project-root "$PWD" --output json
npx -y @swimmingliu/autovpn profile summary --project-root "$PWD" --json
npx -y @swimmingliu/autovpn run --project-root "$PWD" --skip-deploy --skip-verify --detach --json
npx -y @swimmingliu/autovpn status --project-root "$PWD" --json
npx -y @swimmingliu/autovpn logs --project-root "$PWD" --tail 50
```

Acceptance criteria:

- `npx -y @swimmingliu/autovpn --help` runs.
- `doctor --output json` returns valid JSON.
- No Electron UI is required.
- Missing Python, Node, Mihomo, or Playwright produces a useful diagnostic.
- Secret-bearing values are redacted.
- `npx`, global `autovpn`, and local venv `autovpn` behave consistently.
- README, Linux guide, and Agent skill use the same command priority.
