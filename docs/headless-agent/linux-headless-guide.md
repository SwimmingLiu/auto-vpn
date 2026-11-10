# Linux Headless Guide

## Requirements

- Node.js `>=22.5.0`
- npm
- Mihomo for per-node proxy measurements
- Cloudflare Wrangler credentials only when deployment is enabled

## Install

```bash
npm install -g @swimmingliu/autovpn
autovpn --version
```

For a pinned GitHub Release tarball:

```bash
export AUTOVPN_VERSION=2.1.1
npm install -g "https://github.com/SwimmingLiu/auto-vpn/releases/download/v${AUTOVPN_VERSION}/swimmingliu-autovpn-${AUTOVPN_VERSION}.tgz"
```

## Configure

```bash
export PROJECT_ROOT=/opt/autovpn
export VPN_AUTOMATION_RUNTIME_ROOT=/srv/autovpn
autovpn doctor --project-root "$PROJECT_ROOT" --output human
```

The runtime root contains the profile, artifacts, job logs, and managed npm
tools. Restrict its permissions because profile and deployment data can be
sensitive.

## Run

```bash
autovpn run --project-root "$PROJECT_ROOT" --output jsonl
```

For a detached service-style run:

```bash
autovpn run --project-root "$PROJECT_ROOT" --detach --json
autovpn status --project-root "$PROJECT_ROOT" --json
autovpn logs --project-root "$PROJECT_ROOT" --tail 200
```

Use `--skip-deploy --skip-verify` for a local pipeline diagnostic.

## Server UI

```bash
autovpn serve --project-root "$PROJECT_ROOT" --host 127.0.0.1 --port 8765
```

Use SSH port forwarding for remote access. A non-loopback bind must have an
explicit token unless the operator deliberately enables no-auth mode on a
trusted network.

## Upgrade

```bash
npm install -g @swimmingliu/autovpn@latest
autovpn --version
autovpn doctor --project-root "$PROJECT_ROOT" --output human
```

## Scheduled run with a node gate

`scripts/server/daily-run.sh` runs the pipeline once and publishes only when
the node count clears a threshold, so a thin sweep does not replace a working
subscription:

```bash
autovpn run --skip-deploy --skip-verify            # always
autovpn retry-stage --stage deploy                 # only when final_links > min_final_nodes
```

The threshold lives in `$VPN_AUTOMATION_RUNTIME_ROOT/daily-run.json`:

```json
{ "min_final_nodes": 50, "enabled": true }
```

The file is created with the default 50 on first run. Set `enabled` to `false`
to pause the schedule without removing the crontab entry. Each run writes a
result record under `$VPN_AUTOMATION_RUNTIME_ROOT/daily-run-results/` with
`status` of `deployed`, `held`, `failed` or `deploy_failed`, plus the artifact
directory and the measured node count. Logs land in `logs/daily-run-*.log`.

Install it as a daily job:

```bash
cp scripts/server/daily-run.sh "$VPN_AUTOMATION_RUNTIME_ROOT/daily-run.sh"
chmod 700 "$VPN_AUTOMATION_RUNTIME_ROOT/daily-run.sh"
( crontab -l 2>/dev/null; echo '15 4 * * * /bin/bash "$HOME/.auto-vpn/daily-run.sh"' ) | crontab -
```
