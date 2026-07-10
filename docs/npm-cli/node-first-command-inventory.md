# AutoVPN Node-first Command Inventory

> Historical pre-migration inventory. Do not use its commands as current
> operating instructions; use `node-first-contract.md`.

Source files inspected:

- `src/vpn_automation/cli.py`
- `src/vpn_automation/backend.py`
- `src/vpn_automation/jobs.py`
- `src/vpn_automation/artifact_preview.py`
- `src/vpn_automation/doctor.py`
- `electron/ipc.js`
- `electron/lib/backend.js`
- `tests/backend/test_headless_cli.py`
- `tests/backend/test_doctor_cli.py`
- `tests/backend/test_jobs_cli.py`
- `tests/backend/test_artifact_preview_cli.py`

Baseline verification:

```bash
rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh tests/backend/test_headless_cli.py tests/backend/test_doctor_cli.py tests/backend/test_jobs_cli.py -v
rtk proxy node --test electron/tests/backend.test.mjs electron/tests/process-lifecycle.test.mjs
```

## User-facing Python CLI

The current user-facing entrypoint is declared in `pyproject.toml`:

```toml
autovpn = "vpn_automation.cli:main"
```

All commands resolve `--project-root` through `resolve_repo_anchor`, so worktree paths and nested paths are normalized back to the project root.

| Command | Arguments | Stdout mode | Stdin | Exit code | Risk | Python execution path |
| --- | --- | --- | --- | --- | --- | --- |
| `autovpn profile show` | `--project-root` | JSON profile | none | `0` on success, `1` on exception | Low | `cli.dispatch` -> `backend.ensure_profile_json` |
| `autovpn profile save` | `--project-root` | JSON profile | full JSON profile payload | `0` on success, `1` on exception | Medium | `cli.dispatch` -> `backend.save_profile_json` |
| `autovpn profile summary` | `--project-root`, `--json` | JSON summary; secrets collapsed to `set`/`missing` | none | `0` on success, `1` on exception | Low | `cli.dispatch` -> `_profile_summary_json` |
| `autovpn doctor` | `--project-root`, `--deploy`, `--strict`, `--output human|json` | human or JSON | none | doctor return code | Low for static checks, High with deploy readiness | `cli.dispatch` -> `doctor.run_doctor` |
| `autovpn artifacts latest` | `--project-root` | JSON latest artifact metadata | none | `0` on success, `1` on exception | Low | `cli.dispatch` -> `backend.artifact_latest_json` |
| `autovpn artifacts list` | `--project-root` | JSON artifact list and retry stages | none | `0` on success, `1` on exception | Low | `cli.dispatch` -> `backend.artifact_list_json` |
| `autovpn artifacts preview` | `artifact_dir`, `--project-root`, `--json` | JSON artifact preview | none | `0` on success, `1` on exception | Low | `cli.dispatch` -> `artifact_preview.preview_artifact_json` |
| `autovpn run` | `--project-root`, `--resume-latest`, `--skip-deploy`, `--skip-verify`, `--output jsonl|human`, `--event-log`, `--human-log`, `--detach`, `--json` | JSONL/human event stream, detached JSON or human start line | none | `0` on successful run, `1` on run failure/exception | High | `cli.dispatch` -> `backend.run_pipeline` or `backend.run_pipeline_resume_latest`; detached uses `jobs.start_detached_run` |
| `autovpn retry-stage` | `--project-root`, `--artifact-dir`, `--stage`, `--output jsonl|human`, `--event-log`, `--human-log` | JSONL/human event stream | none | `0` on successful retry, `1` on failure/exception | High | `cli.dispatch` -> `backend.retry_stage` |
| `autovpn resume pipeline` | `--project-root`, `--session`, `--output jsonl|human`, `--event-log`, `--human-log` | JSONL/human event stream | none | `0` on successful resume, `1` on failure/exception | High | `cli.dispatch` -> `backend.resume_pipeline` |
| `autovpn resume speedtest` | `--project-root`, `--session`, `--output jsonl|human`, `--event-log`, `--human-log` | JSONL/human event stream | none | `0` on successful resume, `1` on failure/exception | High | `cli.dispatch` -> `backend.resume_speedtest` |
| `autovpn jobs list` | `--project-root`, `--json` | JSON job index | none | `0` on success, `1` on exception | Medium | `cli.dispatch` -> `jobs.list_jobs` |
| `autovpn jobs status` | `job_id`, `--project-root`, `--json` | JSON public job payload | none | `0` on success, `1` on exception | Medium | `cli.dispatch` -> `jobs.job_status` |
| `autovpn jobs logs` | `job_id`, `--project-root`, `--format human|jsonl`, `--tail`, `--follow` | selected log content | none | `0` on success, `1` on exception | Medium | `cli.dispatch` -> `jobs.tail_log` or `jobs.follow_log` |
| `autovpn jobs stop` | `job_id`, `--project-root`, `--timeout` | JSON public job payload | none | `0` on success, `1` on exception | Medium | `cli.dispatch` -> `jobs.stop_job` |
| `autovpn jobs resume` | `job_id`, `--project-root`, `--detach`, `--json`, `--output jsonl|human` | JSONL/human event stream or detached JSON/human start line | none | `0` on success, `1` on failure/exception | Medium/High | `cli.dispatch` -> `jobs.start_detached_resume`, `jobs.start_detached_run`, `backend.resume_pipeline`, or `backend.run_pipeline_resume_latest` |
| `autovpn jobs retry` | `--project-root`, `--artifact-dir`, `--stage`, `--detach`, `--json`, `--output jsonl|human` | JSONL/human event stream or detached JSON/human start line | none | `0` on success, `1` on failure/exception | Medium/High | `cli.dispatch` -> `jobs.start_detached_retry` or `backend.retry_stage` |
| `autovpn status` | `--project-root`, `--json` | JSON latest active/public job payload | none | `0` on success, `1` on exception | Medium | `cli.dispatch` -> `jobs.latest_job_id` + `jobs.job_status` |
| `autovpn logs` | `--project-root`, `--format human|jsonl`, `--tail`, `--follow` | latest job log content | none | `0` on success, `1` on exception | Medium | `cli.dispatch` -> `jobs.latest_job_id` + `jobs.tail_log` or `jobs.follow_log` |
| `autovpn stop` | `--project-root`, `--timeout` | JSON public job payload | none | `0` on success, `1` on exception | Medium | `cli.dispatch` -> `jobs.single_active_job_id` + `jobs.stop_job` |

## Electron Backend Calls

Electron currently shells into Python via `electron/lib/backend.js::buildBackendInvocation`, which builds:

```text
python -m vpn_automation.backend <command> --project-root <projectRoot> ...
```

| Electron IPC channel | Python backend command | Arguments | Output contract |
| --- | --- | --- | --- |
| `profile:load` | `profile` | `--project-root` | JSON profile |
| `profile:save` | `profile-save` | `--project-root`; JSON stdin | JSON profile, Electron returns `{ ok: true }` |
| `pipeline:run` | `run` | `--project-root`, optional `--skip-deploy`, `--skip-verify` | JSONL events on stdout, stderr converted to `log` events |
| `artifact:latest` | `artifact-latest` | `--project-root` | JSON latest artifact metadata |
| `artifact:list` | `artifact-list` | `--project-root` | JSON artifact list |
| `pipeline:retry-stage` | `retry-stage` | `--project-root`, `--artifact-dir`, `--stage` | JSONL events on stdout, stderr converted to `log` events |

Electron process lifecycle semantics are covered by `electron/tests/backend.test.mjs` and `electron/tests/process-lifecycle.test.mjs`.

## Migration Classification

Low-risk commands can move to Node once their JSON, help, and exit-code parity tests pass:

- `--help`, `--version`
- `profile summary`
- `artifacts latest/list/preview`
- `doctor` without live deploy checks

Medium-risk commands require state file parity and process lifecycle tests:

- `profile save`
- `jobs list/status/logs/stop/resume/retry`
- top-level `status/logs/stop`
- detached `run`

High-risk commands require fixture parity and live-gated integration tests:

- foreground `run`
- `retry-stage`
- `resume pipeline`
- `resume speedtest`
- pipeline stages: extract, dedupe, speedtest, availability, postprocess, render, obfuscate, deploy, verify
