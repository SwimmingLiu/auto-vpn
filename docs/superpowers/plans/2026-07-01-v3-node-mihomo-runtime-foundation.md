# v3 Node Mihomo Runtime Foundation Implementation Plan

**Goal:** Add the deterministic Node foundation needed for full per-node Mihomo proxy speedtest and availability parity.

**Architecture:** Port the Python proxy runtime's vmess parsing, Mihomo config generation, and proxy environment cleanup into a Node module first. Keep this slice deterministic and covered by golden-style tests; process lifecycle, controller delay probes, and proxied download/availability requests remain the next implementation slice.

## Tasks

- [x] Add a failing Node test for websocket TLS vmess config generation.
- [x] Add a failing Node test for stripping inherited proxy environment variables.
- [x] Implement `parseVmessLink()`.
- [x] Implement Python-compatible `buildMihomoRuntimeConfig()`.
- [x] Implement `stripProxyEnv()`.
- [x] Update CLI docs to distinguish Mihomo runtime foundation from full proxy parity.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Start and clean up Mihomo child processes from Node.
- Select `GLOBAL` through Mihomo's external controller.
- Probe per-node latency through Mihomo `/delay`.
- Run speedtest download URLs and availability targets through the local Mihomo proxy.
- `resume-latest`, non-detached `resume`, and non-detached `retry-stage`.

## Validation

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "Node proxy runtime"
```
