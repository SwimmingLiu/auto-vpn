# Release Governance and PR Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the repository automation with formal GitHub Release publication, environment-aware deploy controls, and fixes for actionable Copilot PR feedback.

**Architecture:** Keep the existing CI split, then harden the deploy workflow with validated inputs and safe archive handling, upgrade the release workflow to publish a GitHub Release asset, and address review comments with code-backed fixes instead of one-off docs patches. Where workflow logic becomes non-trivial, move it into small testable scripts.

**Tech Stack:** GitHub Actions, GitHub CLI, Python, pytest, electron-builder.

---

### Task 1: Add a tested helper for Xray version validation and safe archive extraction

**Files:**
- Create: `scripts/ci/install_xray.py`
- Create: `tests/backend/test_install_xray.py`
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write the failing test**

```python
def test_safe_extract_rejects_path_escape(tmp_path: Path) -> None:
    archive = tmp_path / "xray.zip"
    # build an archive with ../escape and assert install_xray.safe_extract raises ValueError
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/bin/python -m pytest tests/backend/test_install_xray.py -q`
Expected: FAIL because `scripts/ci/install_xray.py` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```python
def validate_version(tag: str) -> str:
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Invalid xray version")
    return tag
```

```python
def safe_extract_zip(archive_path: Path, extract_root: Path) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            target = (extract_root / member.filename).resolve()
            if extract_root.resolve() not in target.parents and target != extract_root.resolve():
                raise ValueError(f"Unsafe path in archive: {member.filename}")
        archive.extractall(extract_root)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/bin/python -m pytest tests/backend/test_install_xray.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/install_xray.py tests/backend/test_install_xray.py .github/workflows/deploy.yml
git commit -m "ci: harden xray install workflow"
```

### Task 2: Publish GitHub Releases from the packaging workflow

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `docs/github-automation.md`

- [ ] **Step 1: Write the failing test**

```bash
rg -n "gh release create|gh release upload" .github/workflows/release.yml
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rg -n "gh release create|gh release upload" .github/workflows/release.yml`
Expected: no matches.

- [ ] **Step 3: Write minimal implementation**

```yaml
permissions:
  contents: write
```

```yaml
- name: Zip macOS app
  run: ditto -c -k --keepParent "dist-electron/mac-arm64/VPN Subscription Automation.app" "dist-electron/VPN Subscription Automation-mac-arm64.zip"
```

```yaml
- name: Publish GitHub release
  env:
    GH_TOKEN: ${{ github.token }}
  run: gh release create "$TAG" "dist-electron/VPN Subscription Automation-mac-arm64.zip" --title "$TAG" --notes "Automated release package."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rg -n "gh release create|gh release upload" .github/workflows/release.yml`
Expected: matches found.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml docs/github-automation.md
git commit -m "ci: publish release artifacts to github releases"
```

### Task 3: Make deploy workflow environment-aware and document production setup

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `docs/github-automation.md`

- [ ] **Step 1: Write the failing test**

```bash
rg -n "^\\s*environment:" .github/workflows/deploy.yml
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rg -n "^\\s*environment:" .github/workflows/deploy.yml`
Expected: no matches.

- [ ] **Step 3: Write minimal implementation**

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        description: Target GitHub environment
        required: true
        default: production
```

```yaml
jobs:
  deploy:
    environment: ${{ inputs.environment }}
    concurrency:
      group: deploy-${{ inputs.environment }}
      cancel-in-progress: false
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rg -n "^\\s*environment:|group: deploy-" .github/workflows/deploy.yml`
Expected: matches found.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml docs/github-automation.md
git commit -m "ci: add deploy environment governance"
```

### Task 4: Address actionable Copilot review comments in docs and CI assets

**Files:**
- Modify: `README.md`
- Modify: `docs/github-automation.md`
- Modify: `ci/templates/edgetunnel/vmess_node.js`

- [ ] **Step 1: Write the failing test**

```bash
python - <<'PY'
from pathlib import Path
text = Path('README.md').read_text(encoding='utf-8')
assert '/Users/' not in text
PY
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python - <<'PY' ... PY`
Expected: FAIL if README still contains machine-local paths or docs mismatch.

- [ ] **Step 3: Write minimal implementation**

```md
See [`docs/github-automation.md`](docs/github-automation.md) for the maintainer setup and deploy secret format.
```

And replace the CI worker template with a functional template copied from the maintained `cloudflarevpn/edgetunnel/vmess_node.js` reference so the documented example deploy path is real.

- [ ] **Step 4: Run test to verify it passes**

Run: `python - <<'PY' ... PY && rg -n "serect_key|must match" docs/github-automation.md ci/templates/edgetunnel/vmess_node.js`
Expected: PASS with repo-relative docs and explicit query-parameter note.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/github-automation.md ci/templates/edgetunnel/vmess_node.js
git commit -m "docs: address copilot review feedback"
```
