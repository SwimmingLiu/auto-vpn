# v3 Node Basic Deploy

## Goal

Move the simplest Cloudflare Pages deploy path into the Node CLI backend while preserving Python fallback for high-risk deploy side effects.

## Scope

- Run `npx wrangler pages deploy <bundle> --project-name <name> --branch main` from Node.
- Match Python's direct, direct-retry, and optional proxy retry attempt order for transient deploy failures.
- Return the Python-compatible deployment summary fields required by the orchestrator, profile update, and verify stage.
- Keep explicit Python deploy fallback through `AUTOVPN_STAGE_BACKEND_DEPLOY=python`.
- Keep custom-domain binding, share-project sync, and blocked Pages fallback on Python for now.

## Implementation Notes

- The Node deploy path uses existing Cloudflare credential resolution and Wrangler auth environment generation.
- Proxy selection follows the same environment keys as Python: `VPN_AUTOMATION_DEPLOY_PROXY`, `VPN_AUTOMATION_CLOUDFLARE_PROXY`, `VPN_AUTOMATION_UPSTREAM_PROXY`, and standard proxy variables.
- Complex deploy side effects fail fast with a message telling users to set `AUTOVPN_STAGE_BACKEND_DEPLOY=python`.
- Node verify remains the default after deploy.

## Remaining v3 Work

- Port blocked-project fallback project creation and config cloning.
- Port share-project subscription sync and share fallback.
- Port custom-domain attach/detach and DNS upsert.
- Add live/sandbox deploy tests when Cloudflare credentials are available.
