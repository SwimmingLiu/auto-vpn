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
