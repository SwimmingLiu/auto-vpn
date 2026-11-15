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

## Clash Verge static exit

`autovpn verge` installs a socks/http exit into the Clash Verge Rev extension
script and then proves from mihomo's own API that the chain is loaded.

```bash
autovpn verge exit                                  # hidden prompt, write, restart Verge
autovpn verge exit < ~/.auto-vpn/verge-exit.txt     # same, from a pipe
autovpn verge exit --from ~/.auto-vpn/verge-exit.txt --check
autovpn verge status --test
```

The link is never taken on the command line: it comes from a `0600` file, a
pipe, or a prompt that does not echo, so it stays out of argv and shell history.
Every line the command prints is masked to `scheme://***@host:port`.

Restarting Verge resets group selections to the profile's own defaults, so a
`🚀 节点选择` that pointed at the exit group would come back on a plain airport
node. The command remembers which selectors pointed at the exit group before
the restart and puts them back once activation settles; `--use` selects it
unconditionally.

mihomo's `/proxies` API carries no address or credential, so a rotated link
under the same name would look live. The command also reads the generated
`clash-verge.yaml`: if it still holds exactly the entry it held before the
restart, the profile was not rebuilt and the command exits `6` instead of
reporting success.

Only the `const STATIC_EXITS = [ … ];` literal inside `profiles/<uid>.js` is
replaced. `MODE`, the group names, and `RULES_TO_EXIT` edited in Verge survive a
write, and the write itself is a temp file in the same directory, fsynced and
renamed, so a failed write never leaves half a script.

| Flag | Meaning |
| --- | --- |
| `--from FILE` | Read the links from `FILE` (must be `0600`, owned by you) |
| `--stdin` | Read the links from stdin |
| `--check` | Parse, build, and compile; write nothing |
| `--test` | Probe each link with curl before writing |
| `--no-apply` | Write only; reactivate the profile in Verge yourself |
| `--wait SECONDS` | How long to wait for the core to load the new nodes (default 25) |
| `--use` | After the chain is live, select the exit group in `EXIT_GROUP_TARGETS` |
| `--backup` | Keep one `profiles/<uid>.js.bak` before the first write |
| `--script PATH` | Target a specific script instead of the attached one |
| `--output json` | Machine-readable report; `credential` is `set`/`none`, `identity` is `verified`/`unverified` |

Exit codes: `0` done, `2` usage, `3` no Verge install or script, `4` the source
file is readable by others, `5` a link did not answer, `6` the core never
loaded the new nodes, or the generated config still carries the old entry.

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
- Pipeline mode sends each newly discovered unique node from the extract callback to a reachability probe. Only reachable nodes receive the full speed measurement, and only nodes that pass the configured speed threshold proceed to availability checks. Dedupe, probe/speedtest, and availability can be active while extraction is still running, so their displayed totals can increase during the run.
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
