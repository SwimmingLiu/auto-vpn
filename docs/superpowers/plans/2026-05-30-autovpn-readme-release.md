# AutoVPN README and Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the desktop app as AutoVPN, refresh README content in the Skill Zoo style, and add release-triggered GitHub Actions packaging for the macOS Electron app.

**Architecture:** Keep the existing Electron/Python packaging script as the source of truth. The release workflow will run on macOS after a GitHub Release is published, execute tests and `npm run package:electron`, verify the generated app icon is project-derived, and upload generated artifacts back to that release.

**Tech Stack:** Electron, electron-builder, Python 3.12, Node.js 24, GitHub Actions, node:test, pytest.

---

### Task 1: Add Failing Coverage for Rebrand, README, and Workflow

**Files:**
- Modify: `electron/tests/package-build.test.mjs`
- Create: `electron/tests/release-docs-workflow.test.mjs`

- [ ] Add node:test assertions that `package.json` uses `AutoVPN` as `build.productName` and that the DMG artifact name follows `${productName}-${version}-${arch}.${ext}`.
- [ ] Add node:test assertions that `README.md` contains the Skill Zoo style sections: badges, screenshot, features, tech stack, installation, project structure, development, release packaging, trust/security, and license.
- [ ] Add node:test assertions that `.github/workflows/release-electron.yml` triggers on `release.published`, grants `contents: write`, runs on `macos-latest`, calls `npm run package:electron`, checks for default Electron icon warnings, verifies the packaged app icon resource, and uploads `dist-electron` artifacts with `softprops/action-gh-release`.
- [ ] Run `node --test electron/tests/package-build.test.mjs electron/tests/release-docs-workflow.test.mjs` and confirm the new tests fail before implementation.

### Task 2: Implement README and Package Metadata

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Rewrite `README.md` around `AutoVPN` using the Skill Zoo structure while preserving project-specific setup, runtime, deployment, testing, and packaging details.
- [ ] Change Electron package metadata from `VPN Subscription Automation` to `AutoVPN` where it affects visible packaged app naming.
- [ ] Run the focused node tests and confirm they pass for metadata and README coverage.

### Task 3: Add Release Packaging Workflow

**Files:**
- Create: `.github/workflows/release-electron.yml`

- [ ] Add a release-triggered macOS workflow.
- [ ] Install Node.js 24 and Python 3.12.
- [ ] Run `npm ci`, `python -m pip install -e .[dev]`, `npm run test:all`, and `npm run package:electron`.
- [ ] Capture packaging logs and fail if `default Electron icon is used` appears.
- [ ] Verify `electron/build/assets/app-icon.icns` and the packaged `AutoVPN.app/Contents/Resources/*.icns` exist.
- [ ] Upload `.dmg`, `.zip`, `.blockmap`, and `.yml` files from `dist-electron` to the current GitHub Release.

### Task 4: Verify, Review, PR, and Packaging

**Files:**
- All changed files

- [ ] Run `npm run test:all`.
- [ ] Run `npm run package:electron`.
- [ ] Inspect package logs and packaged app resources for project-derived icon evidence.
- [ ] Perform a local code review against this plan and current diff.
- [ ] Open a GitHub PR for the branch if network/auth allow it.
- [ ] After merge, package the app again if required by repository workflow.
