# Agent Skill Implementation Plan

## Goal

Create a project-specific AutoVPN Agent skill that teaches an Agent how to configure, run, monitor, stop, resume, retry, diagnose, and report AutoVPN safely through the `autovpn` CLI.

The skill should not implement business logic. It should define operational rules and command sequences.

## Recommended Location

Project-local:

```text
.codex/skills/autovpn-agent/SKILL.md
```

Optional personal install:

```text
/Users/swimmingliu/.codex/skills/autovpn-agent/SKILL.md
```

Project-local is preferred because the skill depends on this repository's profile fields, artifact layout, scripts, and CLI conventions.

## Trigger Conditions

Use the skill when the user asks to:

- Run AutoVPN.
- Configure AutoVPN profile.
- Check AutoVPN status.
- Start, stop, resume, or retry an AutoVPN task.
- Deploy or verify Cloudflare Pages output.
- Inspect AutoVPN artifacts, logs, `pipeline_report.json`, or `run.db`.
- Diagnose extraction, speedtest, availability, deploy, or verify failures.
- Let an Agent operate the subscription generation flow.

Do not use this skill for ordinary code development, Electron UI changes, or pipeline refactoring unless the user is specifically operating AutoVPN.

## Skill Structure

The skill should include:

```markdown
---
name: autovpn-agent
description: Use when configuring, running, monitoring, stopping, resuming, retrying, or diagnosing AutoVPN through the autovpn CLI.
---

# AutoVPN Agent SOP

## Scope
## Sensitive Data Rules
## Preflight
## Profile Read/Write
## Run
## Observe
## Stop
## Resume
## Retry
## Error Diagnosis
## Reporting
## Rehearsal and Tests
```

## Allowed Commands

Preferred future commands:

```bash
autovpn doctor --output json
autovpn profile summary --json
autovpn profile show
autovpn profile save
autovpn run --skip-deploy --skip-verify
autovpn run --detach --json
autovpn jobs status <job-id> --json
autovpn jobs logs <job-id> --tail 200
autovpn jobs stop <job-id>
autovpn resume pipeline --session <session-dir>
autovpn resume speedtest --session <session-dir>
autovpn retry-stage --artifact-dir <artifact-dir> --stage <stage>
autovpn artifacts latest
autovpn artifacts list
autovpn artifacts preview <artifact-dir> --json
```

Fallback commands until `autovpn` is fully implemented:

```bash
PYTHONPATH=src python -m vpn_automation.backend profile --project-root "$PWD"
PYTHONPATH=src python -m vpn_automation.backend artifact-latest --project-root "$PWD"
PYTHONPATH=src python -m vpn_automation.backend artifact-list --project-root "$PWD"
PYTHONPATH=src python -m vpn_automation.backend run --project-root "$PWD" --output jsonl
PYTHONPATH=src python -m vpn_automation.backend run --project-root "$PWD" --resume-latest --output human
PYTHONPATH=src python -m vpn_automation.backend resume-pipeline --project-root "$PWD" --session <session-dir> --output human
PYTHONPATH=src python -m vpn_automation.backend resume-speedtest --project-root "$PWD" --session <session-dir> --output human
PYTHONPATH=src python -m vpn_automation.backend retry-stage --project-root "$PWD" --artifact-dir <artifact-dir> --stage <stage> --output human
./scripts/run_backend_pipeline.sh --dry-run
./scripts/monitor_run.sh --once "$PWD"
```

## Forbidden Actions

The skill must forbid:

- Printing `.env` contents.
- Printing raw `sources.*.key`.
- Printing raw Cloudflare token or global key.
- Printing raw `deploy.secret_query`.
- Printing full `subscription_url` or `verify_subscription_url` when tokenized.
- Printing full `vmess://` links.
- Pasting raw node files from artifacts into chat.
- Killing only a direct child PID when a process group stop is available.
- Blindly rerunning full pipeline before inspecting latest artifact and stage status.

## Sensitive Data Rules

Treat these as sensitive:

- `sources.*.key`
- source URLs with query tokens
- `deploy.secret_query`
- `deploy.cloudflare_api_token`
- `deploy.cloudflare_global_key`
- `deploy.cloudflare_email`
- `deploy.subscription_url`
- `deploy.verify_subscription_url`
- `deploy.pages_secret_admin`
- `deploy.account_id`
- `.env` Cloudflare and proxy values
- `vpn_node_raw.txt`
- `vpn_node_deduped.txt`
- `vpn_node_speedtest.txt`
- `vpn_node_availability.txt`
- `vpn_node_emoji.txt`
- `vmess_node.js`
- `worker_transformed.js`
- `_worker.js`
- `pages_bundle/_worker.js`
- deployment stdout/stderr that may include URLs or environment names

Allowed reporting style:

```text
sources.leiting.key=set
deploy.cloudflare_api_token=missing
.env.CLOUDFLARE_API_TOKEN=set
deploy.project_name=sub-nodes
stage.deploy=success
final_links=123
verify_subscription_url=https://example.com/sub?token=<redacted>
```

## Agent Operating Flow

### 1. Preflight

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
autovpn doctor --output json
```

Fallback:

```bash
PYTHONPATH=src python -m vpn_automation.backend profile --project-root "$PWD"
test -f .env && echo ".env=present" || echo ".env=missing"
command -v mihomo || true
command -v npx || true
python -c "import requests, tomlkit, dotenv, cryptography"
```

Report only pass/warn/fail and set/missing values. Do not paste raw `profile show` output.

### 2. Profile

Safe summary:

```bash
autovpn profile summary --project-root "$PWD" --json
```

Raw read only when the user explicitly asks to inspect or edit configuration:

```bash
autovpn profile show --project-root "$PWD"
```

Fallback:

```bash
PYTHONPATH=src python -m vpn_automation.backend profile --project-root "$PWD"
```

Write only after the user explicitly asks:

```bash
cat profile.json | autovpn profile save --project-root "$PWD"
```

Fallback:

```bash
cat profile.json | PYTHONPATH=src python -m vpn_automation.backend profile-save --project-root "$PWD"
```

### 3. Run

Dry-run:

```bash
./scripts/run_backend_pipeline.sh --dry-run
```

Local artifact generation:

```bash
autovpn run --skip-deploy --skip-verify --output jsonl
```

Detached Agent-safe run:

```bash
autovpn run --detach --json
```

Full deploy and verify:

```bash
autovpn run --output jsonl
```

Only use full deploy/verify when Cloudflare credentials are configured and the user has asked for deployment.

### 4. Observe

Preferred:

```bash
autovpn jobs status <job-id> --json
autovpn jobs logs <job-id> --tail 200
autovpn artifacts latest
autovpn artifacts preview <artifact-dir> --json
```

Fallback:

```bash
./scripts/monitor_run.sh --once "$PWD"
PYTHONPATH=src python -m vpn_automation.backend artifact-latest --project-root "$PWD"
PYTHONPATH=src python -m vpn_automation.backend artifact-list --project-root "$PWD"
```

### 5. Stop

Preferred:

```bash
autovpn jobs stop <job-id>
```

Fallback until job manager exists:

- Use the PID/session recorded at run start.
- Send SIGTERM to the process group.
- Wait 4 seconds.
- Send SIGKILL if still running.
- Recheck latest artifact and `run.db`.

The skill must say that stopping only the direct PID can leave `mihomo`, Playwright, Wrangler, or other child processes behind.

### 6. Resume

Latest incomplete:

```bash
autovpn run --resume-latest --output human
```

Session:

```bash
autovpn resume pipeline --session <session-dir> --output human
autovpn resume speedtest --session <session-dir> --output human
```

Fallback:

```bash
PYTHONPATH=src python -m vpn_automation.backend run --project-root "$PWD" --resume-latest --output human
PYTHONPATH=src python -m vpn_automation.backend resume-pipeline --project-root "$PWD" --session <session-dir> --output human
PYTHONPATH=src python -m vpn_automation.backend resume-speedtest --project-root "$PWD" --session <session-dir> --output human
```

### 7. Retry

First inspect retryable stages:

```bash
autovpn artifacts list
```

Then retry:

```bash
autovpn retry-stage --artifact-dir <artifact-dir> --stage <stage> --output human
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

## Error Diagnosis by Stage

### Config/Doctor

Check missing runtime dependencies, profile parse errors, missing `.env`, missing Cloudflare credentials, missing `mihomo`, missing Node/npx, or missing Playwright Chromium. Do not print secret values.

### Extract

Inspect source progress and extraction attempts. Multiple source failures usually indicate network/proxy problems; one source failure usually indicates that source URL/key or upstream service.

### Speedtest

Check `mihomo`, speed thresholds, timeout, concurrency, speed test URLs, and `speedtest_results`. Retry from `speedtest` when inputs exist.

### Availability

Check enabled targets, `vpn_node_speedtest.txt`, `vpn_node_availability_report.json`, and availability results. Retry from `availability`.

### Postprocess

Check availability output, filters, per-country limits, and final link counts. Retry from `postprocess`.

### Render/Obfuscate/Package

Check template files, Node/npx, JavaScript obfuscator, worker build settings, and generated worker files. Retry from `render` or `obfuscate`.

### Deploy

Check Cloudflare credentials, account ID, Wrangler, Pages project state, proxy settings, blocked Pages fallback fields, and deployment stdout/stderr after redaction. Retry from `deploy`.

### Verify

Check Pages URL, custom domain, DNS propagation, subscription URL, verify URL, and secret query after redaction. Retry from `verify`.

## Reporting Templates

Running:

```text
AutoVPN 当前状态：
- job: <job-id>
- session: <session-id>
- artifact: <artifact-dir>
- run_status: running
- 当前阶段: speedtest
- 进度: raw=1200, deduped=860, speedtest=42, availability=18, final=0
- warning: <optional redacted warning>
```

Success:

```text
AutoVPN 运行完成：
- run_status: success
- artifact: <artifact-dir>
- final_links: 128
- deploy: success
- verify: success
- worker: pages_bundle/_worker.js
```

Failure:

```text
AutoVPN 运行失败：
- failed_stage: deploy
- error_type: Cloudflare deployment failed
- 初步判断: Wrangler 网络错误或凭据/项目配置问题
- 建议恢复命令: autovpn retry-stage --artifact-dir <artifact-dir> --stage deploy
- 已隐藏 token、secret query、完整订阅 URL、节点链接
```

## Rehearsal

The skill should include rehearsal steps:

```bash
autovpn doctor --output json
autovpn profile summary --json
./scripts/run_backend_pipeline.sh --dry-run
autovpn run --skip-deploy --skip-verify --output jsonl
autovpn artifacts latest
autovpn artifacts list
```

Fallback rehearsal can use existing backend commands until `autovpn` is implemented.

## Acceptance Criteria

- A fresh Agent can determine readiness without revealing secrets.
- A fresh Agent can start a local non-deploy run and summarize output.
- A fresh Agent can start a detached run after job manager is implemented.
- A fresh Agent can stop, resume, and retry without manually operating Electron.
- Reports are useful but redacted.
