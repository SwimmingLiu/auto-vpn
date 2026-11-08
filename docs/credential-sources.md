# Official-site credential sources

A source has two modes. The older `url` mode requires pasting a request URL that
already carries a session token, so every token expiry forces a fresh capture.
The `credential` mode only needs an official site and an account; everything
else is discovered on each run.

## Configuration

```toml
[sources]
[sources.brand_a]
mode = "credential"
official_site = "https://<OFFICIAL_SITE>"
account = "<ACCOUNT>"
password = "<PASSWORD>"
platform = "android"
enabled = true
```

| Field | Required | Meaning |
|---|---|---|
| `mode` | yes | `credential` or `url` |
| `official_site` | yes | Official site; the current APK is located from here |
| `account` / `password` | yes | Login credentials |
| `platform` | no | `android` (default) or `ios` |
| `max_areas` | no | Maximum routes to request; all routes when omitted |
| `max_iterations` | no | Upper bound on fetch rounds; `1` when omitted |
| `min_iterations` | no | Rounds that always run before early stopping; `0` when omitted |
| `plateau_limit` | no | Consecutive rounds with no new node that stop the run; `2` when omitted |
| `max_runtime_seconds` | no | Wall-clock budget past `min_iterations`; `0` means unlimited |
| `device_id` | no | Fixed device id; a built-in default when omitted |
| `key` | no | Control-plane AES key; discovered automatically when omitted |
| `code` | no | Invite code; the client's default when omitted |

`apk_url` or `apk_path` can be set instead of `official_site` to skip discovery.

## Run sequence

```
official site -> download page chunk -> cdn.js
              -> candidate APK URLs (walking back a few publish slots)
              -> APK: package / version / signing cert / seed domains
              -> /api/eversion       control-plane key, api_links, api_lines
              -> /myapi/eapilogin    session token
              -> /myapi/eapiuserinfo membership level, unlimited flag
              -> /myapi/apinodelist  clickable route ids
              -> /api/evmess?area=ID one vmess link per route
```

`/myapi/apinodelist` is the only endpoint that answers in plain JSON; the rest
are AES-CBC with key == IV.

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

Defaults are a single round, so a profile that does not set these behaves as
before. Raising them trades run time for pool size; the gain is front-loaded.

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
download) and about 7s on a cache hit. Entries are keyed by brand, so two
profile sources of the same brand (for example one `android` and one `ios`)
share one inspection and one cache file.

## Platform differences

| | Android | iOS |
|---|---|---|
| Response | `vmess://<base64>` | `ps\|<v2ray config>` |
| Size per node | ~384 B | ~2944 B |
| `kbox` | always appended by the APK | not sent |

`kbox` is a tamper-resistance parameter produced by white-box AES. This
implementation does not send it and still receives real nodes: without it the
server issues nodes from `apps`, which is `MD5(cert SHA1 + device id)`. That is
why no white-box AES port was needed on the Node side.

## Known limitation

One brand's Android channel returns a placeholder node. `/api/evmess` answers
with a fixed `1.1.1.1:443` template and ignores `area`, while the same account
works on the iOS channel. On the same host, `/api/rules` and
`/myapi/apinodelist` answer normally with identical Android parameters, so the
downgrade is scoped to that one endpoint rather than the client being rejected.
Profiles for that brand should set `platform = "ios"`.

## Compatibility with the URL mode

A source without `mode` is still treated as `url`. A source carrying `account`
but no `url` is treated as `credential`. Existing profiles need no changes.
