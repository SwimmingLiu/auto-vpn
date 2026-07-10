# AutoVPN npm CLI Wrapper SOP

> Historical migration record. This is not an active installation, runtime, CI,
> or release procedure. Use `node-first-migration-sop.md` for current work.

## Purpose

This SOP defines the implementation route for adding a Node.js npm wrapper to AutoVPN while keeping the Python `autovpn` CLI as the single source of business logic.

The target user experience is:

```bash
npx -y @swimmingliu/autovpn doctor --project-root /opt/autovpn/vpn-subscription-automation --output json
npm install -g @swimmingliu/autovpn
autovpn run --project-root /opt/autovpn/vpn-subscription-automation --skip-deploy --skip-verify --output jsonl
```

The npm package is a distribution and launcher layer. It must not reimplement profile handling, pipeline execution, job management, artifact parsing, deployment, or verification logic.

## Source Analyses

This SOP is based on these implementation and verification analyses:

- [npm wrapper architecture](./wrapper-architecture-plan.md)
- [Python CLI contract](./python-cli-contract-plan.md)
- [Release and CI](./release-ci-plan.md)
- [README, Agent, and user experience](./docs-agent-plan.md)
- [Testing and acceptance](./npm-wrapper-test-sop.md)

## Non-Negotiable Principles

- Keep `src/vpn_automation/cli.py` as the authoritative CLI implementation.
- Add `npm/autovpn-cli` as an independent npm package; do not mix npm CLI publishing metadata into the Electron root `package.json`.
- The npm wrapper must transparently forward argv, stdin, stdout, stderr, and exit code.
- The wrapper may understand wrapper-only environment variables, but it must not parse AutoVPN business commands.
- JSON and JSONL output must remain clean for Agents.
- The wrapper must not require `sudo`, must not write to the project directory by default, and must not mutate system Python packages.
- Versions must stay locked across `pyproject.toml`, root `package.json`, and `npm/autovpn-cli/package.json`.

## Phase 0: Repository Preparation

Goal: create a safe baseline for implementation and prevent accidental work in the dirty desktop/Electron branch.

Tasks:

1. Start from `origin/main` in an isolated worktree.
2. Confirm `pyproject.toml`, root `package.json`, and release workflow represent the current release state.
3. Confirm current Python wheel/sdist release flow still exists.
4. Create or update documentation under `docs/npm-cli/`.

Acceptance:

- Work happens outside the dirty user checkout.
- `git status --short` only shows intentional SOP/document changes.
- The implementation plan references existing paths and commands in the repo.

## Phase 1: Stabilize Python CLI Contract

Reference: [Python CLI contract](./python-cli-contract-plan.md)

Goal: make the Python CLI reliable enough for an external npm launcher to treat it as a stable public interface.

Implementation tasks:

1. Add Python contract tests under `tests/backend/test_cli_contract.py`.
2. Add top-level `autovpn --version`, sourced from `importlib.metadata.version("vpn-subscription-automation")`.
3. Add `autovpn doctor --json` as an alias for `autovpn doctor --output json`.
4. Document exit codes:
   - `0`: success
   - `1`: runtime or business failure
   - `2`: argparse usage error
5. Verify machine-readable commands write JSON/JSONL only to stdout.
6. Verify error diagnostics remain on stderr.
7. Confirm `--project-root` should be absolute in all Agent and wrapper examples.

Required tests:

```bash
rtk proxy ./scripts/run_pytest.sh tests/backend/test_cli_contract.py -v
rtk proxy ./scripts/run_pytest.sh tests/backend/test_headless_cli.py tests/backend/test_doctor_cli.py tests/backend/test_jobs_cli.py -v
```

Exit criteria:

- `autovpn --help` and `autovpn --version` work from an installed wheel.
- `doctor --json` and `doctor --output json` are equivalent.
- JSON/JSONL contract tests pass without Electron.

## Phase 2: Build the npm Wrapper MVP

Reference: [npm wrapper architecture](./wrapper-architecture-plan.md)

Goal: add `@swimmingliu/autovpn` as an npm package that launches the Python CLI.

Implementation tasks:

1. Create `npm/autovpn-cli/package.json`.
2. Create `npm/autovpn-cli/bin/autovpn.mjs` as the thin bin entry.
3. Create launcher modules:
   - `npm/autovpn-cli/lib/runner.mjs`
   - `npm/autovpn-cli/lib/python.mjs`
   - `npm/autovpn-cli/lib/cache.mjs`
   - `npm/autovpn-cli/lib/install-python-cli.mjs`
   - `npm/autovpn-cli/lib/errors.mjs`
4. Implement command resolution in this order:
   - `AUTOVPN_PYTHON_CLI`
   - real existing `autovpn` on PATH, excluding the npm wrapper itself, only when `autovpn --version` matches the npm package version
   - wrapper-managed venv under the user cache directory
5. Add environment overrides:
   - `AUTOVPN_CACHE_DIR`
   - `AUTOVPN_WHEEL_URL`
   - `AUTOVPN_PYTHON_PACKAGE`
   - `AUTOVPN_PIP_INDEX_URL`
   - `AUTOVPN_PIP_EXTRA_INDEX_URL`
   - `AUTOVPN_NO_INSTALL`
   - `AUTOVPN_FORCE_INSTALL`
6. Ensure `spawn(..., { stdio: "inherit", shell: false })` is used for the Python CLI.
7. Return the Python CLI process exit code unchanged.
8. Add an explicit opt-in such as `AUTOVPN_ALLOW_VERSION_MISMATCH=1` before allowing a PATH `autovpn` with a different version.

Required tests:

```bash
rtk proxy npm ci --prefix npm/autovpn-cli
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy npm pack --dry-run --prefix npm/autovpn-cli
```

Exit criteria:

- `node npm/autovpn-cli/bin/autovpn.mjs --help` proxies to Python help.
- `doctor --output json` stdout is valid JSON.
- A Python exit code of `1` or `2` is preserved by the npm wrapper.
- Paths with spaces are passed without argument splitting.
- `profile save` works through stdin when invoked through the npm wrapper.
- Python stderr is passed through without being rewritten by the wrapper.
- Recursive `autovpn` detection is tested so the npm bin does not call itself.

## Phase 3: Add Optional pipx and uv Backends

Reference: [npm wrapper architecture](./wrapper-architecture-plan.md)

Goal: improve install and execution behavior for long-lived servers, Agent sandboxes, and CI. This phase can ship after the first npm wrapper MVP if Phase 2 already provides a reliable managed-venv backend.

Implementation tasks:

1. Add `npm/autovpn-cli/lib/pipx.mjs`.
2. Add `npm/autovpn-cli/lib/uv.mjs`.
3. Add `AUTOVPN_PYTHON_BACKEND` with accepted values:
   - `auto`
   - `pipx`
   - `uvx`
   - `venv`
4. Prefer `pipx` when it is available and a persistent CLI install is desired.
5. Prefer `uvx` only when explicitly selected or when a later policy decides it is safe as a default.
6. Keep wrapper-managed venv as the fallback when Python exists but pipx/uv do not.

Required tests:

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy npm run smoke --prefix npm/autovpn-cli
```

Exit criteria:

- `AUTOVPN_PYTHON_BACKEND=venv` works on Linux/macOS/Windows.
- `AUTOVPN_NO_INSTALL=1` fails with a clear diagnostic when no backend exists.
- Enterprise mirror and local wheel variables are covered by unit tests.

## Phase 4: CI and Release Integration

Reference: [Release and CI](./release-ci-plan.md)

Goal: make npm wrapper packaging and publishing repeatable.

Implementation tasks:

1. Add PR CI jobs for npm wrapper unit tests and pack dry-run.
2. Add wheel install smoke tests so npm wrapper integration failures are caught early.
3. Add cross-platform smoke tests for Linux, macOS, and Windows.
4. Add `scripts/check-version-sync.mjs` or equivalent.
5. Extend `.github/workflows/release-electron.yml` with `package-npm-wrapper`.
6. Upload npm `.tgz` to GitHub Release.
7. Decide and document the repository license before any public npm registry publication.
8. Publish `@swimmingliu/autovpn` to npm registry only from release/tag workflows after the license decision is complete.
9. Use npm provenance with `id-token: write`.
10. Make `npm publish` idempotent by checking whether the version already exists before publishing.

Required tests:

```bash
rtk proxy python -m build
rtk proxy python -m twine check dist/*
rtk proxy npm ci --prefix npm/autovpn-cli
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy npm pack --prefix npm/autovpn-cli
rtk proxy node scripts/check-version-sync.mjs
```

Exit criteria:

- CI blocks mismatched Python, Electron, and npm wrapper versions.
- Release assets include Electron installers, Python wheel/sdist, and npm `.tgz`.
- Release notes include npm/npx installation instructions.
- Release workflow verifies npm tarball contents and does not fail on rerun after a successful publish.
- Public npm publishing is blocked until the license is no longer ambiguous.

## Phase 5: Documentation and Agent Skill Update

Reference: [README, Agent, and user experience](./docs-agent-plan.md)

Goal: make the three installation paths clear and make Agent usage deterministic.

Implementation tasks:

1. Update `README.md` with a "Choose an Installation Path" section.
2. Explain that Electron installers do not install terminal `autovpn`.
3. Document three paths:
   - Electron desktop installers for GUI users
   - Python wheel/pipx for stable server installs
   - npm/npx wrapper for Agents and temporary environments
4. Update `.codex/skills/autovpn-agent/SKILL.md` with CLI entry priority:
   - `npx -y @swimmingliu/autovpn ...`
   - installed `autovpn`
   - project venv `autovpn`
   - `PYTHONPATH=src python -m vpn_automation.cli ...` as last-resort fallback
5. Update `docs/headless-agent/linux-headless-guide.md` with npx quick start.
6. Add troubleshooting coverage for Python, Node, wheel download, PATH, permissions, Mihomo, Playwright, and Wrangler.

Required checks:

```bash
rtk proxy rg -n "npx -y @swimmingliu/autovpn|pipx install|Choose an Installation Path" README.md docs .codex/skills
rtk proxy rg -n "Electron installers.*do not install|terminal autovpn" README.md docs .codex/skills
```

Exit criteria:

- A Linux headless user can pick one install path without reading Electron packaging details.
- An Agent has a default command that works in a fresh Node-enabled environment.
- Documentation states that npm wrapper still calls the Python CLI.

## Phase 6: Acceptance and Release Readiness

Reference: [Testing and acceptance](./npm-wrapper-test-sop.md)

Goal: verify end-to-end behavior before merge and release.

Required local checks:

```bash
rtk proxy ./scripts/run_pytest.sh tests -v
rtk proxy npm run test:electron
rtk proxy npm ci --prefix npm/autovpn-cli
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy npm pack --prefix npm/autovpn-cli
rtk proxy python -m build
rtk proxy python -m twine check dist/*
```

Required smoke checks:

```bash
rtk proxy npm install -g ./npm/autovpn-cli/*.tgz
rtk proxy autovpn --help
rtk proxy autovpn --version
rtk proxy autovpn doctor --project-root "$PWD" --output json
rtk proxy autovpn profile summary --project-root "$PWD" --json
```

Required release checks:

```bash
rtk proxy gh workflow run release-electron.yml -f tag_name=v<version>
rtk proxy gh run watch <run-id>
rtk proxy gh release view v<version> --json assets,body,url
```

Exit criteria:

- GitHub Release contains the npm `.tgz`, Python wheel/sdist, and Electron artifacts.
- npm registry contains `@swimmingliu/autovpn@<version>`.
- `npx -y @swimmingliu/autovpn --version` matches the Python and Electron versions.
- stdin forwarding is verified with `profile save`.
- stderr forwarding is verified with a forced Python CLI error.
- stale PATH `autovpn` is rejected unless explicitly allowed.
- npm tarball contents are limited to the intended `bin/`, `lib/`, README, LICENSE, and package metadata files.
- No command leaks source keys, Cloudflare credentials, full subscription URLs, or `vmess://` links.

## PR and Merge SOP

1. Open a PR from the implementation branch.
2. Run full relevant local tests before requesting review.
3. Run local code review focused on:
   - no duplicated business logic in Node
   - stdout/stderr contract safety
   - version synchronization
   - cross-platform path handling
   - release workflow idempotency
4. Apply review feedback.
5. Rerun impacted tests after every code change.
6. Merge only after CI and local review pass.
7. For release work, package and verify the deliverables after merge.

## Rollback and Recovery

- If GitHub Release upload fails before npm publish, fix the workflow and rerun.
- If npm publish fails after GitHub assets upload, fix npm credentials/provenance and rerun only the npm publish step.
- If npm publish succeeds but GitHub Release assets fail, do not unpublish; repair the GitHub Release.
- If an npm version is published with broken contents, publish a patch version and deprecate the broken version:

```bash
npm deprecate @swimmingliu/autovpn@<bad-version> "Broken release, use <fixed-version>"
```

## Definition of Done

- `@swimmingliu/autovpn` exists as an npm wrapper package.
- `npx -y @swimmingliu/autovpn` can operate AutoVPN on Linux headless hosts.
- Python CLI remains the only AutoVPN business implementation.
- README, Linux headless guide, and Agent skill document the same command priority.
- CI verifies Python package, Electron package, npm wrapper, version sync, and release assets.
- Release notes show Electron, Python CLI, and npm wrapper download/install options.
