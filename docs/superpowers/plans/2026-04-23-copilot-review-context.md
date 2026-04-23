# Copilot Review Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repository instructions, path-specific review guidance, PR templates, and automated PR-body validation so Copilot review has project context instead of reviewing blindly.

**Architecture:** Keep static context in `.github/copilot-instructions.md`, scoped guidance in `.github/instructions/*.instructions.md`, and dynamic feature context in `PULL_REQUEST_TEMPLATE.md` enforced by a dedicated workflow. This separates permanent repository knowledge from per-change review intent.

**Tech Stack:** GitHub Copilot instructions, GitHub Actions, PR templates, Python validation script embedded in workflow steps.

---

### Task 1: Add repository-wide Copilot instructions

**Files:**
- Create: `.github/copilot-instructions.md`

- [ ] **Step 1: Write the failing test**

```bash
test ! -f .github/copilot-instructions.md
```

- [ ] **Step 2: Run test to verify it fails**

Run: `test ! -f .github/copilot-instructions.md`
Expected: PASS before implementation.

- [ ] **Step 3: Write minimal implementation**

```md
# Repository context

This repository builds a Python + Electron desktop workflow for VPN subscription automation.
Review for pipeline correctness, UI regressions, secret handling, deployment safety, flaky tests, and missing edge cases.
Treat the PR body sections as the current change intent and verify the implementation matches them.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `test -f .github/copilot-instructions.md`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/copilot-instructions.md
git commit -m "docs: add copilot repository instructions"
```

### Task 2: Add path-specific review instructions

**Files:**
- Create: `.github/instructions/python-review.instructions.md`
- Create: `.github/instructions/electron-review.instructions.md`
- Create: `.github/instructions/workflows-review.instructions.md`

- [ ] **Step 1: Write the failing test**

```bash
test ! -d .github/instructions
```

- [ ] **Step 2: Run test to verify it fails**

Run: `test ! -d .github/instructions`
Expected: PASS before implementation.

- [ ] **Step 3: Write minimal implementation**

```md
---
applyTo: "src/vpn_automation/**/*.py tests/**/*.py pyproject.toml"
---

Focus on subprocess safety, timeout handling, runtime profile loading, network failure handling, and deployment verification.
```

```md
---
applyTo: "electron/**/* package.json"
---

Focus on preload boundaries, IPC exposure, renderer state, locale consistency, visual regression risk, and run/stop control correctness.
```

```md
---
applyTo: ".github/workflows/**/*.yml .github/**/*.md"
---

Focus on secret usage, permissions minimization, artifact integrity, unsafe shell patterns, cache poisoning, and missing verification gates.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `test -f .github/instructions/python-review.instructions.md && test -f .github/instructions/electron-review.instructions.md && test -f .github/instructions/workflows-review.instructions.md`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/instructions/*.instructions.md
git commit -m "docs: add scoped copilot review instructions"
```

### Task 3: Add PR template and validator workflow

**Files:**
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/workflows/pr-context.yml`

- [ ] **Step 1: Write the failing test**

```bash
test ! -f .github/PULL_REQUEST_TEMPLATE.md
```

- [ ] **Step 2: Run test to verify it fails**

Run: `test ! -f .github/PULL_REQUEST_TEMPLATE.md`
Expected: PASS before implementation.

- [ ] **Step 3: Write minimal implementation**

```md
## Goal

## Feature / requirement mapping

## What changed

## Security / risk review

## Edge cases checked

## Verification evidence
```

```yaml
name: PR Context
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - run: python - <<'PY'
          # fail if any required section is missing or empty
        PY
```

- [ ] **Step 4: Run test to verify it passes**

Run: `test -f .github/PULL_REQUEST_TEMPLATE.md && test -f .github/workflows/pr-context.yml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/PULL_REQUEST_TEMPLATE.md .github/workflows/pr-context.yml
git commit -m "ci: enforce pull request review context"
```

