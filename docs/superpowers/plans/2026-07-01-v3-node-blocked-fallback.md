# v3 Node Blocked Pages Fallback

## Goal

Move primary Cloudflare Pages blocked-project recovery from the Python deploy adapter into the Node CLI backend without changing the Python-compatible deploy summary shape.

## Scope

- Detect Cloudflare Pages blocked-project deploy errors in the Node Wrangler deploy path.
- List existing Pages projects and generate the next fallback project name with the same suffix behavior as Python.
- Create the fallback Pages project through Cloudflare's API.
- Copy production deployment config from the blocked project to the fallback project.
- Resolve `secret_text` environment variables from runtime env, with `ADMIN` defaulting to the profile's `pages_secret_admin` value or `swimmingliu`.
- Retry Wrangler deploy against the fallback project and return compatible `fallback_used`, `fallback_last_used_suffix`, `fallback_candidate_names`, `cleanup_blocked_project`, and final project URL fields.

## Implementation Notes

- `CloudflareDeployClient` extends the existing verify client so tests can inject a fake Cloudflare deploy surface without network access.
- `CloudflareHttpClient` now owns Pages project list/get/create/update helpers plus `copyPagesProjectConfig`.
- Secret cloning never reads secret values back from Cloudflare because Cloudflare does not expose them; values must come from profile/env defaults.
- Custom-domain binding remains guarded behind explicit Python deploy fallback. Share-project sync is handled in the follow-up Node share sync slice.

## Tests

- Unit test the blocked primary deploy flow, including fallback name selection, copied config call, attempt metadata, cleanup target, and final URL.
- Unit test Cloudflare deployment config cloning with resolved secret values, plain text env vars, KV bindings, and compatibility metadata.
- Keep Python fallback tests for custom-domain and share-project side effects.
- Run the full npm CLI suite, Electron regression suite, Python pytest suite, and npm packaging dry run before merging.

## Remaining v3 Work

- Port custom-domain attach/detach and DNS upsert.
- Add live/sandbox deploy tests when Cloudflare credentials are available.
