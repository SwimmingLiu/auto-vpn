# v3 Verify/Cleanup Helper Parity

## Goal

Move the deterministic, no-network parts of Python deployment verification into the Node CLI backend so the v3 CLI can keep shrinking Python fallback scope without changing runtime behavior.

## Scope

- Port verify subscription URL resolution.
- Port custom-domain verify subscription URL resolution.
- Port deploy verification target merge semantics.
- Port cleanup-blocked-project candidate selection and no-op result shape.
- Keep Cloudflare verification requests and Pages project deletion in the Python fallback until a mocked/tested Node Cloudflare client exists.

## Implementation Notes

- `resolveVerifySubscriptionUrl(deploy)` mirrors Python `_resolve_verify_subscription_url`: prefer trimmed `verify_subscription_url`, then trimmed `subscription_url`.
- `resolveCustomDomainVerifySubscriptionUrl(deploy)` delegates to `buildCustomDomainSubscriptionUrl(deploy)` and trims the result.
- `mergeDeployVerificationTarget(deploy, deployment)` copies deployment values only for `project_name`, `pages_project_url`, and `custom_domain`; key presence matters, so empty values still overwrite like Python `dict.update`.
- `resolveCleanupBlockedProjectCandidates(deploy, deployment)` trims candidates from `cleanup_blocked_project` and `share_project_cleanup_blocked_project`, skips empty values, skips the final project, and deduplicates.
- `buildNoopCleanupBlockedProjectResult(deployment)` preserves Python's no-candidate result shape: `cleanup_deleted: false` and existing `cleanup_errors` or `[]`.

## Validation

- Add focused Node tests in `npm/autovpn-cli/test/pipeline/deploy.test.mjs`.
- Run targeted pipeline tests.
- Run the full npm CLI suite.
- Run Electron and Python regression suites.
- Run `npm pack --dry-run` to verify package buildability.
