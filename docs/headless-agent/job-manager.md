# Detached Job Manager

AutoVPN detached jobs are owned by the Node.js CLI and stored under
`$HOME/.auto-vpn/jobs` by default.

## Files

Each job directory contains durable metadata and logs:

- `job.json`: identity, command, state, timestamps, worker PID, artifact path.
- `stdout.log`: structured command output.
- `stderr.log`: diagnostics.

The job index is process state. Artifact reports are pipeline state. Keep those
responsibilities separate when reconciling an interrupted run.

## Lifecycle

```text
starting -> running -> success
                    -> failed
                    -> stopped
```

The launcher writes `starting` before spawning, records the worker PID, then
advances to `running`. The worker writes a terminal state after closing its
logs. Status checks reconcile stale non-terminal records when the recorded
process no longer exists.

## Commands

```bash
autovpn run --project-root "$PROJECT_ROOT" --detach --json
autovpn jobs list --project-root "$PROJECT_ROOT" --json
autovpn jobs show "$JOB_ID" --project-root "$PROJECT_ROOT" --json
autovpn jobs logs "$JOB_ID" --project-root "$PROJECT_ROOT" --tail 200
autovpn jobs stop "$JOB_ID" --project-root "$PROJECT_ROOT"
autovpn jobs resume "$JOB_ID" --project-root "$PROJECT_ROOT" --detach --json
autovpn jobs retry "$JOB_ID" --project-root "$PROJECT_ROOT" --stage speedtest --detach --json
```

## Recovery Rules

1. Treat a live matching PID as authoritative for a running job.
2. Treat a missing or reused PID as stale and inspect the artifact report.
3. Preserve logs and metadata for failed and stopped jobs.
4. Resume from the latest valid checkpoint instead of starting a duplicate run.
5. Never infer success solely from process exit; confirm the final report.

## Run records beside the artifact

Every run also mirrors its event stream to `<artifact_dir>/events.jsonl`, whether
it was started detached, in the foreground, or by cron. A scheduled run has no
job directory, so this file is the only record the served UI can replay: the
logs page reads it, and `serve` tails it while the run is still writing.

## Retention

`serve` prunes old records once a day, at the first state load after a day has
passed. The cutoff is the start of the day N days back, so with the default the
sweep removes everything older than today (T+1) and keeps a run that finished
late yesterday.

| Variable | Default | Scope |
|---|---|---|
| `AUTOVPN_SERVER_HISTORY_RETENTION_DAYS` | `7` | Job directories and artifact directories |
| `AUTOVPN_SERVER_LOG_RETENTION_DAYS` | follows history | `logs/daily-run-*.log` and `daily-run-results/*.json` |

`0` disables the corresponding sweep. A running or stopping job, and the artifact
it owns, are never pruned.
