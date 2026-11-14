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
2. start mihomo with every candidate, in a group with **its own health check
   off** (see below);
3. health-check each candidate against a real vendor host (`/proxies/<name>/delay`);
4. restart with only the survivors, fastest first, in a `fallback` group.

The final group is `fallback`, deliberately not `url-test`: `url-test` re-ranks
on latency every interval, which would change the exit IP mid-crawl. That is the
single most suspicious thing an account can do in front of a vendor.

Step 2's group has no `url`/`interval`/`lazy` because of a measured trap worth
keeping: with `lazy: false`, mihomo probes every member the moment the config
loads, and the supervisor then probes the same nodes immediately after. Two
sweeps landing together read as a burst and get refused —

| probing- phase group | result |
|---|---|
| `fallback` + `lazy: false` | **0/37 healthy**, 15 s (all failed fast) |
| `select`, no health check | **36/37 healthy**, 23 s |

Same subscription, same image, same probe concurrency. When this happened the
crawl silently degraded to `direct` and left from the platform's own address,
which is exactly what this deployment exists to avoid — so the regression is
covered by a test rather than a comment (`container/test/egress.test.mjs`).

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
│       ├── profile-guard.mjs   refuses a profile whose secret disagrees with the template
│       └── egress.mjs          subscription → mihomo fallback group on 127.0.0.1:7897
├── worker/src/index.js         Worker routing + PipelineController Durable Object
└── scripts/
    ├── fetch-mihomo.sh         vendor the linux binary for the image build
    ├── egress-on-runner.mjs    the same supervisor, for the runner-based path
    ├── assemble-account-pool.mjs  join split pool secrets, pinned by sha256
    ├── verify-published.mjs    decode what is served; a 200 alone is not success
    └── deploy.sh               build, push, deploy, seed secrets
```

## Two ways to run the measure half

The publishing half is always the same: `wrangler pages deploy` from the
artifact the run measured. The measuring half has two hosts, and the choice is
a plan question, not a design one.

| | Container path | Runner path |
|---|---|---|
| Where the crawl runs | Cloudflare Container (full Linux VM) | GitHub Actions `ubuntu-24.04` |
| What it needs | Workers Paid (~$6.5/mo measured) | nothing beyond the repo |
| Schedule | Worker Cron + Durable Object alarm | the workflow's own `cron` |
| Where the pool lives | Durable Object SQLite | repository secrets, split + sha256-pinned |
| Orchestration | DO phases: measuring → gating → deploying → verifying | the workflow's steps |
| Failure visibility | `/api/status`, `/api/events` | the Actions run page |

Both use `container/profile.cloudflare.toml`, both crawl through
`127.0.0.1:7897`, and both publish the artifact that run measured. The runner
path is `.github/workflows/cloudflare-subscription.yml`; the container path is
`.github/workflows/deploy-cloudflare.yml` plus the Worker.

The runner path exists because **Cloudflare Containers require the Workers Paid
plan**, and nothing else here does. If the plan is enabled, the container path
is the better one: it keeps the schedule, the pool and the status API on
Cloudflare, with no third party in the loop.

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

The Worker profile is **not** one of these secrets. It is committed as
`container/profile.cloudflare.toml` and uploaded from the checkout, so editing
it is a normal pull request rather than a secret rotate. The file sits just
under the 5 KB cap on a Worker secret (about 5,030 bytes), and `deploy.sh`
strips comments and blank lines before upload anyway: the API rejects an
oversized secret rather than wrangler, so without the guard the failure would
only appear after the image had been built.
`cloudflare/container/test/profile.test.mjs` asserts the raw size, so an edit
that pushes it over fails in CI instead.

```bash
gh secret set CLOUDFLARE_API_TOKEN
# paste the value from ~/.autovpn-api-token when prompted, or:
gh secret set AUTOVPN_API_TOKEN < ~/.autovpn-api-token
gh secret set AUTOVPN_SUBSCRIPTION_URL
gh variable set CLOUDFLARE_ACCOUNT_ID --body '<account id>'
gh variable set AUTOVPN_BASE_URL --body 'https://autovpn-cloud.<subdomain>.workers.dev'
```

`gh secret set NAME` with no `--body` reads stdin, which is the form to use for
a raw token. `--env-file` expects dotenv `NAME=value` lines — handed a bare
token it fails to parse, and handed a file it takes the names from the file and
ignores the positional one.

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
It distinguishes three failures that all look like `Authentication error` from
`wrangler deploy`:

| status | meaning | fix |
|---|---|---|
| `MISSING` | the token lacks the scope | add it to the token |
| `NO PLAN` | the token is fine; the account is not entitled | upgrade to Workers Paid |
| `DOWN` | Cloudflare answered 5xx | retry later, nothing to edit |

The one that catches people is **Containers → Edit** — the permission is listed
under Account permissions as "Containers Edit", while some API references call
it "Workers Containers Write".

**Containers require the Workers Paid plan** ($5/month, which includes 375
vCPU-minutes, 25 GiB-hours of memory and 200 GB-hours of disk — one nightly run
of `standard-1` for ~20 minutes uses roughly 10 vCPU-minutes and 1.3 GiB-hours,
so the schedule fits inside the allowance). Workers Scripts and Pages work on
the free plan; Containers do not, and the API says so in the 401 body once the
scope is correct.

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
and the legacy `[brand]` block format. The response is counts only, and the
script exits non-zero unless rows actually landed in the pool — a stored file
that imports zero rows is the silent failure above, not a success.

```bash
curl -sS "$AUTOVPN_BASE_URL/api/accounts" -H "authorization: Bearer $AUTOVPN_API_TOKEN"
```

`stored.row_count` is what the DO holds; `container` is the live count, and
`null` when no container is running — a status query does not start one.

A container that already has a pool is never overwritten: the live pool may
hold rows an operator deliberately retired, and replaying the stored CSV would
resurrect them. That cuts both ways, so the pool is synced back the other
direction too: as soon as a measurement finishes, the DO pulls the container's
pool (`/accounts/export`) and replaces its stored copy. The retirement of a
credential the vendor rejected is the one thing that accumulates across nights,
and without the export tomorrow's replay would put it straight back into
rotation.

A run does not start at all if the replay imports nothing: it finishes as
`failed` with `account pool could not be replayed`, rather than spending the
night logging `no active account`.

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

`min_final_links = 40` here, against the VPS profile's 50. The floor exists to
stop a broken night from replacing a working subscription, not to demand a
record night. Measured yields are 49–54 normally and 0–30 when something fails,
so a floor of 50 held **five nights straight** on the VPS (48, 30, 50, 44, 43),
publishing nothing while the served subscription aged — it was serving 37 nodes
from an 11–12-day-old artifact. 40 clears every normal night. If yields drop
below that, the honest response is to find the yield problem, not to lower the
floor again.

### The deploy target is this deployment's own project

`profile.cloudflare.toml` names `sub-nodes-cf`, and **the deploy stage writes to
whatever project that is**. It is a separate project from the VPS's
`sub-nodes-04` on purpose: the two installations serve two subscriptions, and
neither can replace the other's artifact.

`wrangler pages deploy` replaces the whole production deployment of the named
project. There is no per-branch isolation for a Direct Upload project and no dry
run, so the project name in the profile **is** the blast radius. `deploy.sh`
refuses the two names that belong to the VPS (`sub-nodes-04`, the retired
`sub-links-auto`), and `container/test/profile.test.mjs` asserts the same pair,
so a profile edit cannot quietly merge the two into one blast radius.

To try a change without touching the live subscription, point `project_name` at
a throwaway project for that run. The publish workflow's verify step reads the
URL back from the deploy, so a scratch run is still verified honestly.

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

## Speed test: the two numbers that decide whether a night publishes

Both are in `[speed_test]`, and both were wrong here before a run was compared
against the VPS's own numbers.

**`timeout_seconds = 60`** (was 20). These nodes answer a delay probe in 2–3 s
and then take far longer for the first byte of a 10 MB download. At 20 s the
identical run passed **82** links where the VPS passed **134** from the same
candidates — the ceiling was failing healthy nodes, and every one of them is a
link that never reaches the subscription.

**`concurrency = 8`** (was 20). Each measured link gets its own mihomo child, so
this is how many start at once. At 20, this stage logged 343 `controller request
timed out after 20000ms` and 124 `503 Service Unavailable` — mihomo's own local
API not answering, which is saturation, not the vendor. The candidates have all
answered a probe by this point, so a narrower sweep costs wall-clock, not
coverage.

> **Read this before trusting any throughput number in this file.** Every
> measurement taken on a workstation was taken inside a local container, and a
> local container egresses from its host. The "Cloudflare container" reaching
> 0.31 MB/s median was this machine's broadband: its egress IP and the host's
> were identical (`23.225.57.218`, `net=bridge`). A GitHub runner, measured the
> same way, reaches Cloudflare at **83.79 MB/s** and GitHub at **42.18 MB/s**,
> and pushes 10 concurrent 10 MB downloads in about a second — against 0.55
> MB/s from the workstation. The 30× gap that motivated the `concurrency` and
> URL changes was the measurement host, not Cloudflare. Only numbers taken on
> the host being judged count; check `cdn-cgi/trace` first.

The same class of mistake appeared once already, in the egress supervisor: two
health sweeps of the same nodes landing together made every node look dead (see
§ How the IP problem is solved). The lesson both times: a stage that reports
"everything unreachable" is usually reporting on its own load.

## Costs

Workers Paid is $5/month and includes 375 vCPU-minutes, 25 GiB-hours of memory
and 200 GB-hours of disk. One nightly run of `standard-1` for ~20 minutes is
about 10 vCPU-minutes and 1.3 GiB-hours, so the daily schedule fits inside the
included allowance. The exit bandwidth goes through your subscription nodes, not
Cloudflare, so the shared-egress charge does not apply to the crawl either.
