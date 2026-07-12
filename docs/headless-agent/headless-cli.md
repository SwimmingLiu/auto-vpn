# Headless CLI Reference

The `autovpn` command is implemented by the Node.js package
`@swimmingliu/autovpn` and requires Node.js `>=22.5.0`.

## Diagnostics

```bash
autovpn --version
autovpn doctor --project-root . --output json
autovpn profile summary --project-root . --json
autovpn artifacts latest --project-root .
autovpn artifacts list --project-root .
```

## Pipeline

```bash
autovpn run --project-root . --output jsonl
autovpn run --project-root . --resume-latest --output jsonl
autovpn resume pipeline --project-root . --session <session-dir> --output jsonl
autovpn resume speedtest --project-root . --session <session-dir> --output jsonl
autovpn retry-stage --project-root . --artifact-dir <artifact-dir> --stage speedtest --output jsonl
```

Add `--skip-deploy --skip-verify` for a local diagnostic that does not publish
or verify a Cloudflare deployment.

### Run state and streaming stages

Every run owns an `artifact_dir`; `artifact_dir/run.db` is the authoritative local SQLite record. It contains node identities, stage results, and resume checkpoints. Legacy `.txt` and `.json` files are compatibility exports and may lag an active run, so agents must read `run.db` or the CLI JSON/JSONL contract when making control decisions.

For every unique node reported by an extract callback, pipeline mode first schedules a reachability probe. Only reachable nodes receive the full speed measurement, and only nodes that pass the configured speed threshold proceed to availability checks. Extraction, dedupe, speedtest, and availability can consequently report `running` at the same time. Their totals grow as nodes are discovered; a larger total does not reset completed or passing counts.

The worker queues use bounded concurrency and backpressure. When downstream measurements are slower than extraction, producers wait at the queue boundary rather than accumulating an unbounded backlog.

Resume and retry commands use SQLite checkpoints. `resume pipeline` continues the pipeline, `resume speedtest` restarts at the speed stage, `run --resume-latest` selects the latest resumable run, and `retry-stage` creates a new artifact lineage from the requested stage. Legacy artifact directories are imported when needed; after import, `run.db` is authoritative and legacy files remain compatibility exports.

Pipeline mode does not perform the old global `max_download_candidates` ranking cut before availability. A profile field with that name, if retained, is scoped to independent use of the legacy ranked-candidate speed module and does not cap the streaming pipeline.

## Detached Jobs

```bash
autovpn run --project-root . --detach --json
autovpn status --project-root . --json
autovpn logs --project-root . --tail 200
autovpn stop --project-root .
```

The job commands preserve metadata and logs under the configured runtime root.
Use `jobs show`, `jobs resume`, and `jobs retry` when operating a specific job.

## Output Contract

JSON commands write one JSON document to stdout. JSONL pipeline commands write
one event per line. Human diagnostics go to stderr, and sensitive values are
redacted before output.
