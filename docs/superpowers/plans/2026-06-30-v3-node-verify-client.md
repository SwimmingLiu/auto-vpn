# v3 Node Verify Client

## Goal

Move the Cloudflare verification stage from mandatory Python fallback to a Node-native backend while keeping Cloudflare Pages deployment on the Python adapter until the Wrangler deployment path is migrated separately.

## Scope

- Add a Node `CloudflareVerifyClient` boundary for URL checks, CNAME verification, and blocked Pages project cleanup.
- Add `CloudflareHttpClient` for real Cloudflare API calls used by verification cleanup.
- Keep `deployPagesWithBackend` guarded behind explicit Python fallback.
- Keep explicit Python verify fallback available through `AUTOVPN_STAGE_BACKEND_VERIFY=python`.
- Cover Node verify behavior with mocked clients and Cloudflare HTTP fetch tests.

## Implementation Notes

- `verifyDeploymentWithBackend()` now defaults to Node for the verify stage.
- The Node verify target is built with `mergeDeployVerificationTarget()` so deployment-returned `project_name`, `pages_project_url`, and `custom_domain` override profile values just like Python.
- `defaultVerifyDeployment()` mirrors Python `_default_verify()` result keys:
  - `pages_domain_ok`
  - `secret_ok`
  - `subscription_ok`
  - `custom_domain_ok`
  - `custom_domain_subscription_ok`
  - `custom_domain_dns_ok`
- Cleanup only runs after `isVerifySuccess()` returns true, matching Python.
- `CloudflareHttpClient` uses API-token or global-key headers from existing credential resolution.

## Remaining v3 Work

- Port Pages deployment/Wrangler execution to Node or a Node-owned process adapter.
- Add live/sandbox Cloudflare verification for the Node client when credentials are available.
- Run final end-to-end regression after deploy and verify are both Node-native.
