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
max_iterations = 4
plateau_limit = 2
```

| Field | Required | Meaning |
|---|---|---|
| `mode` | yes | `credential` (the four vendor rows are always credential) |
| `official_site` | yes | Official site; the current APK is located from here |
| `max_iterations` | no | Upper bound on route-loop rounds; `4` when omitted |
| `plateau_limit` | no | Consecutive rounds with no new node that stop the run; `2` when omitted |
| `min_iterations` | no | Rounds that always run before early stopping; `0` when omitted |
| `max_runtime_seconds` | no | Wall-clock budget past `min_iterations`; `0` means unlimited |
| `device_id` | no | Fixed device id; a built-in default when omitted |
| `apk_url` / `apk_path` | no | Pin a specific build instead of site discovery |
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

One pass over all routes therefore collects only one host per route. `max_iterations`
repeats the pass, merging each round into the pool and skipping links already
seen:

| Setting | Effect |
|---|---|
| `max_iterations` | Upper bound on rounds |
| `min_iterations` | Rounds that always run, even after the pool stops growing |
| `plateau_limit` | Consecutive dry rounds that end the run, once past `min_iterations` |
| `max_runtime_seconds` | Wall-clock budget, likewise only after `min_iterations` |

The four vendor rows ship `max_iterations = 4` / `plateau_limit = 2`, the
documented scheduled-run default. Raising the cap trades run time for pool
size; the gain is front-loaded.

Measured on one account, all routes, one machine:

| Rounds | Unique nodes | Gain | Time |
|---|---|---|---|
| 1 | 42 | — | 37s |
| 3 | 57 | +36% | 93s |
| 8 | 78 | +86% | 234s |

Each round costs roughly 30s, and the per-round gain falls from +15 to +2 by the
sixth. `max_iterations = 4` with `plateau_limit = 2` is a reasonable default for
a scheduled run; raise it when a wider pool matters more than the wait.

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

## One brand's Android channel answers with placeholders

`/api/evmess` for 黑洞 answers with a fixed `1.1.1.1:443` template and ignores
`area` on the Android channel, while the same account works on iOS. On the same
host `/api/rules` and `/myapi/apinodelist` answer normally with identical Android
parameters, so the downgrade is scoped to that one endpoint rather than the
client being rejected.

Because both channels run for every source, this brand still produces its real
nodes from the iOS channel in the same run; its Android placeholders are counted
and dropped. No per-profile `platform` switch is needed.

## Compatibility with the URL mode

A source without `mode` is still treated as `url`. A source carrying `account`
but no `url` is treated as `credential`. Existing profiles keep running
unchanged: the pipeline reads a url row exactly as before.

The settings drawer edits only the four vendor rows. A profile that also
carries a url-mode source (a custom relay) keeps it across a drawer save: the
row is passed through untouched, and the drawer's validation ignores it because
it renders no field for it. To edit such a row, edit `profile.toml` directly.
