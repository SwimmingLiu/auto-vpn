# AutoVPN npm CLI Wrapper Test SOP

> Historical migration record. This is not an active test or release procedure.
> Use `node-first-migration-sop.md` for the current gate.

## Purpose

This SOP defines the complete test and verification workflow for the AutoVPN npm/npx CLI wrapper work. It covers every task in [npm-wrapper-sop.md](./npm-wrapper-sop.md), including Python CLI contract stabilization, npm wrapper behavior, optional backend installers, documentation updates, CI/release changes, package artifacts, Agent usage, and security invariants.

Use this SOP as the required test checklist before merging implementation PRs and before publishing a release that includes `@swimmingliu/autovpn`.

## Coverage Map

| Work area | Primary files | Required evidence |
| --- | --- | --- |
| Python CLI contract | `src/vpn_automation/cli.py`, `tests/backend/test_cli_contract.py` | pytest contract tests, installed-wheel smoke |
| npm wrapper MVP | `npm/autovpn-cli/**` | `node:test`, local bin smoke, packed tarball smoke |
| backend install strategy | `npm/autovpn-cli/lib/{python,cache,install-python-cli,pipx,uv}.mjs` | unit tests for backend selection, cache, env overrides, version checks |
| Agent-safe command behavior | `.codex/skills/autovpn-agent/SKILL.md`, README, Linux guide | command examples execute or are mechanically verified |
| CI/release | `.github/workflows/headless-cli.yml`, `.github/workflows/release-electron.yml`, `scripts/check-version-sync.mjs`, `scripts/generate-release-notes.mjs` | workflow tests, dry-run package checks, release asset audit |
| package artifacts | `dist/*.whl`, `dist/*.tar.gz`, `npm/autovpn-cli/*.tgz`, Electron installers | local builds, metadata checks, tarball file allowlist, GitHub Release asset audit |
| security and redaction | CLI stdout/stderr, artifact preview, docs | redaction tests, no token-bearing values in reports |

## Global Test Rules

- Run commands with the project wrapper prefix:

```bash
rtk proxy <command>
```

- Use an isolated worktree for implementation and release tests.
- Do not rely on the dirty desktop branch for test evidence.
- Treat JSON/JSONL cleanliness as a hard contract: no wrapper banner, npm notice, traceback, or progress text may appear on stdout for machine-readable commands.
- Treat `stderr` as diagnostic-only. It may contain errors, but it must not contain secrets.
- Preserve Python CLI exit codes through the npm wrapper:
  - `0`: success
  - `1`: runtime or business failure
  - `2`: argparse usage error
- Any changed behavior must have a failing test first and a passing test after implementation.

## Phase 0: Baseline and Test Environment

Goal: prove the starting point is understood before implementation.

Required setup:

```bash
rtk proxy git status --short --branch
rtk proxy python3.12 --version
rtk proxy node --version
rtk proxy npm --version
```

Expected runtime:

```text
Python: 3.12.x
Node.js: 24.x for CI/release parity
npm: version bundled with the selected Node.js runtime
```

Required baseline tests:

```bash
rtk proxy ./scripts/run_pytest.sh tests/backend/test_headless_cli.py tests/backend/test_doctor_cli.py tests/backend/test_jobs_cli.py -v
rtk proxy node --test electron/tests/release-docs-workflow.test.mjs electron/tests/release-notes.test.mjs
```

Pass criteria:

- Worktree has no unrelated local changes.
- Python and Node versions satisfy the target runtime.
- Existing headless CLI and release docs tests pass before new behavior is added.

Failure handling:

- If baseline tests fail, record the failing command and investigate before implementing npm wrapper changes.
- Do not use later green tests to excuse an unexplained baseline failure.

## Phase 1: Python CLI Contract Tests

Goal: make the Python `autovpn` command a stable public API for the npm wrapper.

Required test file:

```text
tests/backend/test_cli_contract.py
```

Required automated cases:

| Case | Command or behavior | Expected result |
| --- | --- | --- |
| top-level help | `autovpn --help` | exit `0`, stdout contains `doctor`, `profile`, `run`, `jobs`, `artifacts` |
| top-level version | `autovpn --version` | exit `0`, stdout exactly matches `autovpn <pyproject version>` |
| argparse error | invalid subcommand or missing required arg | exit `2`, diagnostic on stderr |
| doctor JSON alias | `doctor --json` | same JSON shape as `doctor --output json` |
| JSON commands | profile/artifacts/status/jobs commands | stdout parses with `json.loads` |
| JSONL commands | run/retry/resume with `--output jsonl` | every non-empty line parses with `json.loads` |
| stderr contract | forced Python CLI failure | stderr starts with stable `autovpn:` diagnostic, stdout empty |
| absolute project root | `--project-root` with absolute path | JSON output reports or uses the expected root |
| secret redaction | profile summary, doctor, artifact preview | no source key, Cloudflare token, full subscription URL, or `vmess://` in stdout/stderr |

Required command:

```bash
rtk proxy ./scripts/run_pytest.sh tests/backend/test_cli_contract.py -v
```

Installed wheel smoke:

```bash
rtk proxy python -m build
rtk proxy python -m venv /tmp/autovpn-wheel-contract
rtk proxy /tmp/autovpn-wheel-contract/bin/python -m pip install dist/*.whl
rtk proxy /tmp/autovpn-wheel-contract/bin/autovpn --help
rtk proxy /tmp/autovpn-wheel-contract/bin/autovpn --version
rtk proxy /tmp/autovpn-wheel-contract/bin/autovpn doctor --project-root "$PWD" --output json
```

Pass criteria:

- The wheel-installed `autovpn` exposes the same contract as editable installs.
- `doctor --json` and `doctor --output json` are both valid and documented.

## Phase 2: npm Wrapper Unit Tests

Goal: prove the Node wrapper is a launcher only and preserves the Python CLI contract.

Required npm test files:

```text
npm/autovpn-cli/test/runner.test.mjs
npm/autovpn-cli/test/python.test.mjs
npm/autovpn-cli/test/cache.test.mjs
npm/autovpn-cli/test/install-python-cli.test.mjs
```

Required cases:

| Case | Expected result |
| --- | --- |
| `AUTOVPN_PYTHON_CLI` override | wrapper executes the exact path and forwards all args |
| real PATH `autovpn` with matching version | accepted and executed |
| stale PATH `autovpn` | ignored unless `AUTOVPN_ALLOW_VERSION_MISMATCH=1` |
| recursive npm bin detection | wrapper never executes itself as backend |
| missing Python | clear stderr diagnostic, non-zero exit |
| Python version `<3.12` | rejected with clear diagnostic |
| managed venv path | resolves under user cache or `AUTOVPN_CACHE_DIR` |
| install lock | concurrent installs cannot corrupt the same cache target |
| `AUTOVPN_NO_INSTALL=1` | no venv creation, clear failure if no backend exists |
| `AUTOVPN_WHEEL_URL=file://...` | pip install receives the local wheel URL |
| `AUTOVPN_PYTHON_PACKAGE` | custom Python package spec is used instead of the default version-derived package |
| `AUTOVPN_FORCE_INSTALL=1` | backend install is refreshed even when a cached backend exists |
| pip index overrides | `AUTOVPN_PIP_INDEX_URL` and `AUTOVPN_PIP_EXTRA_INDEX_URL` are passed to pip |
| path with spaces | argv remains one argument |
| stdin forwarding | `profile save` receives stdin unchanged |
| stdout forwarding | JSON/JSONL is not modified |
| stderr forwarding | Python stderr is not rewritten |
| exit code forwarding | Python exit `0`, `1`, and `2` are preserved |

Required commands:

```bash
rtk proxy npm ci --prefix npm/autovpn-cli
rtk proxy npm test --prefix npm/autovpn-cli
```

Pass criteria:

- Unit tests do not call the real network unless explicitly marked as smoke/integration.
- Tests use temporary directories for cache and fake backend binaries.
- The wrapper does not parse AutoVPN business commands.

## Phase 3: npm Wrapper Local Smoke Tests

Goal: verify the npm package works after packing, not just from source.

Build package:

```bash
rtk proxy npm pack --prefix npm/autovpn-cli
```

Install into an isolated prefix:

```bash
rtk proxy mkdir -p /tmp/autovpn-npm-smoke-prefix
rtk proxy npm install --prefix /tmp/autovpn-npm-smoke-prefix "$(pwd)/npm/autovpn-cli/"*.tgz
```

Run smoke checks:

```bash
rtk proxy /tmp/autovpn-npm-smoke-prefix/node_modules/.bin/autovpn --help
rtk proxy /tmp/autovpn-npm-smoke-prefix/node_modules/.bin/autovpn --version
rtk proxy /tmp/autovpn-npm-smoke-prefix/node_modules/.bin/autovpn doctor --project-root "$PWD" --output json
rtk proxy /tmp/autovpn-npm-smoke-prefix/node_modules/.bin/autovpn profile summary --project-root "$PWD" --json
```

Tarball allowlist:

```bash
rtk proxy tar -tf npm/autovpn-cli/*.tgz
```

Allowed contents:

```text
package/package.json
package/README.md
package/LICENSE
package/bin/**
package/lib/**
```

Pass criteria:

- Packed package installs without relying on repository-relative files outside the npm package.
- `doctor --output json` stdout parses as JSON.
- Tarball does not include tests, local caches, `.env`, artifacts, state, Electron build output, or Python source code unless explicitly required.

## Phase 4: Optional pipx and uv Backend Tests

Goal: verify optional backends without making them mandatory for the MVP.

Backend matrix:

| `AUTOVPN_PYTHON_BACKEND` | Required behavior |
| --- | --- |
| `auto` | uses matching PATH backend, then supported installers, then managed venv |
| `venv` | uses only wrapper-managed venv |
| `pipx` | uses pipx or fails clearly |
| `uvx` | uses uvx or fails clearly |

Required commands when backends are implemented:

```bash
rtk proxy env AUTOVPN_PYTHON_BACKEND=venv npm run smoke --prefix npm/autovpn-cli
rtk proxy env AUTOVPN_PYTHON_BACKEND=pipx npm run smoke --prefix npm/autovpn-cli
rtk proxy env AUTOVPN_PYTHON_BACKEND=uvx npm run smoke --prefix npm/autovpn-cli
```

Pass criteria:

- Missing optional tools produce actionable diagnostics.
- `venv` backend always works when Python `>=3.12` and wheel/package source are available.
- pipx/uv tests are skipped or marked optional only when the implementation phase explicitly defers them.

## Phase 5: Documentation and Agent Command Tests

Goal: keep README, Linux guide, and Agent skill consistent.

Required docs after the documentation phase is implemented:

```text
README.md
docs/headless-agent/linux-headless-guide.md
docs/headless-agent/troubleshooting.md
docs/headless-agent/npm-wrapper-acceptance-sop.md
.codex/skills/autovpn-agent/SKILL.md
```

If `docs/headless-agent/troubleshooting.md` or `docs/headless-agent/npm-wrapper-acceptance-sop.md` has not been introduced yet, the documentation PR must either add it or explicitly document where those troubleshooting and acceptance checks live.

Required checks:

```bash
rtk proxy rg -n "Choose an Installation Path|npx -y @swimmingliu/autovpn|pipx install" README.md docs .codex/skills
rtk proxy rg -n "Electron installers.*do not install|terminal autovpn" README.md docs .codex/skills
rtk proxy rg -n "AUTOVPN_WHEEL_URL|AUTOVPN_NO_INSTALL|AUTOVPN_CACHE_DIR|AUTOVPN_ALLOW_VERSION_MISMATCH|AUTOVPN_PYTHON_PACKAGE|AUTOVPN_FORCE_INSTALL" README.md docs .codex/skills npm/autovpn-cli
```

Pre-merge local command rehearsal uses the packed tarball, not the public npm registry:

```bash
rtk proxy npm pack --prefix npm/autovpn-cli
rtk proxy npx -y ./npm/autovpn-cli/*.tgz --help
rtk proxy npx -y ./npm/autovpn-cli/*.tgz --version
rtk proxy npx -y ./npm/autovpn-cli/*.tgz doctor --project-root "$PWD" --output json
rtk proxy npx -y ./npm/autovpn-cli/*.tgz profile summary --project-root "$PWD" --json
```

Pass criteria:

- Docs describe Electron, Python wheel/pipx, and npm/npx as separate installation paths.
- Agent skill prioritizes `npx`, installed `autovpn`, project venv, then `PYTHONPATH=src` fallback.
- Every command in docs either works as written or is clearly marked as a template with `<version>` or `<path>`.

## Phase 6: CI Workflow Tests

Goal: make PR checks catch npm wrapper regressions before release.

Required CI jobs:

- Python tests
- Electron headless Node tests
- npm wrapper unit tests
- npm wrapper pack dry-run
- Python wheel install smoke
- cross-platform wrapper smoke on Linux, macOS, and Windows
- version sync check

Required local workflow-equivalent command set:

```bash
rtk proxy ./scripts/run_pytest.sh tests -q
rtk proxy node --test electron/tests/backend.test.mjs electron/tests/package-build.test.mjs electron/tests/process-lifecycle.test.mjs electron/tests/release-docs-workflow.test.mjs electron/tests/release-notes.test.mjs electron/tests/ui-state.test.mjs electron/tests/window-config.test.mjs
rtk proxy npm ci --prefix npm/autovpn-cli
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy npm pack --dry-run --prefix npm/autovpn-cli
rtk proxy python -m build
rtk proxy python -m venv /tmp/autovpn-ci-wheel-smoke
rtk proxy /tmp/autovpn-ci-wheel-smoke/bin/python -m pip install dist/*.whl
rtk proxy /tmp/autovpn-ci-wheel-smoke/bin/autovpn --version
rtk proxy /tmp/autovpn-ci-wheel-smoke/bin/autovpn doctor --project-root "$PWD" --output json
rtk proxy node scripts/check-version-sync.mjs
```

Pass criteria:

- PR cannot merge when npm wrapper tests fail.
- PR cannot merge when versions drift.
- PR cannot merge when release docs omit npm package assets or install commands.

## Phase 7: Release Packaging Tests

Goal: verify every distributed artifact before a public release.

Python package:

```bash
rtk proxy python -m build
rtk proxy python -m twine check dist/*
rtk proxy test -f dist/vpn_subscription_automation-<version>-py3-none-any.whl
rtk proxy test -f dist/vpn_subscription_automation-<version>.tar.gz
```

npm package:

```bash
rtk proxy npm ci --prefix npm/autovpn-cli
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy npm pack --json --prefix npm/autovpn-cli
rtk proxy tar -tf npm/autovpn-cli/*.tgz
rtk proxy npm publish --dry-run --provenance --access public --prefix npm/autovpn-cli
```

Electron package:

```bash
rtk proxy npm run package:electron
```

Required Electron packaging checks:

- packaging log must not contain `default Electron icon is used`
- `electron/renderer/assets/vpn-auto-logo-v2-minimal.svg` exists
- generated icon resources exist for the target platform
- packaged artifact exists under `dist-electron/`

Pass criteria:

- Python, npm, and Electron artifacts are all built from the same version.
- npm tarball contents match the allowlist.
- npm publish dry-run succeeds before public registry publishing is enabled.
- Electron app icon uses the project asset, not Electron's default icon.

## Phase 8: Release Workflow and Registry Tests

Goal: verify GitHub Release and npm registry state after release.

Trigger or watch release workflow:

```bash
rtk proxy gh workflow run release-electron.yml -f tag_name=v<version>
rtk proxy gh run watch <run-id> --exit-status
```

Audit GitHub Release:

```bash
rtk proxy gh release view v<version> --json assets,body,url
```

Required GitHub Release assets:

```text
AutoVPN-<version>-arm64.dmg
AutoVPN-<version>-x64.dmg
AutoVPN-<version>-amd64.deb
AutoVPN-<version>-x86_64.rpm
AutoVPN-<version>-arm64.deb
AutoVPN-<version>-aarch64.rpm
AutoVPN-<version>-x64-setup.exe
AutoVPN-<version>-x64-portable.exe
AutoVPN-<version>-arm64-setup.exe
AutoVPN-<version>-arm64-portable.exe
vpn_subscription_automation-<version>-py3-none-any.whl
vpn_subscription_automation-<version>.tar.gz
<npm-wrapper-tarball>.tgz
```

Audit npm registry when public publish is enabled:

```bash
rtk proxy npx -y @swimmingliu/autovpn --help
rtk proxy npx -y @swimmingliu/autovpn --version
rtk proxy npx -y @swimmingliu/autovpn doctor --project-root "$PWD" --output json
rtk proxy npm view @swimmingliu/autovpn@<version> version
rtk proxy npm view @swimmingliu/autovpn@<version> bin
rtk proxy npm view @swimmingliu/autovpn@<version> dist.tarball
```

Pass criteria:

- GitHub Release body includes Electron, Python CLI, and npm/npx sections.
- npm registry publish is skipped safely if the same version already exists.
- Public npm publishing does not proceed until the repository license is decided and documented.

## Phase 9: Security, Redaction, and Failure Tests

Goal: prevent Agent logs and wrapper diagnostics from leaking sensitive values.

Sensitive values that must not appear in chat, logs, JSON summaries, or stderr:

- `.env` contents
- `sources.*.key`
- source URLs with tokens
- Cloudflare API token, global key, email, account ID
- `deploy.secret_query`
- full subscription URLs
- full `vmess://` links
- raw node files from artifacts

Required checks:

```bash
rtk proxy ./scripts/run_pytest.sh tests/backend/test_artifact_preview_cli.py tests/backend/test_doctor_cli.py tests/backend/test_headless_cli.py -v
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern redaction
```

Sentinel secret test:

1. Create a temporary profile or fixture with fake values such as `sentinel-source-key`, `sentinel-cloudflare-token`, `sentinel-secret-query`, `https://example.com/sub?token=sentinel-token`, and `vmess://sentinel-node`.
2. Run the relevant Python CLI and npm wrapper commands while capturing stdout and stderr to temporary files.
3. Assert that no sentinel value appears in stdout, stderr, tarball contents, or copied evidence logs:

```bash
rtk proxy rg -n "sentinel-source-key|sentinel-cloudflare-token|sentinel-secret-query|sentinel-token|vmess://sentinel-node" /tmp/autovpn-test-output && exit 1 || true
```

Forced failure scenarios:

| Scenario | Expected result |
| --- | --- |
| missing Python | wrapper diagnostic, no secret output |
| Python too old | wrapper diagnostic, no install attempt into system packages |
| wheel URL unreachable | actionable network/package error on stderr |
| cache unwritable | clear cache permission error |
| missing Mihomo | `doctor` reports fail/warn without crashing |
| missing Playwright | `doctor` reports fail/warn without crashing |
| missing Wrangler | deploy doctor reports fail/warn without running deploy |

Pass criteria:

- No secret-bearing values appear in stdout/stderr.
- Failure diagnostics tell the user what to install or configure next.
- Wrapper never writes to system Python or project root unless explicitly configured.

## Phase 10: Final Acceptance Checklist

Before merging the implementation PR:

- [ ] Python CLI contract tests pass.
- [ ] npm wrapper unit tests pass.
- [ ] npm packed tarball smoke tests pass.
- [ ] docs command checks pass.
- [ ] version sync check passes.
- [ ] Python wheel/sdist builds and passes `twine check`.
- [ ] installed wheel smoke passes for `--version` and `doctor --output json`.
- [ ] stdin forwarding is verified with `profile save`.
- [ ] forced Python stderr failure is forwarded without wrapper rewriting.
- [ ] stale PATH `autovpn` is rejected unless explicitly allowed.
- [ ] npm tarball allowlist audit passes.
- [ ] sentinel secret leak checks pass.
- [ ] Electron package test or build gate relevant to the change passes.
- [ ] local code review has no unresolved Critical or Important findings.
- [ ] PR CI is green.

Before publishing a release:

- [ ] GitHub tag matches Python, Electron, and npm versions.
- [ ] GitHub Release contains all required Electron, Python, and npm assets.
- [ ] npm publish is provenance-enabled and idempotent.
- [ ] npm publish dry-run has passed before public publishing.
- [ ] license decision is complete before public npm registry publication.
- [ ] release notes include npm/npx usage.
- [ ] `npx -y @swimmingliu/autovpn --version` matches the release version.
- [ ] `npx -y @swimmingliu/autovpn doctor --project-root <path> --output json` works on a clean Linux host.

## Evidence Template

Record this in the PR summary or release checklist:

```text
Test SOP evidence:
- Python contract: <command> => <pass/fail, run id or local output>
- npm unit: <command> => <pass/fail>
- npm pack smoke: <command> => <pass/fail>
- docs checks: <command> => <pass/fail>
- version sync: <command> => <pass/fail>
- package artifacts: <paths or release assets>
- CI: <workflow run URL>
- release audit: <GitHub Release URL and asset count>
- npm registry audit: <npm view output or deferred reason>
- reviewer: <review result>
```

## Completion Rule

The npm wrapper work is not fully tested until every required command, artifact, workflow, and acceptance item relevant to the implemented phases has direct evidence. A narrow smoke test cannot substitute for the phase-specific checks above.
