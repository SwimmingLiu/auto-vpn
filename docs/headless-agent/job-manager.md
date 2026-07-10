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
