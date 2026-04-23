# GitHub automation and review setup

This repository now ships repository-level automation for CI, release packaging, dependency review, CodeQL, and PR context enforcement.

## Workflows

- `CI`: runs Python tests and Electron tests
- `Dependency Review`: blocks high-severity dependency changes on pull requests
- `CodeQL`: runs GitHub code scanning for JavaScript / Python
- `Release Package`: builds the macOS Electron package, uploads the artifact, and publishes a GitHub Release asset for tag builds
- `Deploy Pipeline`: manually runs the backend pipeline in GitHub Actions
- `PR Context`: rejects pull requests that omit required review context

## Repository review context

Copilot review context is now split into:

- `.github/copilot-instructions.md` for repository-wide behavior
- `.github/instructions/*.instructions.md` for path-specific review focus
- `.github/PULL_REQUEST_TEMPLATE.md` for per-PR dynamic context

This combination is intentional:

- static instructions explain what the project does
- path instructions explain what matters in each part of the tree
- the PR template captures what the current change is supposed to do

## One-time maintainer setup

1. Enable automatic GitHub Copilot code review for the repository in GitHub settings.
2. Keep the PR template sections intact so the `PR Context` workflow can enforce them.
3. Keep Dependabot enabled so Actions, npm, and pip dependencies continue to update automatically.
4. Enable repository variable `ENABLE_DEPENDENCY_REVIEW=true` after GitHub dependency review is available for this repository.
5. Enable repository variable `ENABLE_CODEQL=true` after GitHub code scanning / CodeQL is enabled for this repository.
6. Create a GitHub environment such as `production` for the deploy workflow and attach the production secrets there when you want approval-gated deployment.

The dependency-review and CodeQL workflows are intentionally gated by repository variables so pull requests do not fail before the corresponding GitHub security features are enabled in repository settings.
The deploy workflow is environment-aware and serializes deployment per target environment.

## Final GitHub setup checklist

Use this checklist when moving from repo-local validation to GitHub-hosted release and deployment.

### Repository variables

Add these repository variables in GitHub:

- `ENABLE_DEPENDENCY_REVIEW=true`
- `ENABLE_CODEQL=true`

Only enable them after the corresponding GitHub repository features are available in settings, otherwise those workflows will fail by platform policy instead of code quality.

### GitHub environments

Create a `production` environment for the deploy workflow.

Recommended environment settings:

- required reviewers: enable if you want manual approval before deployment
- deployment branch restrictions: allow only `main`
- environment secrets: keep deploy-only secrets here instead of plain repository secrets

### Required secrets

Configure these secrets before running `Deploy Pipeline`:

- `CLOUDFLARE_API_TOKEN`
- `VPN_AUTOMATION_PROFILE_JSON`

Recommended placement:

- `CLOUDFLARE_API_TOKEN`: `production` environment secret
- `VPN_AUTOMATION_PROFILE_JSON`: `production` environment secret

### Minimal release flow

To publish a GitHub Release asset:

1. Merge the PR into `main`
2. Create and push a tag that matches `v*`, for example `v0.2.1`
3. The `Release Package` workflow will build the macOS package and publish the zip asset to the GitHub Release

### Minimal deploy flow

To run a production deploy:

1. Ensure the `production` environment exists
2. Ensure the two deploy secrets are configured
3. Open Actions → `Deploy Pipeline`
4. Select `environment=production`
5. Keep `xray_version` in `vMAJOR.MINOR.PATCH` format
6. Run the workflow

### Current repository readiness summary

At the time this document was updated:

- CI workflow logic is passing on the latest validated branch revision
- release workflow logic is implemented but still needs one real tag-based release rehearsal
- deploy workflow logic is implemented but still depends on GitHub-side environment and secret configuration

## Secrets for `Deploy Pipeline`

The deploy workflow expects these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `VPN_AUTOMATION_PROFILE_JSON`

`VPN_AUTOMATION_PROFILE_JSON` should be a full `AppProfile` JSON payload. Use `__GITHUB_WORKSPACE__` as a placeholder for the checked-out repository root. The workflow rewrites it to the actual runner path before execution. The `deploy.secret_query` value must match what the deployed Worker expects; the historical default in this codebase uses `serect_key=...`, so do not assume the parameter name is always `secret_key`.

### Recommended production profile template

Use this as the starting point for `VPN_AUTOMATION_PROFILE_JSON`, then replace the placeholders with your real values.

Rules:

- keep `project_root`, `workspace_root`, `artifacts_root`, `state_root`, and `build_root` on `__GITHUB_WORKSPACE__`
- point `vpn_catch_nodes_root` and `edgetunnel_root` at the in-repo CI templates unless you intentionally maintain different deploy templates
- set `deploy.secret_query` to the exact query parameter your deployed Worker expects
- disable any source that is not configured yet by setting `enabled: false`

### Example `VPN_AUTOMATION_PROFILE_JSON`

```json
{
  "sources": {
    "leiting": {
      "url": "https://example.com/api",
      "key": "replace-me",
      "enabled": true,
      "max_iterations": 40,
      "plateau_limit": 8,
      "use_random_area": true
    },
    "heidong": {
      "url": "",
      "key": "",
      "enabled": false,
      "max_iterations": 40,
      "plateau_limit": 8,
      "use_random_area": true
    },
    "mifeng": {
      "url": "",
      "key": "",
      "enabled": false,
      "max_iterations": 40,
      "plateau_limit": 8,
      "use_random_area": true
    },
    "xuanfeng1": {
      "url": "",
      "key": "",
      "enabled": false,
      "max_iterations": 40,
      "plateau_limit": 8,
      "use_random_area": false
    },
    "xuanfeng2": {
      "url": "",
      "key": "",
      "enabled": false,
      "max_iterations": 40,
      "plateau_limit": 8,
      "use_random_area": true
    }
  },
  "speed_test": {
    "min_download_mb_s": 1.0,
    "timeout_seconds": 20,
    "concurrency": 3,
    "urls": [
      "https://speed.cloudflare.com/__down?bytes=5000000",
      "https://proof.ovh.net/files/1Mb.dat",
      "https://cachefly.cachefly.net/1mb.test"
    ],
    "probe_url": "https://www.gstatic.com/generate_204",
    "max_download_bytes": 5000000,
    "startup_wait_seconds": 1.0
  },
  "deploy": {
    "project_name": "vmessnodes",
    "subscription_url": "https://example.com/subscription",
    "pages_project_url": "https://example.pages.dev",
    "secret_query": "serect_key=replace-me",
    "account_id": "replace-me",
    "use_wrangler": true
  },
  "workspace": {
    "project_root": "__GITHUB_WORKSPACE__",
    "workspace_root": "__GITHUB_WORKSPACE__",
    "vpn_catch_nodes_root": "__GITHUB_WORKSPACE__/ci/templates/vpn-catch-nodes",
    "edgetunnel_root": "__GITHUB_WORKSPACE__/ci/templates/edgetunnel",
    "artifacts_root": "__GITHUB_WORKSPACE__/artifacts",
    "state_root": "__GITHUB_WORKSPACE__/state",
    "env_file": "__GITHUB_WORKSPACE__/.env",
    "build_root": "__GITHUB_WORKSPACE__/build"
  },
  "filters": {
    "excluded_country_codes": [
      "CN"
    ],
    "per_country_limit": {
      "HK": 5,
      "TW": 5
    }
  }
}
```

## What still needs a live rehearsal

The repository code and workflows are in place, but these steps still require a real GitHub-side run to claim full production readiness:

1. tag-triggered `Release Package`
2. `Deploy Pipeline` against the final `production` environment

Until those two are run against your live GitHub configuration, treat release/deploy readiness as implemented-but-not-fully-rehearsed.
