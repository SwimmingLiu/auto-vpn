# v3 Node Mihomo Runtime Foundation Implementation Plan

**Goal:** Add the deterministic Node foundation needed for full per-node Mihomo proxy speedtest and availability parity.

**Architecture:** Port the Python proxy runtime's vmess parsing, Mihomo config generation, proxy environment cleanup, process lifecycle, controller proxy selection, controller delay probe, proxied speedtest downloads, and proxied availability checks into Node modules. Keep each slice deterministic and covered by unit tests while preserving Python rollback flags until v3 cutover is complete.

## Tasks

- [x] Add a failing Node test for websocket TLS vmess config generation.
- [x] Add a failing Node test for stripping inherited proxy environment variables.
- [x] Implement `parseVmessLink()`.
- [x] Implement Python-compatible `buildMihomoRuntimeConfig()`.
- [x] Implement `stripProxyEnv()`.
- [x] Implement temp config creation, Mihomo child process startup, port waiting, and cleanup.
- [x] Implement automatic local port allocation.
- [x] Implement controller `GLOBAL` proxy selection and `/delay` probe helpers.
- [x] Wire Node speedtest probe phase to Mihomo controller delay when `AUTOVPN_SPEEDTEST_RUNTIME=mihomo`.
- [x] Wire Node speedtest candidate downloads through the local Mihomo HTTP proxy when `AUTOVPN_SPEEDTEST_RUNTIME=mihomo`.
- [x] Wire Node availability checks through the local Mihomo HTTP proxy when `AUTOVPN_AVAILABILITY_RUNTIME=mihomo`.
- [x] Update CLI docs to distinguish Mihomo runtime foundation from full proxy parity.
- [x] PR, CI, merge, cleanup, and package latest main for runtime lifecycle foundation.
- [x] PR, CI, merge, cleanup, and package latest main for speedtest probe wiring.
- [x] PR, CI, merge, cleanup, and package latest main for proxied speedtest downloads.
- [ ] PR, CI, merge, cleanup, and package latest main for proxied availability checks.

## Follow-Up Boundaries

- `resume-latest`, non-detached `resume`, and non-detached `retry-stage`.

## Validation

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "Node proxy runtime"
```
