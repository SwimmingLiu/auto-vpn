# v3 Node Speedtest Direct Runtime Implementation Plan

**Goal:** Remove the injected-adapter requirement from the Node speedtest backend by adding a direct HTTP probe/download runtime that can run under `AUTOVPN_NO_PYTHON=1`.

**Architecture:** Keep existing injected `probeLinks` / `testLink` hooks for fixture parity and future Mihomo integration. When hooks are not provided, the Node backend uses `fetch` directly for probe latency and configured download URLs. This is a v3 readiness step, not full per-node Mihomo proxy parity.

## Tasks

- [x] Add a failing test proving Node speedtest can run without injected `probeLinks` and `testLink`.
- [x] Implement direct probe fetch with timeout and latency measurement.
- [x] Implement direct download measurement with `max_download_bytes`.
- [x] Preserve existing injected-hook behavior and Python rollback flags.
- [x] Update docs to distinguish direct runtime from full Mihomo proxy parity.
- [x] Run targeted validation.
- [x] Run full local validation and local review.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Full per-node Mihomo proxy speedtest parity in Node.
- Full proxy-based availability parity in Node. Node now has direct HTTP availability runtime without injected `checkLinkAvailability`.
- `resume-latest`, non-detached `resume`, and non-detached `retry-stage`.

## Validation

```bash
rtk proxy npm run build --prefix npm/autovpn-cli
rtk proxy node --test npm/autovpn-cli/test/pipeline/speedtest.test.mjs
```
