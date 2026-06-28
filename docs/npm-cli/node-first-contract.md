# AutoVPN Node-first CLI Contract

Source files inspected:

- `src/vpn_automation/cli.py`
- `src/vpn_automation/backend.py`
- `src/vpn_automation/jobs.py`
- `src/vpn_automation/doctor.py`
- `src/vpn_automation/artifact_preview.py`
- `src/vpn_automation/redaction.py`
- `electron/ipc.js`
- `electron/lib/backend.js`
- `tests/backend/test_headless_cli.py`
- `tests/backend/test_doctor_cli.py`
- `tests/backend/test_jobs_cli.py`
- `tests/backend/test_artifact_preview_cli.py`

This contract freezes the behavior that a Node-first CLI must preserve while the Python backend remains supported.

## Global Rules

- `autovpn` is the public terminal command.
- `--project-root` defaults to the current repository anchor resolved from the provided path or the package source path.
- stdout is machine-readable for JSON/JSONL modes.
- stderr is diagnostics-only and must not contain secrets.
- Exceptions from `cli.main` currently print `autovpn: <ExceptionClass>: <message>` to stderr and return exit code `1`.
- Secret-bearing values are redacted or collapsed before they appear in public JSON.
- The npm wrapper may discover and launch Python, but it must not parse business commands in Phase 1.

## Output Flags

The Python CLI does not expose one global output format. Node shell work must preserve command-specific flags:

| Command group | Output selector |
| --- | --- |
| `run`, `retry-stage`, `resume pipeline`, `resume speedtest` | `--output jsonl|human` |
| `doctor` | `--output human|json` |
| `profile summary`, `artifacts preview`, `jobs list/status/resume/retry`, top-level `status` | `--json` where currently accepted |
| `jobs logs`, top-level `logs` | `--format human|jsonl` |
| `profile show/save`, `artifacts latest/list` | JSON only |

## Exit Codes

| Condition | Exit code |
| --- | --- |
| Successful read/write/inspection command | `0` |
| Successful pipeline or resume | `0` |
| Failed pipeline summary or raised pipeline exception | `1` |
| Doctor warning without `--strict` | `0` |
| Doctor failure or strict warning | doctor return code, usually `1` |
| Parser error from argparse | `2` |
| Unhandled CLI exception caught by `cli.main` | `1` |

## Stdout/Stderr Contract

| Command class | stdout | stderr |
| --- | --- | --- |
| JSON inspection commands | one JSON document plus newline | empty unless diagnostics/error |
| JSONL pipeline commands | one JSON object per line | diagnostics only |
| human pipeline commands | rendered event lines | diagnostics only |
| detached commands with `--json` | one JSON document plus newline | diagnostics only |
| detached commands without `--json` | `started job <job_id> pid=<pid>` | diagnostics only |
| parser errors | argparse usage and error text | argparse writes to stderr |

## Redaction Contract

The following values must never be emitted as raw secrets in public CLI output:

- source `url`
- source `key`
- `deploy.cloudflare_api_token`
- `deploy.cloudflare_global_key`
- `deploy.cloudflare_email`
- `deploy.account_id`
- `deploy.subscription_url`
- `deploy.verify_subscription_url`
- `deploy.secret_query`
- deployment stdout/stderr that contains URLs, query strings, tokens, or credentials
- job `last_error` and report `error` values

Current behavior:

- `profile summary` emits `set` or `missing` for secret-bearing fields.
- artifact and job summaries pass deployment/error fields through `safe_deployment` and `redact_text`.
- pipeline `summary` events redact `deployment` and `error`.
- `run_failed` errors are redacted when reconciled into job state.

## Job State Contract

Job state is stored under the profile state directory:

```text
state/jobs/index.json
state/jobs/<job-id>/job.json
state/jobs/<job-id>/events.jsonl
state/jobs/<job-id>/human.log
state/jobs/<job-id>/stdout.log
state/jobs/<job-id>/stderr.log
```

`job.json` public fields currently include:

```text
schema_version
job_id
kind
status
pid
pgid
created_at
started_at
finished_at
updated_at
exit_code
signal
project_root
command
event_log
human_log
stdout_log
stderr_log
artifact_dir
session_dir
resume_from
retry
options
stop_requested_at
last_event_at
last_error
job_file
```

Valid runtime statuses:

```text
running
stopping
success
failed
stopped
```

Top-level `status`, `logs`, and `stop` operate on the latest or single active job and must preserve the current ambiguity errors.

## Artifact Contract

Artifacts are resolved through `resolve_artifacts_root` and `RunStore.find_latest_artifact_dir`.

Important files for Node parity:

```text
pipeline_report.json
run.db
session.json
events.jsonl
human.log
vpn_node_raw.txt
vpn_node_deduped.txt
vpn_node_speedtest.txt
vpn_node_available.txt
vpn_node_final.txt
```

`artifacts latest` returns:

```text
ok
artifact_dir
run_status
stage_status
counts
source_counts
deployment
error
```

`artifacts list` returns retryable stage metadata from `backend_resume.list_artifacts_with_retry_stages`.

`artifacts preview` returns a redacted preview suitable for Electron result pages and terminal Agents.

## Electron Compatibility Contract

Electron consumes the Python backend event stream using `parseBackendEventLine`.

Node-first work must preserve:

- JSONL event line format.
- renderer-facing event names.
- stop behavior using detached process groups where available.
- stderr-to-log event conversion.
- profile load/save JSON shape.
- artifact latest/list JSON shape.

## Phase 1 npm Wrapper Contract

The npm package must:

- expose `bin.autovpn`;
- forward argv exactly as received;
- forward stdin to the Python process;
- forward stdout/stderr without rewriting;
- exit with the Python process exit code;
- support `AUTOVPN_PYTHON_CLI`;
- support PATH discovery only when `autovpn --version` matches the npm package version;
- support wrapper-managed install/cache paths;
- fail clearly when installation is disabled and no compatible Python CLI is available.

The npm wrapper must not:

- reinterpret AutoVPN business flags;
- redact or reformat Python stdout/stderr;
- run live deploy checks by default;
- publish to the public npm registry before license/provenance/idempotency gates are complete.
