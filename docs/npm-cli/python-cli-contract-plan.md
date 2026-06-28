# Python CLI Contract Plan

## Decision

The npm wrapper depends only on the Python `autovpn` console script:

```toml
[project.scripts]
autovpn = "vpn_automation.cli:main"
```

It must not depend on Electron's private backend command protocol.

## Stable Contract

Exit codes:

```text
0 = command succeeded
1 = runtime or business failure
2 = argparse usage error
```

Streams:

- Machine-readable success output goes to stdout.
- Human-readable or diagnostic errors go to stderr.
- `--output jsonl` stdout contains one JSON object per line.
- JSON/JSONL stdout must not contain npm or wrapper banners.

Project root:

- Agent and wrapper examples should pass `--project-root` as an absolute path.
- The wrapper must not rely on Python package install location to infer the repository root.

## Commands the Wrapper Can Rely On

Single JSON object commands:

```bash
autovpn doctor --project-root "$PWD" --output json
autovpn profile summary --project-root "$PWD" --json
autovpn profile show --project-root "$PWD"
autovpn artifacts latest --project-root "$PWD"
autovpn artifacts list --project-root "$PWD"
autovpn artifacts preview <artifact-dir> --project-root "$PWD" --json
autovpn status --project-root "$PWD" --json
autovpn jobs list --project-root "$PWD" --json
autovpn jobs status <job-id> --project-root "$PWD" --json
```

JSONL commands:

```bash
autovpn run --project-root "$PWD" --output jsonl
autovpn retry-stage --project-root "$PWD" --artifact-dir <artifact-dir> --stage <stage> --output jsonl
autovpn resume pipeline --project-root "$PWD" --session <session-dir> --output jsonl
autovpn resume speedtest --project-root "$PWD" --session <session-dir> --output jsonl
```

Detached job commands:

```bash
autovpn run --project-root "$PWD" --detach --json
autovpn jobs logs <job-id> --project-root "$PWD" --format human --tail 200
autovpn jobs stop <job-id> --project-root "$PWD"
autovpn jobs resume <job-id> --project-root "$PWD" --detach --json
autovpn jobs retry --project-root "$PWD" --artifact-dir <artifact-dir> --stage <stage> --detach --json
```

## Required CLI Improvements

Add top-level version:

```bash
autovpn --version
```

Expected output:

```text
autovpn 1.3.0
```

Add doctor JSON alias:

```bash
autovpn doctor --json
```

Equivalent to:

```bash
autovpn doctor --output json
```

Document that several commands are JSON by default and accept `--json` as an explicit compatibility flag.

## Optional CLI Improvements

Add install diagnostics:

```bash
autovpn doctor --install --json
```

or:

```bash
autovpn doctor install --json
```

Checks should cover:

- Python version `>=3.12`
- Python package version
- `autovpn` entry point availability
- `mihomo`
- `node`, `npm`, `npx`
- Playwright package and Chromium/headless shell
- `wrangler`
- `javascript-obfuscator`
- profile path writability
- artifacts path writability

This command must not execute a real deployment.

## Version Synchronization Risks

Names in play:

```text
Python distribution: vpn-subscription-automation
Python import package: vpn_automation
Python console script: autovpn
npm package: @swimmingliu/autovpn
npm bin: autovpn
wheel file: vpn_subscription_automation-<version>-py3-none-any.whl
```

Risks:

- The npm package name is not the Python distribution name.
- A system `autovpn` on PATH may be stale.
- npm package version and Python package version can drift.
- Wheel filenames use normalized underscores.

Mitigations:

- The wrapper should install `vpn-subscription-automation==<npm version>` or the matching GitHub Release wheel.
- CI should verify `pyproject.toml`, root `package.json`, and `npm/autovpn-cli/package.json` all match.
- `autovpn --version` should be tested from an installed wheel.

## Headless Feature Coverage

Already covered by Python CLI:

- profile read/save/summary
- pipeline run
- skip deploy and verify flags
- JSONL event streaming
- artifact latest/list/preview
- retry stage
- resume pipeline and speedtest
- detached jobs
- job status/logs/stop/resume/retry
- doctor checks

Not required for headless:

- clipboard writes
- Electron window state
- renderer UI state
- shell open URL/path
- QR display UI

If Agent workflows need QR or subscription previews, expose them through artifact summaries or file paths instead of Electron UI.

## Contract Tests

Add `tests/backend/test_cli_contract.py`.

Coverage:

- `autovpn --version` exits `0` and prints the package version.
- `autovpn --help` exits `0` and lists core commands.
- invalid arguments exit `2`.
- runtime failures exit `1` and write stable stderr.
- `doctor --json` equals `doctor --output json`.
- JSON commands parse with `json.loads`.
- JSONL commands produce parseable JSON per line.
- JSONL stdout contains no banner text.
- `--project-root` with an absolute path resolves consistently.
- secrets are not printed in doctor/profile summary/artifact preview paths.

Wrapper integration coverage:

- npm bin calls `--help`.
- npm bin calls `--version`.
- npm bin preserves Python exit codes.
- npm bin does not corrupt JSON stdout.
- npm bin handles project paths with spaces.
- stale PATH `autovpn` does not override the wrapper-managed backend when policy says it should not.
