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

```bash
# 0. one-time: seed the secrets the Worker and the container read
npx wrangler secret put AUTOVPN_API_TOKEN       # any long random string
npx wrangler secret put AUTOVPN_PROFILE_TOML    # contents of state/profile.toml
npx wrangler secret put SUBSCRIPTION_URL        # must include ?serect_key=...

# 1. vendor mihomo (once per version), then build and deploy
cloudflare/scripts/fetch-mihomo.sh
cd cloudflare && npx wrangler deploy
```

The first deploy builds the image on Cloudflare's builder. Local iteration uses
`npx wrangler dev`, which runs the container in Docker.

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
