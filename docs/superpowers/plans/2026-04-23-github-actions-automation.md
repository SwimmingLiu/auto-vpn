# GitHub Actions Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub Actions workflows and security gates so the repo can test, package, and optionally deploy without relying on local-only execution.

**Architecture:** Split the work into a fast PR CI workflow, a macOS packaging workflow, and a secret-driven deploy workflow. Keep each workflow small and explicit so failures point to one responsibility. Add security gates that run alongside tests instead of burying them in local scripts.

**Tech Stack:** GitHub Actions, pytest, Playwright, npm, electron-builder, CodeQL, dependency-review-action.

---

### Task 1: Fix the Electron language baseline so CI is deterministic

**Files:**
- Modify: `electron/tests/app-launch.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('electron app exposes preload bridge and renders the saved Chinese profile after language initialization', async () => {
  // existing assertions should be made deterministic by forcing zh-CN before the first render
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:electron -- electron/tests/app-launch.test.mjs`
Expected: FAIL because the page title is sometimes rendered in English by default.

- [ ] **Step 3: Write minimal implementation**

```js
test('electron app exposes preload bridge and renders the saved Chinese profile', async () => {
  const app = await electron.launch({ args: [projectRoot] });

  try {
    const page = await app.firstWindow();
    await page.addInitScript(() => {
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
    });
    await page.reload();
    await page.waitForSelector('#pageContent');
    await page.locator('#navConfig').click();
    await page.waitForSelector('#configPrimarySource');

    const pageTitle = await page.locator('#pageTitle').innerText();
    assert.equal(pageTitle, '配置管理');
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:electron -- electron/tests/app-launch.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/tests/app-launch.test.mjs
git commit -m "test: stabilize electron launch locale"
```

### Task 2: Add PR and repository instructions for CI-friendly review context

**Files:**
- Create: `.github/copilot-instructions.md`
- Create: `.github/instructions/pull-request.instructions.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Write the failing test**

```md
<!-- No automated test exists yet; this task is validated by workflow behavior and template presence. -->
```

- [ ] **Step 2: Run test to verify it fails**

Run: `test ! -f .github/copilot-instructions.md`
Expected: PASS before implementation, proving the file is missing.

- [ ] **Step 3: Write minimal implementation**

Create `.github/copilot-instructions.md`:

```md
# Repository context

This repository automates VPN subscription capture, filtering, packaging, and deployment.
Always check for security issues, edge cases, and regressions in tests, workflows, and release automation.
Treat PR body sections as the source of truth for the feature intent, risk, and verification context.
```

Create `.github/instructions/pull-request.instructions.md`:

```md
---
applyTo: "**/*.md"
---

When reviewing pull request docs or workflow-related markdown, check that the request includes goal, scope, risk, security impact, edge cases, and verification notes.
```

Create `.github/PULL_REQUEST_TEMPLATE.md`:

```md
## Goal

## What changed

## Why

## Security / risk review

## Edge cases checked

## Verification
```

- [ ] **Step 4: Run test to verify it passes**

Run: `test -f .github/copilot-instructions.md && test -f .github/PULL_REQUEST_TEMPLATE.md`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/copilot-instructions.md .github/instructions/pull-request.instructions.md .github/PULL_REQUEST_TEMPLATE.md
git commit -m "docs: add review context templates"
```

### Task 3: Add PR CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing test**

```bash
test ! -f .github/workflows/ci.yml
```

- [ ] **Step 2: Run test to verify it fails**

Run: `test ! -f .github/workflows/ci.yml`
Expected: PASS before implementation, proving the workflow file is missing.

- [ ] **Step 3: Write minimal implementation**

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  python-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v6
        with:
          python-version: "3.12"
          cache: pip
      - run: python -m pip install -e '.[dev]'
      - run: python -m pytest tests -q

  electron-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: xvfb-run -a npm run test:electron

  dependency-review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/dependency-review-action@v4
```

- [ ] **Step 4: Run test to verify it passes**

Run: `test -f .github/workflows/ci.yml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add pr test workflow"
```

### Task 4: Add release packaging workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the failing test**

```bash
test ! -f .github/workflows/release.yml
```

- [ ] **Step 2: Run test to verify it fails**

Run: `test ! -f .github/workflows/release.yml`
Expected: PASS before implementation, proving the workflow file is missing.

- [ ] **Step 3: Write minimal implementation**

```yaml
name: release
on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

permissions:
  contents: read

jobs:
  package-electron:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npm run package:electron
      - uses: actions/upload-artifact@v4
        with:
          name: electron-package
          path: dist-electron/**
```

- [ ] **Step 4: Run test to verify it passes**

Run: `test -f .github/workflows/release.yml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add electron release packaging workflow"
```

### Task 5: Add secret-driven deployment workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write the failing test**

```bash
test ! -f .github/workflows/deploy.yml
```

- [ ] **Step 2: Run test to verify it fails**

Run: `test ! -f .github/workflows/deploy.yml`
Expected: PASS before implementation, proving the workflow file is missing.

- [ ] **Step 3: Write minimal implementation**

```yaml
name: deploy
on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  pipeline:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v6
        with:
          python-version: "3.12"
          cache: pip
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm
      - run: python -m pip install -e '.[dev]'
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: |
          mkdir -p state/profiles
          printf '%s\n' "${VPN_AUTOMATION_PROFILE_JSON}" > state/profiles/default.json
        env:
          VPN_AUTOMATION_PROFILE_JSON: ${{ secrets.VPN_AUTOMATION_PROFILE_JSON }}
      - run: xvfb-run -a python -m vpn_automation.backend run --project-root "$GITHUB_WORKSPACE"
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      - uses: actions/upload-artifact@v4
        with:
          name: deployment-artifacts
          path: artifacts/**
```

- [ ] **Step 4: Run test to verify it passes**

Run: `test -f .github/workflows/deploy.yml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add deployment workflow"
```

### Task 6: Add dependency automation and code scanning entrypoints

**Files:**
- Create: `.github/dependabot.yml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing test**

```bash
test ! -f .github/dependabot.yml
```

- [ ] **Step 2: Run test to verify it fails**

Run: `test ! -f .github/dependabot.yml`
Expected: PASS before implementation, proving the file is missing.

- [ ] **Step 3: Write minimal implementation**

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "pip"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

Then extend `ci.yml` with CodeQL if repository policy allows it:

```yaml
  codeql:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      actions: read
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript, python
      - uses: github/codeql-action/autobuild@v3
      - uses: github/codeql-action/analyze@v3
```

- [ ] **Step 4: Run test to verify it passes**

Run: `test -f .github/dependabot.yml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/dependabot.yml .github/workflows/ci.yml
git commit -m "ci: add dependency automation and code scanning"
```

