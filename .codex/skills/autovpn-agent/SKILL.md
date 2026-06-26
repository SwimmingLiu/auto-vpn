---
name: autovpn-agent
description: Use when configuring, running, monitoring, stopping, resuming, retrying, or diagnosing AutoVPN through the autovpn CLI.
---

# AutoVPN Agent SOP

## Scope

Use this skill only for operating AutoVPN as a terminal/headless tool:

- configure or inspect the runtime profile
- run local generation, detached jobs, deploy, or verify
- monitor, stop, resume, or retry jobs
- inspect artifacts and logs
- diagnose extraction, speedtest, availability, render, obfuscate, deploy, or verify failures

Do not use Electron UI automation for production AutoVPN operations. Do not refactor pipeline code as part of an operational run.

## Sensitive Data Rules

Never print or paste these values:

- `.env` contents
- `sources.*.key`
- source URLs with query tokens
- `deploy.secret_query`
- Cloudflare API token, global key, email, account ID
- full `deploy.subscription_url` or `deploy.verify_subscription_url`
- full `vmess://` links
- raw node files from artifacts
- worker bundles that may contain subscription data

Allowed reporting style:

```text
sources.leiting.key=set
deploy.cloudflare_api_token=missing
.env.CLOUDFLARE_API_TOKEN=set
stage.deploy=success
final_links=123
verify_subscription_url=https://example.com/sub?token=<redacted>
```

## Preflight

From the project root:

```bash
autovpn doctor --project-root "$PWD" --output json
```

For deploy readiness:

```bash
autovpn doctor --project-root "$PWD" --deploy --strict --output json
```

Report only pass/warn/fail, set/missing, and check names. Do not print secret-bearing details.

## Profile Read/Write

Safe summary:

```bash
autovpn profile summary --project-root "$PWD" --json
```

Raw read for explicit edits only:

```bash
autovpn profile show --project-root "$PWD"
```

`profile show` prints raw profile data that may contain source keys, tokenized URLs, and Cloudflare credentials. Do not run it unless the user explicitly asks to inspect or change configuration, and do not paste its raw output into chat.

Write only after the user explicitly asks for a profile change:

```bash
cat profile.json | autovpn profile save --project-root "$PWD"
```

Before reporting profile values, redact source keys, tokenized URLs, Cloudflare credentials, and subscription URLs.

## Run

Local non-deploy generation:

```bash
autovpn run --project-root "$PWD" --skip-deploy --skip-verify --output jsonl
```

Agent-safe detached run:

```bash
autovpn run --project-root "$PWD" --detach --json
```

Full deploy and verify:

```bash
autovpn run --project-root "$PWD" --output jsonl
```

Run full deploy only when the user asked for deployment and `doctor --deploy --strict` passes or the user explicitly accepts the remaining risk.

## Observe

Preferred commands:

```bash
autovpn status --project-root "$PWD" --json
autovpn logs --project-root "$PWD" --tail 200
autovpn jobs status <job-id> --project-root "$PWD" --json
autovpn jobs logs <job-id> --project-root "$PWD" --format human --tail 200
autovpn artifacts latest --project-root "$PWD"
autovpn artifacts list --project-root "$PWD"
autovpn artifacts preview <artifact-dir> --project-root "$PWD" --json
```

Use `artifacts preview` for summaries. Do not read or paste raw node files unless the user explicitly requests local file inspection, and still do not paste secrets into chat.

## Stop

Preferred:

```bash
autovpn jobs stop <job-id> --project-root "$PWD"
```

Latest-job alias:

```bash
autovpn stop --project-root "$PWD"
```

The job manager stops the process group. Avoid killing only the direct child PID because Mihomo, Playwright, Wrangler, or other child processes may continue running.

## Resume

Latest incomplete backend run:

```bash
autovpn run --project-root "$PWD" --resume-latest --output human
```

Resume a known session:

```bash
autovpn resume pipeline --project-root "$PWD" --session <session-dir> --output human
autovpn resume speedtest --project-root "$PWD" --session <session-dir> --output human
```

Detached resume from a job:

```bash
autovpn jobs resume <job-id> --project-root "$PWD" --detach --json
```

If the job has a compatible `session.json`, this resumes that session. If it is a normal detached run without `session.json`, AutoVPN starts a detached `run --resume-latest` job instead.

## Retry

Inspect retryable stages first:

```bash
autovpn artifacts list --project-root "$PWD"
autovpn artifacts preview <artifact-dir> --project-root "$PWD" --json
```

Retry one stage:

```bash
autovpn retry-stage --project-root "$PWD" --artifact-dir <artifact-dir> --stage <stage> --output human
```

Detached retry:

```bash
autovpn jobs retry --project-root "$PWD" --artifact-dir <artifact-dir> --stage <stage> --detach --json
```

Common retryable stages:

```text
speedtest
availability
postprocess
render
obfuscate
deploy
verify
```

## Error Diagnosis

Config/doctor:
Check missing dependencies, profile parse errors, missing `.env`, missing Cloudflare credentials, missing Mihomo, missing Node/npx, missing Playwright Chromium, missing Wrangler, or failed network reachability.

Extract:
Check source progress and extraction attempts. Multiple source failures usually indicate network/proxy problems; one source failure usually indicates source URL/key or upstream service issues.

Speedtest:
Check Mihomo, speed thresholds, timeout, concurrency, speed URLs, and `speedtest_results`. Retry from `speedtest` when inputs exist.

Availability:
Check enabled targets, speedtest output, and availability report counts. Retry from `availability`.

Render/obfuscate/package:
Check templates, Node/npx, JavaScript obfuscator, worker build settings, and generated worker files. Retry from `render` or `obfuscate`.

Deploy:
Check Cloudflare credentials, account ID, Wrangler, Pages project state, proxy settings, and deployment logs after redaction. Retry from `deploy`.

Verify:
Check Pages URL, custom domain, DNS propagation, subscription URL, verify URL, and secret query after redaction. Retry from `verify`.

## Reporting

Running:

```text
AutoVPN 当前状态：
- job: <job-id>
- artifact: <artifact-dir>
- run_status: running
- 当前阶段: <stage>
- counts: raw=<n>, deduped=<n>, speedtest=<n>, availability=<n>, final=<n>
- warning: <optional redacted warning>
```

Success:

```text
AutoVPN 运行完成：
- run_status: success
- artifact: <artifact-dir>
- final_links: <n>
- deploy: <status>
- verify: <status>
```

Failure:

```text
AutoVPN 运行失败：
- failed_stage: <stage>
- error_type: <redacted error type>
- 初步判断: <diagnosis>
- 建议恢复命令: autovpn retry-stage --artifact-dir <artifact-dir> --stage <stage>
- 已隐藏 token、secret query、完整订阅 URL、节点链接
```

## Rehearsal

Use this sequence to verify the skill and CLI surface:

```bash
autovpn doctor --project-root "$PWD" --output json
autovpn profile summary --project-root "$PWD" --json
autovpn run --project-root "$PWD" --skip-deploy --skip-verify --detach --json
autovpn status --project-root "$PWD" --json
autovpn logs --project-root "$PWD" --tail 50
autovpn artifacts latest --project-root "$PWD"
autovpn artifacts list --project-root "$PWD"
```
