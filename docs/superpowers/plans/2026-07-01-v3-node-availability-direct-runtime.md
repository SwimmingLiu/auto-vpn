# v3 Node Availability Direct Runtime Implementation Plan

**Goal:** Remove the injected `checkLinkAvailability` requirement from the Node availability backend by adding a direct HTTP provider-check runtime that can run under `AUTOVPN_NO_PYTHON=1`.

**Architecture:** Keep existing injected `checkLinkAvailability` hooks for fixture parity and future proxy-based integration. When no hook is provided, Node fetches each configured provider target directly, evaluates host/status/challenge/negative phrase rules with the existing deterministic helpers, and emits the same availability result shape.

## Tasks

- [x] Add a failing test proving Node availability can run without injected `checkLinkAvailability`.
- [x] Implement direct provider fetch with timeout.
- [x] Reuse `evaluateProviderResponse()` for host/status/challenge/negative phrase semantics.
- [x] Preserve existing injected-hook behavior and Python rollback flags.
- [x] Update docs to distinguish direct runtime from full proxy-based availability parity.
- [x] Run targeted validation.
- [x] Run full local validation and local review.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Full per-node Mihomo proxy speedtest parity in Node.
- Full proxy-based availability parity in Node.
- `resume-latest`, non-detached `resume`, and non-detached `retry-stage`.

## Validation

```bash
rtk proxy npm run build --prefix npm/autovpn-cli
rtk proxy node --test npm/autovpn-cli/test/pipeline/availability.test.mjs
```
