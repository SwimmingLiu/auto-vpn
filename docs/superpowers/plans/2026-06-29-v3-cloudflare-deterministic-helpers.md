# v3 Cloudflare Deterministic Helpers Plan

## Goal

Continue the v3 Node backend migration by moving Cloudflare deploy/verify helper logic that does not touch the network into Node.

This step deliberately avoids live Cloudflare API calls and Wrangler execution. The purpose is to make Node own more of the deploy/verify contract while keeping production deploy safety intact.

## Implemented Scope

- URL and command helpers:
  - Pages deploy command construction
  - Pages project URL derivation
  - secret URL construction
  - Pages/custom-domain root URL construction
  - URL host rewrite
  - custom-domain subscription URL derivation
  - custom-domain DNS target derivation
- fallback naming helpers:
  - fallback base-name derivation
  - next fallback project-name generation
  - latest existing fallback project-name resolution
- auth helpers:
  - Cloudflare API-token credential resolution
  - Cloudflare global-key credential resolution
  - Wrangler auth environment construction
- tests in `npm/autovpn-cli/test/pipeline/deploy.test.mjs` covering Python-compatible behavior and safety cases.

## Still Deferred

- Native Node Cloudflare REST client.
- Native Wrangler process runner.
- Pages fallback project creation/copy/delete flows.
- share-project sync.
- custom-domain DNS upsert/verify network calls.
- live deploy/verify integration tests.

## Verification Gate

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy node --test electron/tests/*.test.mjs
rtk proxy uv run --with pytest pytest tests -q
rtk proxy npm pack --dry-run
```

The next v3 step should either migrate the pure verification-target merge helpers or introduce a mocked Cloudflare REST client with no live credentials required.
