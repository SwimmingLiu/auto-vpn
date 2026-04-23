# GitHub Actions Automation Design

**Goal:** 把当前依赖本地执行的测试、校验、打包与发布流程，迁移成可在 GitHub Actions 中复现的自动化流程。

**Architecture:** 采用三层自动化。第一层是 PR / push 级别的 CI，负责 Python、Electron、e2e、visual、依赖审查与基础安全扫描。第二层是手动或标签触发的发布工作流，负责构建 Electron 安装包并上传制品。第三层是可选的部署工作流，通过仓库 secret 注入运行时 profile 和 Cloudflare 凭据，执行后端部署流水线。

**Tech Stack:** GitHub Actions, `actions/checkout`, `actions/setup-python`, `actions/setup-node`, Playwright, pytest, npm, dependency-review-action, CodeQL.

---

## Scope

This phase covers:

- CI for Python unit tests
- CI for Electron / renderer tests
- visual regression checks
- dependency review on pull requests
- CodeQL default setup or equivalent advanced setup for supported languages
- manual or release-triggered Electron packaging
- optional deploy workflow that can run with repository secrets

This phase does **not** try to solve repository-wide Copilot review context. That is a separate phase.

## Recommended Approach

1. **PR CI + security gates**
   - Fast feedback on every pull request.
   - Fails early on unit, e2e, visual, or dependency issues.

2. **Manual / tagged release packaging**
   - Builds the Electron app on macOS runners.
   - Uploads artifacts for download or release attachment.

3. **Secret-driven deployment workflow**
   - Materializes the runtime profile from repository secrets.
   - Runs the backend pipeline in GitHub Actions instead of only locally.
   - Keeps deployment opt-in so PRs do not require live Cloudflare credentials.

## Workflow Boundaries

- `ci.yml`
  - triggers: `pull_request`, `push`
  - jobs: Python tests, Electron tests, visual tests, dependency review
- `release.yml`
  - triggers: `workflow_dispatch`, optional tag push
  - jobs: package Electron app, upload artifact
- `deploy.yml`
  - triggers: `workflow_dispatch`
  - jobs: run backend pipeline with injected secrets, upload runtime artifacts
- `codeql.yml` or default setup
  - enable language security scanning for supported code

## Data Flow

1. PR opens or updates.
2. GitHub Actions checks out the repo, installs Python and Node dependencies, installs Playwright browsers, and runs the test matrix.
3. Dependency review inspects manifest and lockfile deltas.
4. CodeQL scans supported language surfaces.
5. Release workflow packages the Electron app when requested.
6. Deploy workflow writes the runtime profile to `state/profiles/default.json`, then runs the backend pipeline with secrets.

## Risk Notes

- Electron tests may require a Linux display shim on CI.
- The deploy pipeline currently depends on runtime profile data and Cloudflare secrets, so the workflow must fail clearly when those are missing.
- Packaging runs on macOS runners and should remain separate from PR CI to control cost.

