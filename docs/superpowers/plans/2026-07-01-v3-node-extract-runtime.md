# v3 Node Extract Runtime Implementation Plan

**Goal:** Move the minimal encrypted source fetch path for `extract` into the Node CLI backend and let `AUTOVPN_NO_PYTHON=1` offline runs complete when no nodes are produced.

**Architecture:** Keep Python fallback available through `AUTOVPN_STAGE_BACKEND_EXTRACT=python`, but make the Node default capable of direct HTTPS fetch, AES-CBC decrypt, vmess plaintext conversion, de-duplication, plateau stopping, and failure counting. Proxy retry and full extract event parity remain follow-up work.

## Tasks

- [x] Add a failing Node extract runtime test for encrypted source fetch without Python fallback.
- [x] Add a failing availability test proving empty inputs do not require a runtime checker.
- [x] Add a failing orchestrator test for no-python offline runs with no configured source URL/key.
- [x] Implement minimal Node extract direct fetch/decrypt loop.
- [x] Skip sources that do not have both URL and key in the Node orchestrator.
- [x] Return empty availability results without requiring a checker.
- [x] Update README docs to reflect the new no-python offline behavior.
- [x] Run targeted tests and manual no-python offline smoke.
- [x] Run full local validation and local review.
- [ ] PR, CI, merge, cleanup, and package latest main.

## Follow-Up Boundaries

- Node extract proxy retry and structured extract event parity.
- Non-empty Node speedtest runtime without injected `probeLinks` / `testLink`.
- Non-empty Node availability runtime without injected `checkLinkAvailability`.
- `resume-latest`, non-detached `resume`, and non-detached `retry-stage`.

## Validation

```bash
rtk proxy npm run build --prefix npm/autovpn-cli
rtk proxy node --test npm/autovpn-cli/test/pipeline/extract.test.mjs npm/autovpn-cli/test/pipeline/availability.test.mjs npm/autovpn-cli/test/pipeline/orchestrator.test.mjs
rtk proxy env AUTOVPN_NO_PYTHON=1 AUTOVPN_BACKEND=node node npm/autovpn-cli/bin/autovpn.mjs run --project-root . --skip-deploy --skip-verify --output jsonl
```
