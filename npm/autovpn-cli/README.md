# AutoVPN CLI

Node.js npm CLI for AutoVPN headless and Agent workflows. Node.js `>=22.5.0`
is required.

## Usage

```bash
npx -y @swimmingliu/autovpn doctor --project-root . --output json
npm install -g @swimmingliu/autovpn
autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
```

GitHub Release tarballs remain available for pinned/offline installs:

```bash
npm install -g https://github.com/SwimmingLiu/auto-vpn/releases/download/v<version>/swimmingliu-autovpn-<version>.tgz
```

For Agent-friendly JSONL output, prefer foreground runs:

```bash
autovpn doctor --project-root . --output json
autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
autovpn artifacts latest --project-root .
```

## Server Web UI

`autovpn serve` starts a single-user HTTP service that serves the AutoVPN Web UI
from the same renderer used by the desktop app.

```bash
autovpn serve --project-root .
```

Defaults:

- host: `127.0.0.1`
- port: `8765`
- auth: token-protected

For server deployment, bind explicitly and provide a token:

```bash
export AUTOVPN_SERVER_TOKEN="$(openssl rand -base64 24)"
autovpn serve --project-root /opt/autovpn --host 0.0.0.0 --port 8765 \
  --token "$AUTOVPN_SERVER_TOKEN"
```

The server refuses non-loopback binds unless `--token` or `--no-auth` is
provided. Prefer SSH forwarding, a private reverse proxy, or your own HTTPS
terminator for internet-facing deployments.

## Runtime Shape

The CLI owns command parsing, profiles, artifacts, detached jobs, pipeline
execution, Cloudflare deployment, verification, and the server Web UI.

Foreground run:

```bash
autovpn run --project-root . --output jsonl
```

Runtime notes:

- Each run writes `artifact_dir/run.db`. This SQLite database is the authoritative local record for run state, node identity, stage results, and resume checkpoints. The `.txt` and `.json` files in the artifact directory are compatibility exports; do not use them as the source of truth for an in-progress run.
- Pipeline mode streams each newly discovered unique node from the extract callback directly through dedupe, probe/full speed measurement, and availability checks. These stages can be active at the same time, and their displayed totals can increase while extraction is still discovering nodes.
- The streaming queues use bounded concurrency and backpressure. A slow speed or availability worker therefore limits queued work instead of allowing unbounded memory growth.
- `resume pipeline`, `resume speedtest`, `run --resume-latest`, and `retry-stage` continue from the SQLite checkpoints. Existing legacy artifact directories can be imported on resume; subsequent state is recorded in `run.db` while compatibility exports remain available.
- Pipeline mode does not apply the legacy global `max_download_candidates` ranking gate before availability. If that field remains in a profile, it only applies when the speed module is run independently in its legacy ranked-candidate mode.
- Detached job management runs in Node for `run --detach`, `jobs resume --detach`, and `jobs retry --detach`; detached run/resume/retry workers also use the Node CLI worker.
- Non-detached `retry-stage` runs through the Node backend for retryable artifact stages from `speedtest` through `verify`; non-detached `resume pipeline`, `resume speedtest`, and `run --resume-latest` continue existing sessions through the Node backend.
- Add `--skip-deploy --skip-verify` when you want an offline Node pipeline check.
- Plain Node foreground deploy/verify runs use Node for Wrangler deploy, primary blocked-project fallback, share-project sync/fallback, custom-domain binding, custom-domain DNS upsert, and verify.
- Empty offline runs complete without requiring an external language runtime. Speedtest and availability use the per-node Mihomo runtime by default so candidate measurements and provider checks traverse each candidate node. Set `AUTOVPN_SPEEDTEST_RUNTIME=direct` or `AUTOVPN_AVAILABILITY_RUNTIME=direct` only for direct-host diagnostic checks.
- Project `.env` is loaded before resolving profile and artifact paths. Explicit process environment values still win over `.env`.
- `autovpn serve` is Node-native and exposes the browser UI plus `/api/health`,
  `/api/state`, `/api/runs`, `/api/runs/current/stop`, and `/api/events`.

## Environment

- `AUTOVPN_NO_INSTALL`
- `AUTOVPN_FORCE_INSTALL`
- `AUTOVPN_SERVER_HOST`
- `AUTOVPN_SERVER_PORT`
- `AUTOVPN_SERVER_TOKEN`
- `VPN_AUTOMATION_RUNTIME_ROOT`
- `VPN_AUTOMATION_PROFILE_PATH`
- `VPN_AUTOMATION_ARTIFACTS_ROOT`
- `VPN_AUTOMATION_UPSTREAM_PROXY`
