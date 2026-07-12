# Task 9 Report: Restore Production GeoIP Lookup

## Status

Implemented production GeoIP lookup for normal, retry, and resume pipeline paths. Per the latest product decision, unknown or failed detection falls back to `US`; successful detection retains the actual country.

## RED evidence

Command:

`rtk node --test npm/autovpn-cli/test/pipeline/geoip.test.mjs npm/autovpn-cli/test/pipeline/postprocess.test.mjs npm/autovpn-cli/test/pipeline/orchestrator.test.mjs electron/tests/artifact-preview.test.mjs`

Initial result: 3 failures. `geoip.js` did not exist, postprocess produced `🇺🇸 US` for `ZZ`, and artifact preview returned `ZZ` instead of `OTHER`.

## Root cause

- `orchestrator.ts` used `defaultCountryFor()` returning `US` unconditionally in normal, retry, and resume paths.
- No production GeoIP provider was called.
- `postprocess.ts` normalized empty, invalid, and `ZZ` country values to `US` and used the US flag as its emoji fallback.
- Artifact preview treated `ZZ` as an ordinary region code.

## Implementation

- Added `createGeoIpLookup(options?)` with IPv4/IPv6 literal handling and injected A/AAAA DNS resolution.
- Added strict `ipwho.is` primary response validation and configurable fallback URL (default `ipapi.co`).
- Added bounded request timeouts, strict HTTP/schema failure handling, and bounded `429 Retry-After` delay before fallback.
- Added successful-result caching, short negative caching for failed lookups, and in-flight deduplication keyed by resolved IP.
- The orchestrator parses the VMess server `add` value and awaits one run-local lookup in normal, retry, and resume paths. Existing `countryLookup` injection remains supported.
- Unknown/invalid values now decorate and preview as `🇺🇸 US`; successful non-US provider values remain unchanged.

## Deterministic network and concurrency evidence

All GeoIP tests use injected `fetch`, resolver, timer/clock, and sleep functions; no test performs live network I/O. Tests cover IPv4 AU, IPv6, domain A/AAAA results, primary success, 429 with bounded Retry-After and fallback success, malformed schema, timeout, dual failure, positive cache, negative TTL expiry, resolver failure, and concurrent deduplication by resolved IP.

## Verification

- Focused Task 9 tests: 73 passed, 0 failed.
- Full CLI: `rtk npm test` in `npm/autovpn-cli`: 352 passed, 0 failed.
- Focused Electron artifact/UI: 59 passed, 0 failed.
- Full Electron suite: 147 passed, 4 failed. Two failures are local Electron installation failures. Two are pre-existing/unrelated visual baseline mismatches on dashboard/runs/logs; the results-page visual hash (the surface affected by this task) matched its baseline, as did the focused artifact/UI contract suite.
- `rtk git diff --check`: clean.

## Self-review

- No live network dependency exists in tests.
- Provider dual failure, DNS failure, rejected/non-global addresses, and invalid country values fall back to `US`.
- Real provider `US` values and failure fallback both render as US, while internal detection metadata preserves short negative TTL behavior.
- Cache TTLs and Retry-After waits are bounded and injectable.
- Concurrent hostname resolutions that yield the same IP share the provider request.

## Commit

`fix: restore reliable geoip lookup`

## Attention points

- The full Electron suite remains externally blocked by the local Electron binary installation and unrelated visual baselines described above.
- Provider URLs are configurable through `createGeoIpLookup` options; production defaults are HTTPS `ipwho.is` and `ipapi.co`.

## Review follow-up

Addressed the P1 and three P2 review findings with new RED/GREEN coverage:

- Renderer `buildRegionStats` prioritizes preview `row.regionCode`; `ZZ`, `OTHER`, and missing regions now merge into `US`. Both region-stat model and rendered results markup are covered.
- Domain lookup preserves resolver order, skips non-global addresses, and tries each unique resolved IP until one is successfully detected. Per-IP positive/negative caches and in-flight deduplication remain unchanged.
- `Retry-After` accepts both delta-seconds and HTTP-date values, evaluates HTTP dates against the injected clock, and clamps both formats to `maxRetryAfterMs`.
- Provider URL builders are validated before fetch: HTTPS only, exact `ipwho.is`/`ipapi.co` host, no credentials or non-default port after URL canonicalization. HTTP and foreign-host outputs return provider failure without any fetch call.

Follow-up verification:

- Focused GeoIP/pipeline/artifact/renderer contracts: 106 passed, 0 failed.
- Full CLI: 355 passed, 0 failed.
- Focused Electron artifact/UI/Playwright: 66 passed, 1 unrelated visual aggregate failure. Results-page visual hash matched exactly; only the previously noted dashboard/runs/logs hashes differ.
- `rtk git diff --check`: clean.

## Special-use IP review follow-up

- Replaced the partial string-prefix check with numeric IPv4 CIDR and parsed IPv6 classification.
- IPv4-mapped IPv6 addresses are normalized back to canonical dotted IPv4 before classification, provider lookup, cache lookup, and in-flight deduplication.
- Rejects IPv4 unspecified, private, CGNAT, loopback, link-local, protocol-assignment, documentation, benchmark, multicast, and reserved ranges.
- Rejects IPv6 unspecified, loopback, ULA, link-local, multicast, documentation, and mapped non-global IPv4; only global-unicast IPv6 is sent to GeoIP providers.
- Table-driven regression coverage proves every rejected address causes zero fetches and that representative global IPv4/IPv6 addresses still resolve. A mapped public IPv4 shares the canonical IPv4 cache entry.
- Final special-use-IP verification: focused Task 9 contracts 108 passed, 0 failed; full CLI 357 passed, 0 failed.

## IPv6 canonical-key review follow-up

- Native IPv6 addresses now use a parsed 128-bit value to produce one RFC 5952-style key: lowercase hexadecimal, leading zero suppression, and first-longest zero-run compression.
- Equivalent compressed, fully expanded, and uppercase spellings share provider URLs, in-flight work, positive cache entries, negative cache entries, and resolver-result deduplication.
- IPv4-mapped IPv6 behavior remains canonical dotted IPv4 and therefore shares IPv4 cache/in-flight keys.
- A deterministic concurrent regression test proves three equivalent native IPv6 spellings issue exactly one provider request and subsequent variants are positive-cache hits.
- Final IPv6 canonicalization verification: GeoIP 15 passed, Task 9 focused 109 passed, and full CLI 358 passed; all had zero failures.

## Product fallback update

- Latest product decision changes the external unknown/failure result from `ZZ/OTHER` to `US` across GeoIP, postprocess, Electron artifact preview, and renderer region statistics.
- Internal `{ country, detected }` metadata distinguishes a successfully detected real US result from a failure fallback, preserving short negative TTL and multi-address continuation behavior.
- Successful provider detection still emits the actual country code (including non-US countries); only exhausted, invalid, rejected, or unresolved lookups fall back to US.
- Verification: Task 9 CLI/Electron focused suite 138 passed, renderer Playwright and pixel/visual suite 6 passed, and full CLI 358 passed; all had zero failures.
