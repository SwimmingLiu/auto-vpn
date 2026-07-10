# AutoVPN Agent Skill

Use these commands when an Agent operates AutoVPN. Require Node.js `>=22.5.0`
and an installed `autovpn` command or `npx -y @swimmingliu/autovpn`.

## Read Before Mutating

Start with diagnostics and current state:

```bash
autovpn doctor --project-root "$PROJECT_ROOT" --output json
autovpn profile summary --project-root "$PROJECT_ROOT" --json
autovpn artifacts latest --project-root "$PROJECT_ROOT"
autovpn status --project-root "$PROJECT_ROOT" --json
```

Never print profile credentials, provider URLs, subscription links, tokens, or
worker secrets. Prefer summarized artifact commands over direct file dumps.

## Run

Use foreground JSONL when the caller needs stage events:

```bash
autovpn run --project-root "$PROJECT_ROOT" --output jsonl
```

Use a detached job when the process must survive the calling session:

```bash
autovpn run --project-root "$PROJECT_ROOT" --detach --json
autovpn status --project-root "$PROJECT_ROOT" --json
autovpn logs --project-root "$PROJECT_ROOT" --tail 200
```

For a non-deploying diagnostic run:

```bash
autovpn run --project-root "$PROJECT_ROOT" --skip-deploy --skip-verify --output jsonl
```

## Resume And Retry

Inspect the latest artifact before choosing the narrowest recovery command:

```bash
autovpn artifacts preview --project-root "$PROJECT_ROOT"
autovpn resume pipeline --project-root "$PROJECT_ROOT" --session "$SESSION_DIR" --output jsonl
autovpn resume speedtest --project-root "$PROJECT_ROOT" --session "$SESSION_DIR" --output jsonl
autovpn retry-stage --project-root "$PROJECT_ROOT" --artifact-dir "$ARTIFACT_DIR" --stage speedtest --output jsonl
```

## Stop

```bash
autovpn stop --project-root "$PROJECT_ROOT"
```

Confirm the final status after stopping. Do not delete the job directory while
its worker is still alive.

## Server UI

```bash
autovpn serve --project-root "$PROJECT_ROOT"
```

Non-loopback binds require an explicit token or explicit no-auth selection.
Prefer SSH forwarding or an authenticated reverse proxy for remote use.
