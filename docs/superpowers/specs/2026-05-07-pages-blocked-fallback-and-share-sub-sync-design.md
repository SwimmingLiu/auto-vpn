# Pages Blocked Fallback and Share `SUB` Sync Design

## Summary

This change extends the existing Cloudflare Pages deploy pipeline so blocked Pages projects can recover automatically and the downstream share project keeps pointing at the latest working Pages URL.

When the primary Pages project (for example `sub-nodes`) is blocked by Cloudflare with error `8000119`, the pipeline should:

1. create a replacement Pages project using a two-digit numeric suffix such as `sub-nodes-01`,
2. copy the original project's deployment configuration into the replacement project,
3. redeploy the generated `pages_bundle` to that replacement project,
4. update the configured share project (for example `sub-links-share-03`) so its `SUB` environment variable points to the replacement Pages project URL such as `https://sub-nodes-01.pages.dev`,
5. if the share project is also blocked, create a replacement share project using the same two-digit suffix rule such as `sub-links-share-04`,
6. verify the final node project and final share project before deleting any blocked source project.

The `SUB` value must be the replacement Pages project root URL only. It must not be rewritten to a secret URL or a subscription URL with extra query parameters.

## Goals

- Automatically recover from Cloudflare blocked-project deploy failures for the primary Pages project.
- Preserve deterministic fallback naming using `-01`, `-02`, `-03`, and so on.
- Automatically update the share project `SUB` environment variable to the final working Pages project URL.
- Apply the same blocked-project fallback logic to the share project itself when needed.
- Delay deletion of blocked source projects until replacement deploy and verification succeed.
- Reuse as much as possible from the existing fallback implementation already explored in the `pages-fallback-auto-create` worktree.

## Non-Goals

- Replacing the existing Wrangler-based Pages deploy command.
- Changing how `_worker.js`, `pages_bundle`, or the subscription payload is generated.
- Introducing custom-domain-specific logic beyond preserving current behavior where already supported.
- Rewriting unrelated Electron deploy UI behavior beyond exposing any new config that is strictly needed.

## Current State

The current main branch deploy flow can:

- build the Pages bundle,
- call `wrangler pages deploy <bundle_dir> --project-name <project_name> --branch main`,
- verify the resulting Pages project URL and subscription URL.

When Cloudflare returns blocked-project error `8000119`, the run fails at `deploy`.

There is already a more advanced fallback implementation in:

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-fallback-auto-create/src/vpn_automation/integrations/cloudflare.py`

That worktree already contains:

- blocked-project detection,
- fallback project-name generation with two-digit suffixes,
- Pages project create/read/update/delete helpers,
- deployment config cloning,
- fallback deploy retry,
- delayed cleanup of blocked source projects after verify.

However, that worktree does not fully implement the required share-project `SUB` synchronization behavior:

- it preserves copied `deployment_configs`,
- but it does not explicitly rewrite `SUB` to the new Pages project URL in the final share project,
- and it does not fully model the case where the share project itself must fallback and then receive the rewritten `SUB`.

## Requirements

### 1. Primary Pages project fallback

If deploy to the requested primary Pages project fails with a blocked-project error:

- detect the blocked condition using the existing blocked marker strategy,
- list existing Pages project names,
- generate a replacement project name using:
  - `sub-nodes` -> `sub-nodes-01`
  - `sub-nodes-01` exists -> `sub-nodes-02`
  - and so on,
- create the replacement project,
- copy the original deployment configuration,
- redeploy the same `pages_bundle` to the replacement project,
- treat the replacement project URL as the final `pages_project_url` for the rest of the pipeline.

### 2. Share project `SUB` rewrite

After the final primary Pages project is known, update the configured share project so:

- `deployment_configs.preview.env_vars.SUB.value == <final pages project url>`
- `deployment_configs.production.env_vars.SUB.value == <final pages project url>`

Example:

- final node Pages project: `sub-nodes-01`
- final node Pages URL: `https://sub-nodes-01.pages.dev`
- rewritten `SUB`: `https://sub-nodes-01.pages.dev`

The `SUB` value must not include:

- `/?serect_key=...`
- `/sub?...`
- any derived verify URL

It is only the final Pages project root URL.

### 3. Share project blocked fallback

If the target share project is blocked while being updated or deployed:

- generate a replacement share project name using the same two-digit rule,
- for example `sub-links-share-03` -> `sub-links-share-04`,
- create the replacement share project,
- copy the original share project deployment config,
- rewrite both preview and production `SUB` values to the final primary Pages project URL,
- continue using the replacement share project as the final share target.

### 4. Safe cleanup

Blocked source projects must only be deleted after:

- replacement project creation succeeds,
- replacement deploy succeeds,
- required verification succeeds.

This applies independently to:

- the primary Pages project,
- the share project.

If verification fails, cleanup must be skipped and the failure must be reported in deployment metadata.

## Recommended Architecture

Use two layers.

### Layer A: Pages project fallback

Keep the low-level fallback logic inside the Cloudflare integration layer.

Primary responsibility:

- detect blocked deploys,
- create replacement Pages projects,
- clone deploy config,
- retry Wrangler deploy,
- return rich deployment metadata describing requested project, final project, fallback usage, and pending cleanup.

This is the part that already exists in the fallback worktree and should be ported with minimal structural change.

### Layer B: Share project synchronization

Add a separate helper responsible for the share project only.

Primary responsibility:

- locate the configured share project,
- rewrite its `SUB` env var to the final primary Pages URL,
- if that share project is blocked, create a replacement share project and repeat the rewrite there,
- return final share project metadata plus any cleanup information.

This helper should run only after the final primary Pages project name and final Pages URL are known.

This separation keeps the primary node deploy path and the share-project sync path independently understandable and testable.

## Data Model Changes

Extend deploy config with explicit share-project settings.

Recommended fields:

- `auto_create_project_on_blocked: bool = True`
- `fallback_project_prefix: str = ""`
- `share_project_name: str = "sub-links-share-03"`
- `share_project_auto_fallback: bool = True`
- `share_project_fallback_prefix: str = "sub-links-share"`
- `share_project_sub_env_key: str = "SUB"`

Rules:

- if `fallback_project_prefix` is blank, fallback naming uses `project_name`,
- share-project fallback naming uses `share_project_fallback_prefix`,
- `share_project_sub_env_key` defaults to `SUB`,
- if `share_project_name` is blank, skip share-project synchronization entirely.

These fields must round-trip through:

- `DeployConfig`,
- TOML persistence,
- packaged default profile,
- any Electron deploy settings UI that exposes deploy settings.

## Deployment Metadata Changes

Extend deployment result metadata so later stages can reason about both projects.

Recommended new result keys:

- `requested_project_name`
- `project_name`
- `pages_project_url`
- `fallback_used`
- `cleanup_blocked_project`
- `share_project_requested_name`
- `share_project_name`
- `share_project_fallback_used`
- `share_project_cleanup_blocked_project`
- `share_project_sub_value`
- `share_project_sync_ok`
- `share_project_sync_error`

These fields should be persisted into `pipeline_report.json` so failures remain debuggable from artifacts alone.

## Detailed Flow

### Step 1: Deploy the primary Pages project

Call the existing deploy helper.

If the requested project deploys successfully:

- keep `project_name` unchanged,
- keep `pages_project_url` unchanged.

If the requested project is blocked:

- derive fallback name with two-digit suffix,
- create fallback project,
- copy original deployment config,
- redeploy to fallback project,
- update final deployment metadata with fallback project name and fallback Pages URL.

### Step 2: Verify the primary Pages project

Use the final deployment metadata, not the original config values, to verify:

- Pages root URL,
- secret URL,
- verify subscription URL.

### Step 3: Synchronize the share project

Use the final primary Pages URL as the new `SUB` value.

Target:

- preview env vars
- production env vars

If the configured share project is healthy:

- patch its deployment configs in place.

If the share project is blocked:

- create fallback share project with two-digit suffix,
- clone its original deployment config,
- patch the cloned deployment configs so `SUB` points to the final primary Pages URL,
- continue with the replacement share project as the final share target.

### Step 4: Verify cleanup preconditions

Cleanup of blocked source projects can only happen if:

- the final primary deploy succeeded,
- the final share-project sync succeeded when enabled,
- verification passed.

### Step 5: Cleanup

Delete blocked source projects only after all required success conditions hold.

If cleanup fails:

- do not fail the successful deployment,
- record cleanup error metadata.

## API and Cloudflare Interaction

Primary Pages project fallback and share-project sync rely on:

- `GET /accounts/{account_id}/pages/projects`
- `GET /accounts/{account_id}/pages/projects/{project_name}`
- `POST /accounts/{account_id}/pages/projects`
- `PATCH /accounts/{account_id}/pages/projects/{project_name}`
- optionally `DELETE /accounts/{account_id}/pages/projects/{project_name}`

For share-project sync, the `PATCH` payload must preserve the rest of each deployment config while only changing:

- `deployment_configs.preview.env_vars.SUB`
- `deployment_configs.production.env_vars.SUB`

Secret handling must preserve existing behavior:

- plain-text env vars can be copied directly,
- secret env vars still require runtime resolution using the existing secret-copy helper approach from the fallback worktree.

## Naming Rules

Fallback names must use a two-digit suffix.

Examples:

- `sub-nodes` -> `sub-nodes-01`
- `sub-nodes-01`, `sub-nodes-02` already exist -> `sub-nodes-03`
- `sub-links-share-03` blocked -> `sub-links-share-04`

This logic must not emit:

- `sub-nodes-1`
- `sub-links-share-4`

## Error Handling

### Blocked primary project

If the primary project is blocked and fallback creation or fallback deploy fails:

- return a failed deployment result,
- keep the original blocked project untouched,
- surface the fallback failure reason explicitly.

### Blocked share project

If the share project is blocked and fallback creation or share-project sync fails:

- mark the overall run failed,
- preserve deployment metadata for the primary project,
- record the exact share-project sync failure.

### Missing share project

If `share_project_name` is configured but Cloudflare cannot find it:

- treat that as a sync failure unless the design explicitly chooses “auto-create on missing”.

Recommendation:

- do not auto-create on missing in this iteration,
- only auto-create on blocked,
- because “missing” and “blocked” are different operational problems and should not be conflated.

### Cleanup failures

Cleanup failure should not downgrade a fully verified successful deploy into a hard failed run.

Instead:

- keep run status successful,
- record cleanup failure metadata.

## Testing Strategy

### Config tests

Add round-trip coverage for:

- `share_project_name`
- `share_project_auto_fallback`
- `share_project_fallback_prefix`
- `share_project_sub_env_key`

### Cloudflare integration tests

Cover:

- blocked primary project creates `sub-nodes-01`
- blocked share project creates `sub-links-share-04`
- `SUB` is rewritten to the final Pages root URL in both preview and production configs
- two-digit suffix generation remains stable
- cleanup metadata is emitted correctly

### Controller / backend resume tests

Cover:

- deploy result from fallback primary project flows into verify
- share-project sync metadata is persisted into `pipeline_report.json`
- blocked source project cleanup happens only after verify success

### End-to-end behavior tests

At minimum:

- fake primary blocked -> fallback success -> share sync success
- fake primary blocked -> fallback success -> share blocked -> share fallback success

## Migration Plan

1. Port the fallback Cloudflare helper code from the `pages-fallback-auto-create` worktree into main.
2. Re-enable the existing blocked primary Pages fallback behavior in main.
3. Add explicit share-project config fields and TOML persistence.
4. Add a dedicated share-project sync helper that rewrites `SUB` to the final Pages URL.
5. Add share-project blocked fallback on top of that helper.
6. Extend verification and cleanup metadata.
7. Run focused tests, then full regression.

## Recommendation

Recommended implementation order:

1. import the existing fallback project logic from `pages-fallback-auto-create`,
2. keep that logic low-level and focused on one Pages project at a time,
3. add a separate share-project sync step above it,
4. rewrite only `SUB` to the final Pages root URL,
5. keep blocked-project cleanup delayed until verification passes.

This reuses proven work, matches the requested naming format, and keeps the node-project and share-project responsibilities separate enough to test and maintain.
