# Job Manager Implementation Plan

## Goal

Add persistent background job management for Linux headless and Agent workflows. Long AutoVPN runs must survive SSH disconnects, allow status checks from later sessions, expose logs, and stop the whole process tree safely.

## Current Code Basis

`src/vpn_automation/backend.py` already writes event and human logs through `open_event_streams()` and exposes run/resume/retry functions.

`src/vpn_automation/pipeline/run_store.py` stores artifact checkpoint state in `run.db`. It can identify incomplete runs, but it is not a process/job registry.

`electron/ipc.js` currently starts backend processes with `detached: true` and implements stop via `stopActivePipeline()`.

`electron/lib/process-lifecycle.js` resolves a non-Windows process tree target as negative PID, which signals the detached process group.

## State Model

Create job state under the runtime state root:

```text
state/jobs/
  index.json
  <job_id>/
    job.json
    events.jsonl
    human.log
    stdout.log
    stderr.log
```

`job.json` should contain:

```json
{
  "schema_version": 1,
  "job_id": "20260626-153012-a1b2c3",
  "kind": "run",
  "status": "running",
  "pid": 12345,
  "pgid": 12345,
  "created_at": "2026-06-26T15:30:12+08:00",
  "started_at": "2026-06-26T15:30:12+08:00",
  "finished_at": "",
  "exit_code": null,
  "signal": "",
  "project_root": "/path/to/vpn-subscription-automation",
  "command": ["python", "-m", "vpn_automation.backend", "run"],
  "event_log": ".../events.jsonl",
  "human_log": ".../human.log",
  "stdout_log": ".../stdout.log",
  "stderr_log": ".../stderr.log",
  "artifact_dir": "",
  "session_dir": ".../jobs/20260626-153012-a1b2c3",
  "resume_from": "",
  "retry": {
    "source_artifact_dir": "",
    "stage": ""
  },
  "options": {
    "skip_deploy": true,
    "skip_verify": true
  },
  "stop_requested_at": "",
  "last_event_at": "",
  "last_error": ""
}
```

`index.json` should be a lightweight index:

```json
{
  "schema_version": 1,
  "latest_job_id": "20260626-153012-a1b2c3",
  "jobs": [
    {
      "job_id": "20260626-153012-a1b2c3",
      "status": "running",
      "kind": "run",
      "created_at": "2026-06-26T15:30:12+08:00",
      "job_file": ".../job.json"
    }
  ]
}
```

Use atomic writes for JSON files. When multiple Agents may operate concurrently, add a lock file around index updates.

## Command Surface

```bash
autovpn run --detach --json
autovpn jobs list --json
autovpn jobs status <job-id> --json
autovpn jobs logs <job-id> --format human --tail 200
autovpn jobs logs <job-id> --format jsonl --follow
autovpn jobs stop <job-id> [--timeout 4]
autovpn status --json
autovpn logs --follow
autovpn stop
autovpn jobs resume <job-id> [--detach]
autovpn jobs retry --artifact-dir <dir> --stage <stage> [--detach]
```

Aliases:

- `autovpn status --json` means latest job status.
- `autovpn logs --follow` means latest job human log follow.
- `autovpn stop` means latest running job stop, but should ask or fail if more than one active job exists.

## Process Control

Detached jobs must use a new session/process group:

```python
subprocess.Popen(
    command,
    cwd=project_root,
    env=env,
    stdin=subprocess.DEVNULL,
    stdout=stdout_handle,
    stderr=stderr_handle,
    start_new_session=True,
)
```

Stop sequence:

1. Read `job.json`.
2. Verify PID is plausible and command matches AutoVPN if possible.
3. Set status to `stopping` and record `stop_requested_at`.
4. Send `SIGTERM` to the process group with `os.killpg(pid, signal.SIGTERM)`.
5. Wait for timeout seconds.
6. If still alive, send `SIGKILL` to the process group.
7. Mark job as `stopped`.
8. Reconcile artifact `run.db` and `pipeline_report.json` if present, but do not require them to record a graceful stop.

This follows the Electron behavior in `electron/lib/process-lifecycle.js`, where non-Windows platforms signal `-pid`.

## Log and Event Handling

Use existing backend stream files:

- `events.jsonl` for structured events.
- `human.log` for human-readable logs.
- `stdout.log` and `stderr.log` for wrapper/process fallback.

Job manager should not parse stdout as the primary status channel. Instead:

1. On start, write PID and status.
2. Scan `events.jsonl` for `run_started` to capture `artifact_dir`.
3. Scan `summary` events to capture `stage_status`, `counts`, `run_status`, and `error`.
4. On child exit, set `success`, `failed`, or `stopped`.
5. `jobs status` should reconcile stale running jobs if the process is no longer alive.

`jobs logs --follow` should tail the log file. It must not depend on the original process pipe, because the caller may connect from a different terminal or Agent session.

## Resume and Retry

Support three recovery modes:

1. Latest incomplete run:

```bash
autovpn run --resume-latest
```

This uses `RunStore.find_latest_incomplete_run()` through existing backend logic.

2. Session resume:

```bash
autovpn resume pipeline --session <session-dir>
autovpn resume speedtest --session <session-dir>
```

The job directory should either contain `session.json` or point to a compatible session directory.

3. Stage retry:

```bash
autovpn retry-stage --artifact-dir <artifact-dir> --stage <stage>
```

`jobs retry` should wrap this and create a new job with retry context.

## Reconcile Rules

When `jobs status` sees a job marked `running` or `stopping`:

- If PID exists, leave it running and refresh last event fields.
- If PID does not exist, read the last complete JSON event in `events.jsonl`.
- If `pipeline_report.json` exists and says `success`, mark job `success`.
- If `run.db` says final state is `failed`, `stopped`, or `success`, mirror that state.
- If there is no summary and no live PID, mark `failed` with `last_error="process exited without summary"`.

## Tests

Add tests for:

- Job store create/update/index/latest.
- Atomic write behavior.
- `run --detach` command construction with `--event-log` and `--human-log`.
- Mocked `subprocess.Popen` returning PID and creating job files.
- `jobs status --json` for running, success, failed, stopped, and stale-running cases.
- `jobs logs --tail`.
- `jobs stop` SIGTERM then SIGKILL behavior via mocked `os.killpg`.
- `jobs resume` command mapping.
- `jobs retry` command mapping.

Integration smoke:

- Start a fake short-lived backend job.
- Poll status until complete.
- Verify `job.json`, `index.json`, `events.jsonl`, and `human.log`.
- Start a sleep-like process group and verify stop kills it.

## Risks

- PID reuse can make stale `pid` unsafe. Mitigate by checking command line or Linux `/proc/<pid>/stat` start time when feasible.
- Artifact pruning may remove an artifact referenced by an old job. Running job artifacts should be protected or reconciliation should tolerate missing artifacts.
- `job.json`, `run.db`, and `pipeline_report.json` are different state sources. Keep responsibilities clear: job state is process state; `run.db` is checkpoint state; report is result summary.
- SIGTERM may prevent backend from writing a final summary. Job manager must own stopped status.
- Windows process-tree behavior is different. First target should be Linux/macOS headless.
- Concurrent Agents can race on `index.json`. Use lock/atomic writes.
