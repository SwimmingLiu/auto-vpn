# Headless CLI Implementation Plan

## Goal

Add a stable `autovpn` command for terminal, script, Linux headless, and Agent usage. The first implementation must be a thin wrapper over the existing Python backend, not a second pipeline implementation.

## Current Code Basis

`src/vpn_automation/backend.py` already provides the required backend functions and CLI subcommands:

- `ensure_profile_json()`
- `save_profile_json()`
- `artifact_latest_json()`
- `artifact_list_json()`
- `run_pipeline()`
- `run_pipeline_resume_latest()`
- `resume_pipeline()`
- `resume_speedtest()`
- `retry_stage()`
- JSONL/human streaming through `open_event_streams()`

`electron/ipc.js` already calls the backend through `python -m vpn_automation.backend`. Keep that path unchanged during the CLI MVP to avoid Electron regressions.

`pyproject.toml` currently exposes:

```toml
vpn-subscription-automation = "vpn_automation.app:main"
```

That entrypoint launches or packages the Electron app. Do not change its meaning. Add a separate `autovpn` console script.

## File Changes

Create:

- `src/vpn_automation/cli.py`
- `tests/backend/test_headless_cli.py`

Modify:

- `pyproject.toml`
- `README.md` after CLI behavior is verified

Do not modify in the MVP:

- `electron/ipc.js`
- `electron/lib/backend.js`
- renderer UI files

## Command Surface

### Global Options

Every subcommand should support:

```bash
--project-root <path>
```

Default project root should be resolved through `resolve_repo_anchor()` so `autovpn` behaves consistently from a repo checkout, worktree, or installed package.

### Profile Commands

```bash
autovpn profile show [--project-root <path>]
cat profile.json | autovpn profile save [--project-root <path>]
```

Implementation:

- `profile show` calls `ensure_profile_json(project_root)`.
- `profile save` reads stdin and calls `save_profile_json(project_root, payload)`.

Output:

- JSON to stdout.
- Exit `0` on successful read/save.
- Exit `1` on parsing or storage errors.

### Run Commands

```bash
autovpn run \
  [--project-root <path>] \
  [--resume-latest] \
  [--skip-deploy] \
  [--skip-verify] \
  [--output jsonl|human] \
  [--event-log <path>] \
  [--human-log <path>]
```

Implementation:

- Without `--resume-latest`, call `run_pipeline()`.
- With `--resume-latest`, call `run_pipeline_resume_latest()`.
- Default output should be `jsonl`.

Exit codes:

- `0` for successful summary.
- `1` for backend failure or exception.
- `2` for argparse usage errors.

### Artifact Commands

```bash
autovpn artifacts latest [--project-root <path>]
autovpn artifacts list [--project-root <path>]
```

Implementation:

- `latest` calls `artifact_latest_json(project_root)`.
- `list` calls `artifact_list_json(project_root)`.

Preserve the backend JSON shape. If no artifact exists, return `{"ok": false, "artifact_dir": ""}` with exit `0`; the command succeeded even though no run exists.

### Retry Command

```bash
autovpn retry-stage \
  --artifact-dir <path> \
  --stage <stage> \
  [--project-root <path>] \
  [--output jsonl|human] \
  [--event-log <path>] \
  [--human-log <path>]
```

Implementation:

- Call `retry_stage()`.
- Do not maintain a separate stage enum in the CLI MVP. Let backend validation remain authoritative.

### Resume Commands

```bash
autovpn resume pipeline \
  --session <path> \
  [--project-root <path>] \
  [--output jsonl|human] \
  [--event-log <path>] \
  [--human-log <path>]

autovpn resume speedtest \
  --session <path> \
  [--project-root <path>] \
  [--output jsonl|human] \
  [--event-log <path>] \
  [--human-log <path>]
```

Implementation:

- `resume pipeline` calls `resume_pipeline()`.
- `resume speedtest` calls `resume_speedtest()`.

## Implementation Notes

`cli.py` should keep routing small and boring:

```python
def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return dispatch(args)
    except Exception as exc:
        print(f"autovpn: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 1
```

Use helpers:

```python
def resolve_project_root(value: str) -> Path:
    candidate = Path(value or __file__)
    return resolve_repo_anchor(candidate)

def optional_path(value: str) -> Path | None:
    return Path(value).resolve() if value else None
```

For non-streaming commands, print the JSON string returned by backend functions directly. Avoid parsing and reserializing unless the command intentionally redacts or reshapes fields in a later stage.

## Test Strategy

Add `tests/backend/test_headless_cli.py`.

Required tests:

- `profile show` maps to `ensure_profile_json()`.
- `profile save` reads stdin and maps to `save_profile_json()`.
- `artifacts latest` preserves `ok=false` response and exits `0`.
- `artifacts list` prints backend JSON.
- `run --skip-deploy --skip-verify --output human --event-log ... --human-log ...` maps options correctly.
- `run --resume-latest` calls `run_pipeline_resume_latest()` and not `run_pipeline()`.
- `retry-stage --artifact-dir ... --stage deploy` passes resolved artifact path and stage name.
- `resume pipeline --session ...` calls `resume_pipeline()`.
- `resume speedtest --session ...` calls `resume_speedtest()`.
- Backend exceptions return exit `1` and print `autovpn: <ExceptionClass>: <message>` to stderr.

Use monkeypatches for backend functions. Do not start real network pipeline jobs in CLI unit tests.

Run:

```bash
rtk python -m pytest tests/backend/test_backend_cli.py tests/backend/test_headless_cli.py -q
rtk ./scripts/run_pytest.sh tests -v
rtk npm run test:electron
rtk npm run test:all
```

## Risks

- Changing the existing `vpn-subscription-automation` entrypoint would break desktop expectations. Add `autovpn` instead.
- Changing backend JSONL event fields would break Electron. Preserve `backend.py` protocol.
- Adding banner text to `jsonl` output would break Agents. JSONL stdout must contain events only.
- Reimplementing profile or artifact logic in the CLI would create drift. Call backend functions.
- Path resolution from arbitrary working directories can be subtle. Reuse `resolve_repo_anchor()`.
