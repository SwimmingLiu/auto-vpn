# v3 Deploy/Verify Boundary Plan

## Goal

Start the v3 migration by giving the Node backend an explicit deploy/verify stage boundary without making the Node implementation silently perform live Cloudflare work by default.

This is the first v3 step after the v2 Node non-deploy orchestrator:

- keep `AUTOVPN_BACKEND=node` safe by default;
- keep direct Node deploy/verify unavailable until full Cloudflare parity exists;
- allow explicit Python stage fallback for deploy/verify;
- let the Node orchestrator own full pipeline ordering, artifact reports, stage statuses, and redaction.

## Scope

Implemented in this step:

- `npm/autovpn-cli/src/pipeline/deploy.ts`
  - deploy adapter boundary;
  - verify adapter boundary;
  - explicit Python fallback using `AUTOVPN_STAGE_BACKEND_DEPLOY=python` and `AUTOVPN_STAGE_BACKEND_VERIFY=python`;
  - absolute `AUTOVPN_PYTHON_CLI` requirement for helper mode so the adapter does not guess the wrong interpreter from a PATH `autovpn`;
  - verify success predicate matching the Python controller semantics.
- `npm/autovpn-cli/src/pipeline/orchestrator.ts`
  - call deploy/verify adapters instead of hard failing after obfuscate;
  - preserve `skipDeploy` / effective `skipVerify` behavior;
  - write redacted deployment data into `pipeline_report.json`;
  - mark deploy/verify stage success/failure/skipped consistently.
- `npm/autovpn-cli/src/backend/node-backend.ts`
  - keep default deploy/verify rejection;
  - only allow full foreground Node runs when fallback for deploy/verify is explicit.

Not implemented yet:

- native Node Cloudflare API client;
- native Wrangler deploy runner;
- custom domain and share-project sync in Node;
- live Cloudflare integration tests.

## Test Evidence

Required local gates for this step:

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy node --test electron/tests/*.test.mjs
rtk proxy uv run --with pytest pytest tests -q
rtk proxy npm pack --dry-run
```

The v3 migration is not complete after this step. The next v3 task should migrate the deterministic Cloudflare helper pieces first: credential/env resolution, URL building, deploy command construction, verification target merge, and verify success logic.
