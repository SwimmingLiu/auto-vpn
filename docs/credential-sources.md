# Official-site credential sources

A source has two modes. The older `url` mode requires pasting a request URL that
already carries a session token, so every token expiry forces a fresh capture.
The `credential` mode only needs an official site: the account is leased from
the account pool, and the control-plane key is discovered from the APK.

## Configuration

The settings drawer edits the four vendor rows. Each one carries an official
site and a round budget, nothing else:

```toml
[sources]
[sources.leiting]
mode = "credential"
official_site = "https://<OFFICIAL_SITE>"
enabled = true
max_iterations = 200
plateau_limit = 50
areas_per_round = 8
area_concurrency = 4
```

| Field | Required | Meaning |
|---|---|---|
| `mode` | yes | `credential` (the four vendor rows are always credential) |
| `official_site` | yes | Official site; the current APK is located from here |
| `max_iterations` | no | Rounds per platform — Android and iOS each run this many; `200` when omitted |
| `plateau_limit` | no | Consecutive rounds with no genuinely new node; `50` when omitted |
| `areas_per_round` | no | Areas taken from the fixed list each round; `8` when omitted |
| `area_concurrency` | no | Concurrent area requests inside one round; `4` when omitted (max 16) |
| `min_iterations` | no | Rounds that always run before early stopping; `0` when omitted |
| `max_runtime_seconds` | no | Wall-clock budget past `min_iterations`; `0` means unlimited |
| `device_id` | no | Fixed device id; a built-in default when omitted |
| `apk_url` / `apk_path` | no | Pin a specific build instead of site discovery |
| `backend_brand` | no | Data plane to use when it is not the row's own vendor. The account is still leased as the row's brand. Only 黑洞 currently needs it — see [below](#reading-the-雷霆-data-plane-from-a-黑洞-account). |
| `platforms` | no | Internal/test override only; omitted means both channels. The drawer does not edit it, and a save keeps whatever the profile already had. |

`min_iterations`, `max_runtime_seconds`, `device_id`, `apk_url` / `apk_path` and
`platforms` are profile-only: the drawer does not render them, and saving the
drawer leaves them as they were. Edit `profile.toml` when a pinned run needs
them.

`account` / `password` / `key` / `platform` are no longer part of the
contract. An old profile that still carries them is normalized on read and on
save: the fields are dropped, the account comes from the pool, the key from the
APK, and both client channels run.

Account management itself lives in the pool — see
[account-pool.md](./account-pool.md) for the CSV format and the CLI.

## Run sequence

```
official site -> download page chunk -> cdn.js
              -> candidate APK URLs (walking back a few publish slots)
              -> APK: package / version / signing cert / seed domains
              -> /api/eversion       control-plane key, api_links, api_lines
              -> /myapi/eapilogin    session token (pool account)
              -> /myapi/eapiuserinfo membership level, unlimited flag
              -> /myapi/apinodelist  route ids (every advertised table)
              -> /api/evmess?area=ID one vmess link per route
```

`/myapi/apinodelist` is the only endpoint that answers in plain JSON; the rest
are AES-CBC with key == IV.

## Both platforms run concurrently

Every credential source runs the Android and the iOS channel at the same time,
against the same leased account, and merges their links into one stream. The
channels differ only in the `platform` parameter and in the response shape:

| | Android | iOS |
|---|---|---|
| Response | `vmess://<base64>` | `ps\|<v2ray config>` |
| `kbox` | always appended by the APK | not sent |

Issuing both means one brand produces the union of what either client sees.
The APK is inspected once per brand: concurrent channels share one fingerprint
promise, so the 20–30 MB download does not race.

## Route selection

`/myapi/apinodelist` mixes paid foreign regions with a free tier and mainland
or return-to-China rows. Only the first kind is worth a request per round, so
the pool is filtered before the loop:

- free rows (`免费`, `trial`, …) answer with placeholders
- mainland rows (`中国`, `回国`, major city names, …) are the wrong direction
- rows the vendor marked unclickable are skipped
- 香港 / 台湾 / 澳门 are kept even when the vendor spells them `中国香港` / `中国台湾`:
  the apps list them as their own regions

旋风 advertises two route tables (`api_lines` is a `{key,value}` list rather than
a string). Both are fetched and merged, deduped by area id, so its two lists
behave as one source. The other brands publish a single table.

`include_free_routes` / `include_china_routes` exist for a pinned debug profile;
the drawer never sets them.


## The same route returns a different node each time

`area` selects a region, not a machine. The server picks a landing host per
request, so asking the same route again usually yields a different node — the
route list bounds the regions you can reach, not the number of nodes.

### The area list is fixed; a cursor walks it

Every run builds one area list before the first request: all regions the node
list advertises, minus China and the free tier, deduped by area id, in vendor
order. That list is frozen for the whole run. Each round takes the next
`areas_per_round` entries from it and the cursor wraps at the end, so a run cut
short by the round cap or by an early stop still reaches the tail of the list —
the old loop re-asked the same head every round and starved later regions.

The areas inside one round are requested concurrently, `area_concurrency` at a
time (default 4). The shipped `areas_per_round = 8` therefore keeps up to 8
requests in flight, which covers a 31-area list in four rounds. Measured on
雷霆: 30 areas sequentially cost ~30s per sweep; five rounds of
`areas_per_round = 6` / `area_concurrency = 6` (30 nodes) finish in 14s. Setting
`areas_per_round = 1` makes a round one request, and the concurrency setting
then has nothing to fan out.

### Rounds are per platform

`max_iterations` is the budget for **each** channel. `1000` means 1000 rounds on
Android **and** 1000 rounds on iOS, running at the same time — never 500 + 500,
never a shared counter.

| Setting | Effect |
|---|---|
| `max_iterations` | Rounds each platform runs |
| `areas_per_round` | Areas taken from the fixed list per round |
| `area_concurrency` | Concurrent area requests within a round |
| `min_iterations` | Rounds that always run, even after the pool stops growing |
| `plateau_limit` | Consecutive rounds with no genuinely new node that end the run |
| `max_runtime_seconds` | Wall-clock budget, likewise only after `min_iterations` |

### Early stop counts node identity, not link strings

A "new node" is a new canonical fingerprint — `add`, `port`, `id`, `net`,
`host`, `path`, `tls`, `sni` — deduped **across both platforms**. The display
name (`ps`) is not part of it. So:

- a node the server relabels on every request is delivered once and then no
  longer counts as new;
- a node iOS already produced does not reset Android's counter.

`plateau_limit = 50` therefore means exactly what it says: 50 consecutive rounds
in which this channel produced no node neither platform had seen before. Raw
link delivery is tracked separately, so a relabelled duplicate still reaches the
downstream pool.

A round where every candidate host failed is not a dry round — it is an outage.
Those rounds do not advance the plateau; after five in a row the channel stops
with an explicit error, and a direct run escalates to the upstream proxy first.

### A placeholder-only channel stops itself

黑洞's Android channel answers `1.1.1.1:443` for every area, on every account,
with or without the client's `kbox` parameter. A channel that has produced only
placeholder nodes for 8 consecutive rounds is stopped and reported; the other
channel keeps running. See the next section.

## 黑洞: the iOS channel is the whole node pool

The Android channel of 黑洞 answers the vendor's placeholder template
(`1.1.1.1:443`, `ps=431`) for every area. This is a server-side downgrade scoped
to `/api/evmess`: login, `/myapi/apinodelist` and the parameter set all behave
normally, and the same account on the iOS channel returns real nodes. It was
reproduced with the decompiled client's exact parameters, with and without
`kbox`, and across four device ids and every pooled account.

The iOS channel is real but small, and that is a property of the vendor, not of
the client:

| Measure | 黑洞 | 雷霆 (for scale) |
|---|---|---|
| Advertised areas (after filtering) | 31 | 30 |
| Distinct hosts the areas resolve to | 8 | 30 |
| Distinct outbound ids | 3 | — |
| Unique nodes after 20 full sweeps | 8 | 54 after 6 |

Blanking 31 areas maps onto only 8 landing hosts, so repeating the sweep cannot
produce more than those 8 nodes; the pool saturates on the first pass. 雷霆 maps
one area to one host and keeps yielding new machines per round.

Consequence for the run: 黑洞 produces ~8 nodes per run, all from iOS, and its
Android channel is stopped after 8 placeholder rounds instead of spending 200
rounds × concurrency on nothing.

### Reading the 雷霆 data plane from a 黑洞 account

The same account also exists on the 雷霆 backend — a different uid and a
different membership level, but a valid login — and that backend serves both
channels normally, one machine per area. Measured on 2026-11-12: 42 areas,
three laps, 48 unique nodes on the Android channel and 57 on iOS.

Point a source at it with `backend_brand`:

```toml
[sources.heidong]
mode = "credential"
official_site = "https://www.67986457.com"   # storefront: the APK and site
enabled = true
backend_brand = "leiting"                     # data plane: login, routes, nodes
```

The two roles stay separate:

| Field | Comes from |
|---|---|
| Account leased | the row's own brand (`heidong`) — the pool is never crossed |
| APK, official site, seed domains | the backend (`leiting`) |
| Request parameter layout | the backend's flag block, not the storefront's |
| Fingerprint cache key | the backend, so both rows share one APK inspection |

A pinned `apk_path` / `apk_url` is left untouched: it is the operator's explicit
choice of build, and dropping it turned a working pinned profile into
"APK could not be located". Unknown or self-referential names are removed during
config normalization rather than silently falling back.

Measured with this configuration, one run, three laps:

| Data plane | Requests | Real nodes | Distinct hosts | Placeholders |
|---|---|---|---|---|
| 黑洞 (own) | 40 × 3 | 8 | 8 | 120 |
| 雷霆 (`backend_brand`) | 42 × 3 | 13 | 7 | 0 |

## Crawl egress

The crawl goes through an upstream proxy by default (`[network]` in the profile):

```toml
[network]
proxy_mode = "proxy"        # proxy | direct | auto
proxy_url = "http://127.0.0.1:7897"
```

| `proxy_mode` | Behaviour |
|---|---|
| `proxy` (default) | Crawl through `proxy_url`. If nothing is listening, the run drops to direct rather than failing every request. |
| `auto` | Start direct; the first response that looks like an IP block pins the proxy for the rest of the run. |
| `direct` | Never use a proxy. |

A separate, sticky escalation exists inside `proxy` as well: a round in which
every candidate host failed, or a 403/407/429/451 response, switches a direct
run to the proxy once. The switch is recorded in the run's diagnostics
(`egress_transport`, `egress_switches`) and logged.

`VPN_AUTOMATION_PROXY_MODE` and `VPN_AUTOMATION_UPSTREAM_PROXY` override the
profile when set on the command line. The older
`VPN_AUTOMATION_USE_UPSTREAM_PROXY=0|1` still works and maps to `direct|proxy`.
The standard `HTTPS_PROXY` family is consulted only as a URL fallback, and only
when neither `VPN_AUTOMATION_UPSTREAM_PROXY` nor the profile's `proxy_url` is
set. It never changes the transport mode — exporting `HTTPS_PROXY` for other
tools cannot turn a direct run into a proxied one, or the reverse — but it does
supply the address when no other proxy URL is configured.

Per-node measurement (speed test, availability) is deliberately excluded: those
transports must reach the node itself, not the crawl proxy.

## The APK is not fetched on every run

Package, version, certificate and seed domains only change when the vendor
publishes a build, so the first run writes them under the runtime root's
`brand-fingerprints/`. Later runs verify the cached entry against
`/api/eversion` first:

- answers -> no APK download, only login and the node flow
- nothing answers -> the vendor rotated domains, so the APK is re-downloaded,
  re-inspected and the cache is replaced
- answers, but the entry is a day old -> the APK is re-inspected anyway: a
  vendor can rotate the signing certificate while the old seeds keep serving
  `/api/eversion`, and a stale certificate fails every login
- login rejected while the cache was in use -> the entry is dropped, so the
  next run re-inspects instead of repeating the failure

Setting `apk_url` or `apk_path` bypasses the cache entirely; that is the way to
pin a specific build or recover from a bad fingerprint.

Measured on one machine: about 13s for a first run (including a 22 MB
download) and about 7s on a cache hit. Entries are keyed by brand, and the
Android and iOS channels of one run share both the download and the cache file.

## kbox

`kbox` is a tamper-resistance parameter produced by white-box AES. This
implementation does not send it and still receives real nodes on the brands
measured: without it the server issues nodes from `apps`, which is
`MD5(cert SHA1 + device id)`. That is why no white-box AES port is needed on the
Node side.

This was re-verified for 黑洞 with the real `libcryptbox.so` emulated and the
parameter appended: `kbox` present and absent produce the identical placeholder
body on the Android channel, so it is not the cause of the downgrade.

## Compatibility with the URL mode

A source without `mode` is still treated as `url`. A source carrying `account`
but no `url` is treated as `credential`. Existing profiles keep running
unchanged: the pipeline reads a url row exactly as before.

The settings drawer edits only the four vendor rows. A profile that also
carries a url-mode source (a custom relay) keeps it across a drawer save: the
row is passed through untouched, and the drawer's validation ignores it because
it renders no field for it. To edit such a row, edit `profile.toml` directly.
