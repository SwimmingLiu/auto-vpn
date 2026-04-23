# GitHub automation and review setup

This repository now ships repository-level automation for CI, release packaging, dependency review, CodeQL, and PR context enforcement.

## Workflows

- `CI`: runs Python tests and Electron tests
- `Dependency Review`: blocks high-severity dependency changes on pull requests
- `CodeQL`: runs GitHub code scanning for JavaScript / Python
- `Release Package`: builds the macOS Electron package and uploads the artifact
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

## Secrets for `Deploy Pipeline`

The deploy workflow expects these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `VPN_AUTOMATION_PROFILE_JSON`

`VPN_AUTOMATION_PROFILE_JSON` should be a full `AppProfile` JSON payload. Use `__GITHUB_WORKSPACE__` as a placeholder for the checked-out repository root. The workflow rewrites it to the actual runner path before execution. The `deploy.secret_query` value must match what the deployed Worker expects; the historical default in this codebase uses `serect_key=...`, so do not assume the parameter name is always `secret_key`.

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
    "secret_query": "secret_key=replace-me",
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
