# AutoVPN on Cloudflare

A second, independent deployment of the AutoVPN pipeline that runs entirely on
Cloudflare. Your server keeps running exactly as it does today; this one is a
parallel installation with its own account pool, its own Pages project and its
own schedule. Nothing here reads from or writes to the VPS.

## Why a container, not Workers

The publishing half was already Cloudflare-native — the subscription worker is
761 bytes on Pages and deployment goes through the REST API. The execution half
cannot run on Workers at all, and not for lack of effort:

| Wall | Workers | This project |
|---|---|---|
| `node:child_process` | non-functional stub | spawns one mihomo per measured link |
| `node:sqlite` | non-functional stub | `run.db` resume state |
| 128 MB per isolate | fixed | APK parse peaks at 244–423 MB |
| CPU 30 s / 5 min cap | hard | a run is 15–90 minutes of wall clock |
| No localhost listeners | blocked | speedtest is `127.0.0.1:<mixed-port>` |

A Cloudflare Container is a full Linux VM, so **the CLI runs here unmodified**.
That is the whole design: no reimplementation, no second behaviour to keep in
sync. `wrangler`, `mihomo`, `node:sqlite` and `curl` are all present and work
the way they work on the VPS.

## How the IP problem is solved

Cloudflare Workers and Containers egress from a shared range (`172.64.0.0/13`).
Vendors throttle or block datacenter ranges, and 604 pooled accounts all
changing city on the same morning is a textbook risk-engine signal.

So the crawl does not use the Cloudflare egress. It uses **your own published
subscription as the exit**:

```
CLI crawl ──► http://127.0.0.1:7897 ──► mihomo (fallback group) ──► subscription node ──► vendor
```

`egress.ts` already defaults to `127.0.0.1:7897`; on the VPS that port is
whatever local proxy the operator runs. Here the container's `EgressSupervisor`
builds one from the subscription on every run:

1. fetch the published subscription, decode the base64 payload into vmess links;
2. start mihomo with every candidate in one `fallback` group;
3. health-check each candidate against a real vendor host (`/proxies/<name>/delay`);
4. restart with only the survivors, fastest first.

The group is `fallback`, deliberately not `url-test`: `url-test` re-ranks on
latency every interval, which would change the exit IP mid-crawl. That is the
single most suspicious thing an account can do in front of a vendor.

If no node survives, the supervisor degrades to `direct` **and says so** —
`/egress/status`, the `egress_ready` event and the run row all record the mode,
so "the crawl went out through X" is an observable fact rather than an
assumption.

## Layout

```
cloudflare/
├── wrangler.jsonc              Worker + Container + Cron
├── container/
│   ├── Dockerfile              linux/amd64, Node 22, mihomo, published CLI
│   └── src/
│       ├── server.mjs          HTTP skin: /run /status /events /egress /import-accounts
│       └── egress.mjs          subscription → mihomo fallback group on 127.0.0.1:7897
├── worker/src/index.js         Worker routing + PipelineController Durable Object
└── scripts/
    ├── fetch-mihomo.sh         vendor the linux binary for the image build
    └── deploy.sh               build, push, deploy, seed secrets
```

## Deploy

Two paths. CI is the normal one; the local script exists so a workstation can
deploy without a commit.

### From GitHub Actions

`.github/workflows/deploy-cloudflare.yml` runs the unit tests, then builds and
deploys. It triggers on a push to `main` that touches `cloudflare/**`, or
manually from the Actions tab.

It runs on `ubuntu-24.04`, which matters for one reason: the image is
`linux/amd64`, and a GitHub runner is that natively. Building on Apple silicon
means emulation.

Repository settings it reads:

| Kind | Name | Required | Purpose |
|---|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | yes | deploy the Worker and push the image |
| secret | `AUTOVPN_API_TOKEN` | yes | the Worker's own bearer token |
| secret | `AUTOVPN_SUBSCRIPTION_URL` | recommended | the egress pool's source |
| variable | `CLOUDFLARE_ACCOUNT_ID` | yes | target account |
| variable | `AUTOVPN_BASE_URL` | no | smoke-test URL, e.g. `https://autovpn-cloud.<subdomain>.workers.dev` |
| variable | `AUTOVPN_ALLOW_LIVE_PROJECT` | no | `1` lets the deploy target a real Pages project |

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set AUTOVPN_API_TOKEN --env-file -   # or paste a fixed random string
gh secret set AUTOVPN_SUBSCRIPTION_URL
gh variable set CLOUDFLARE_ACCOUNT_ID --body '<account id>'
gh variable set AUTOVPN_BASE_URL --body 'https://autovpn-cloud.<subdomain>.workers.dev'
```

The job is bound to the `cloudflare` environment. That environment exists
automatically on first run with no protection; add required reviewers to it in
Settings → Environments if a deploy should wait for a human.

`AUTOVPN_API_TOKEN` is **required**, not generated. `deploy.sh` mints one when
it is unset, which is correct on a workstation and wrong in CI: it would rotate
the bearer on every push and lock out every client. The workflow checks for it
before the ten-minute build.

### From a workstation

```bash
# 0. one-time: seed the secrets the Worker and the container read
npx wrangler secret put AUTOVPN_API_TOKEN       # any long random string
npx wrangler secret put AUTOVPN_PROFILE_TOML    # contents of the cloudflare profile
npx wrangler secret put CLOUDFLARE_API_TOKEN    # Pages:Edit + Zone:DNS:Edit + Workers Scripts:Edit
npx wrangler secret put SUBSCRIPTION_URL        # the live subscription, with ?serect_key=...

# 1. vendor mihomo (once per version), then build and deploy
cloudflare/scripts/fetch-mihomo.sh
cloudflare/scripts/deploy.sh
```

### Token scopes

`node cloudflare/scripts/check-token.mjs` probes each endpoint the deploy
touches and prints a table; run it before anything else when a deploy fails.
The one that catches people is **Containers → Edit** — the permission is listed
under Account permissions as "Containers Edit", while some API references call
it "Workers Containers Write". Without it, `wrangler deploy` fails with a bare
`Authentication error` after the image has already been built.

### wrangler version

`wrangler.jsonc` uses `scheduling_policy: "durable_object"` and the declarative
`exports` map. Both are newer than the version the CLI's managed-tool path
pins for *Pages* deploys (4.106.0, which has neither), so this subtree pins
**wrangler 4.160.1** in `worker/package.json` and must be deployed with it.
Mixing them produces `scheduling_policy must be one of ["regional","moon","default"]`.

### Docker builder

`wrangler deploy` builds the container image locally and pushes it to
Cloudflare's registry, which needs Docker with the **buildx** component. The
stock Docker install on macOS/Linux may ship the legacy builder only; if the
deploy fails with `unknown flag: --load`, install buildx:

```bash
docker buildx version || brew install docker-buildx   # or your distro's package
```

To skip a local build entirely, push a digest-pinned image yourself and point
`containers[].images.autovpn.image` at
`registry.cloudflare.com/<account-id>/<repo>@sha256:<64 hex>`.

### Seed the account pool before the first run

The crawl leases one pooled account per vendor request. An empty pool does not
fail loudly: every source records `account pool has no active <brand> account`,
the run ends with `final_links = 0`, and the gate holds — so the subscription is
never replaced and the schedule looks healthy while publishing nothing.

The pool is credentials, so it cannot go in the image (the image is pushed to a
registry) and cannot stay on the container disk (every restart, sleep and
rollout wipes `/data`). The Durable Object holds the CSV and replays it into
each fresh container before a run:

```bash
export AUTOVPN_API_TOKEN="$(cat ~/.autovpn-api-token)"
export AUTOVPN_BASE_URL="https://autovpn-cloud.<subdomain>.workers.dev"

cloudflare/scripts/seed-accounts.sh ~/account-info.txt
```

The file is POSTed verbatim; `format: "auto"` lets the CLI decide between CSV
and the legacy `[brand]` block format. The response is counts only.

```bash
curl -sS "$AUTOVPN_BASE_URL/api/accounts" -H "authorization: Bearer $AUTOVPN_API_TOKEN"
```

`stored.row_count` is what the DO holds; `container` is the live count, and
`null` when no container is running — a status query does not start one.

A container that already has a pool is never overwritten: the live pool may
hold rows an operator deliberately retired, and replaying the stored CSV would
resurrect them.

## Operating it

```bash
# start a run now (bypasses the cron)
curl -X POST https://autovpn-cloud.<subdomain>.workers.dev/api/run \
  -H "authorization: Bearer $AUTOVPN_API_TOKEN" -d '{}'

# watch it
curl https://autovpn-cloud.<subdomain>.workers.dev/api/status -H "authorization: Bearer $AUTOVPN_API_TOKEN"
curl "https://autovpn-cloud.<subdomain>.workers.dev/api/events?run_id=<id>" -H "authorization: Bearer $AUTOVPN_API_TOKEN"

# gate / schedule settings
curl -X POST .../api/settings -H "authorization: Bearer $AUTOVPN_API_TOKEN" \
  -d '{"min_final_nodes": 50, "enabled": true}'
```

A run moves through `measuring → gating → deploying → verifying → done`. The
gate mirrors `daily-run.sh`: publish only when `final_links > min_final_nodes`,
so a thin sweep never replaces a working subscription.

### Before the first real run: point at a scratch project

`profile.cloudflare.toml` names a Pages project, and **the deploy stage writes
to whatever project that is**. Until the Cloudflare deployment has been proven
against your account, use a throwaway project so a bad artifact cannot replace
the subscription people are already using:

```toml
[deploy]
project_name = "autovpn-cf-deploytest"
```

Then watch `https://autovpn-cf-deploytest.pages.dev/?serect_key=...` for one
run. Only after that is green, change `project_name` to the project that should
serve the subscription.

`wrangler pages deploy` replaces the whole production deployment of the named
project. There is no per-branch isolation for a Direct Upload project and no
dry run, so the project name in the profile **is** the blast radius.

If a run does publish something wrong, roll back to the previous deployment —
this restores the exact bundle that was serving before:

```bash
# list recent deployments, newest first
curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT/deployments?per_page=6"

# roll production back to a specific one
curl -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT/deployments/$SHORT_ID/rollback"
```

## What is deliberately not migrated

- **The subscription worker itself.** It is already on Pages and has no server
  dependency. This deployment publishes to its own Pages project.
- **The share worker** (`templates/share-worker/vpn.js`). It implements proxy
  forwarding over `cloudflare:sockets`, which is the part of the stack that
  Cloudflare's terms §2.2.1(j) speaks to. Keeping it out of this deployment
  keeps the new surface to crawl/measure/publish, which is the least contentious
  half. That is a decision for you, not a technical limit.
- **Electron.** It is a local client; pointing it at this API is a product
  decision, not a migration step.

## Costs

Workers Paid is $5/month and includes 375 vCPU-minutes, 25 GiB-hours of memory
and 200 GB-hours of disk. One nightly run of `standard-1` for ~20 minutes is
about 10 vCPU-minutes and 1.3 GiB-hours, so the daily schedule fits inside the
included allowance. The exit bandwidth goes through your subscription nodes, not
Cloudflare, so the shared-egress charge does not apply to the crawl either.
