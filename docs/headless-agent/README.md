# AutoVPN Headless and Agent SOP

This SOP describes how to evolve AutoVPN from a macOS Electron-first app into a supported Linux headless and Agent-callable tool. It is a planning and execution guide, not an implementation patch.

## Purpose

AutoVPN currently has a user-friendly Electron desktop client and an internal Python backend CLI. The next product goal is to support two additional users:

- Linux users on servers with no screen and terminal-only access.
- AI Agents that need deterministic commands, structured output, safe logging, stop/resume behavior, and clear recovery rules.

The target architecture is:

```text
AutoVPN Python Core
  |- Electron GUI       desktop users
  |- autovpn CLI        Linux/headless/SSH/scripts/Agents
  |- autovpn Agent Skill AI-safe operating procedure
  `- optional server mode future HTTP/API surface
```

Electron remains a desktop surface. The CLI and Agent skill must reuse the same Python backend logic instead of driving Electron or duplicating pipeline behavior.

## Source Documents

This SOP is backed by four stage-specific implementation analyses:

- [Headless CLI Implementation](headless-cli.md)
- [Job Manager Implementation](job-manager.md)
- [Agent Skill Implementation](agent-skill.md)
- [Linux Delivery and Verification](linux-delivery.md)

Use those documents when writing implementation plans or assigning work. Keep this file focused on sequencing, gates, and acceptance criteria.

## Non-Negotiable Principles

- Do not make Agents operate the Electron UI for production runs.
- Do not replace the existing `vpn-subscription-automation` launcher; add a new `autovpn` command.
- Do not fork pipeline logic into CLI or skill code. Reuse `src/vpn_automation/backend.py`, `PipelineController`, `RunStore`, profile store, and artifact readers.
- Do not print raw source keys, Cloudflare credentials, secret query strings, full subscription URLs, or full `vmess://` nodes.
- Do not treat `run.db` as the global job registry. `run.db` is artifact checkpoint state; detached jobs need their own process/job state.
- Do not make Linux headless mean Linux Electron packaging. The Linux deliverable is CLI/headless first.
- Do not implement server mode before the CLI and job manager contracts are stable.

## Stage 0: Baseline Audit and Decisions

### Goals

Confirm the current code contracts and freeze the first implementation boundary.

### Required Work

1. Audit current backend CLI in `src/vpn_automation/backend.py`.
2. Audit Electron IPC usage in `electron/ipc.js` and `electron/lib/backend.js`.
3. Audit profile/runtime path behavior in `src/vpn_automation/config`.
4. Audit artifact and retry behavior in `src/vpn_automation/backend_resume.py` and `src/vpn_automation/pipeline/run_store.py`.
5. Confirm the proxy runtime dependency. Current code uses `mihomo` through `src/vpn_automation/pipeline/proxy_runtime.py`; older README references to `xray` must be treated as documentation debt.
6. Confirm the first implementation is `autovpn` CLI plus docs, not HTTP server.

### Outputs

- A short issue or implementation plan that names the first PR scope.
- A dependency note recording `mihomo`, Node/npm/npx, Playwright Chromium, and Cloudflare Wrangler expectations.

### Exit Criteria

- No ambiguous first milestone.
- Electron remains unchanged unless a later stage explicitly requires it.
- The CLI command namespace is settled as `autovpn`.

## Stage 1: Headless CLI MVP

### Goals

Expose the existing Python backend as a stable user-facing CLI for terminal and Agent use.

### Required Work

Follow [Headless CLI Implementation](headless-cli.md).

The MVP must include:

```bash
autovpn profile show
autovpn profile save
autovpn run
autovpn artifacts latest
autovpn artifacts list
autovpn retry-stage
autovpn resume pipeline
autovpn resume speedtest
```

Every command must support `--project-root`. Streaming commands must support `--output jsonl|human`, `--event-log`, and `--human-log` when relevant.

### Recommended File Scope

- Create `src/vpn_automation/cli.py`.
- Modify `pyproject.toml` to add `autovpn = "vpn_automation.cli:main"`.
- Add CLI tests under `tests/backend/test_headless_cli.py`.
- Update README only after the command behavior is implemented and tested.

### Acceptance Criteria

- `autovpn profile show --project-root <repo>` returns the same JSON profile contract as `python -m vpn_automation.backend profile`.
- `autovpn run --skip-deploy --skip-verify --output jsonl` emits JSONL events and returns backend exit codes unchanged.
- `autovpn artifacts latest/list` preserve existing backend JSON fields.
- `autovpn retry-stage` and `autovpn resume ...` are thin wrappers over existing backend functions.
- Electron tests still pass without IPC changes.

### Verification

```bash
rtk ./scripts/run_pytest.sh tests -v
rtk npm run test:electron
rtk npm run test:all
```

If no UI files changed, visual tests are still a regression layer, not a redesign review.

## Stage 2: Doctor and Linux Headless Readiness

### Goals

Make Linux terminal installation and dependency validation explicit.

### Required Work

Follow [Linux Delivery and Verification](linux-delivery.md).

The `doctor` command must check:

- Python version and Python package imports.
- Runtime profile path and write permissions.
- Artifact path and write permissions.
- Source configuration presence without printing keys.
- `mihomo` availability.
- Node/npm/npx availability.
- Worker build and obfuscation tooling.
- Playwright Chromium/headless shell readiness.
- Lightweight network checks.
- Cloudflare credentials only as deploy-required checks.

### Command Contract

```bash
autovpn doctor --output human
autovpn doctor --output json
autovpn doctor --deploy --strict --output json
```

`doctor` should use `pass`, `warn`, and `fail`. It must not run a full pipeline, full speed test, or Cloudflare deploy.

### Documentation Outputs

- Linux install guide: [AutoVPN Linux Headless Guide](linux-headless-guide.md).
- Dependency matrix.
- Troubleshooting section.
- Security/redaction rules.

### Acceptance Criteria

- A fresh Linux server user can follow the guide without needing Electron.
- Missing Cloudflare credentials are a warning by default and a failure only in deploy/strict mode.
- No doctor output leaks source keys, Cloudflare tokens, proxy passwords, or secret URLs.
- README no longer misleads Linux users toward `xray` when the current runtime is `mihomo`.

## Stage 3: Detached Runs and Job Manager

### Goals

Support long-running pipeline execution after SSH disconnects or Agent handoffs.

### Required Work

Follow [Job Manager Implementation](job-manager.md).

Add persistent job state separate from artifact `run.db`:

```text
$HOME/.auto-vpn/jobs/
  index.json
  <job_id>/
    job.json
    events.jsonl
    human.log
    stdout.log
    stderr.log
```

### Command Contract

```bash
autovpn run --detach --json
autovpn jobs list --json
autovpn jobs status <job-id> --json
autovpn jobs logs <job-id> --format human --tail 200
autovpn jobs logs <job-id> --format jsonl --follow
autovpn jobs stop <job-id>
autovpn status --json
autovpn logs --follow
autovpn stop
```

### Process Rules

- Detached jobs must start in a new process group/session.
- Stop must send SIGTERM first, then SIGKILL after a timeout.
- Stop must target the process group, not only the direct child PID.
- Status must reconcile stale `running` jobs by checking PID, event logs, `pipeline_report.json`, and `run.db`.

### Acceptance Criteria

- `autovpn run --detach --json` returns a `job_id`, PID, event log path, and human log path.
- `jobs status` works after the original terminal session exits.
- `jobs logs --follow` reads log files, not live process pipes.
- `jobs stop` cleans up child process trees on Linux/macOS.
- Resume and retry can create new jobs while preserving source artifact/session context.

## Stage 4: Artifact Preview and Machine-Friendly Summaries

### Goals

Give CLI and Agents the information Electron currently shows in UI result pages, without depending on Electron JS preview helpers.

### Required Work

1. Port or reimplement artifact preview logic from `electron/lib/artifact-preview.js` into Python.
2. Add:

```bash
autovpn artifacts preview <artifact-dir> --json
```

3. Include:
   - `pipeline_report.json` summary.
   - stage status.
   - counts and source counts.
   - deployment summary.
   - retry context.
   - safe file inventory.
   - safe node/link counts, not full node contents.

### Acceptance Criteria

- Agent can answer “what happened in the latest run?” without reading raw node files.
- Preview output is redacted by default.
- Retryable stages are visible in a stable JSON shape.

## Stage 5: Agent Skill

### Goals

Create a project-specific skill that teaches Agents how to operate AutoVPN safely through `autovpn`.

### Required Work

Follow [Agent Skill Implementation](agent-skill.md).

Recommended project-local skill path:

```text
.codex/skills/autovpn-agent/SKILL.md
```

The initial project-local skill is checked in at [.codex/skills/autovpn-agent/SKILL.md](../../.codex/skills/autovpn-agent/SKILL.md).

```text
.codex/skills/autovpn-agent/SKILL.md
```

The skill must define:

- Trigger conditions.
- Allowed commands.
- Forbidden actions.
- Sensitive data handling.
- Preflight flow.
- Profile read/write rules.
- Run, observe, stop, resume, retry flows.
- Error diagnosis by stage.
- Reporting templates.
- Rehearsal/testing steps.

### Acceptance Criteria

- A fresh Agent can run a safe dry-run using only the skill and CLI docs.
- A fresh Agent can start a detached run, monitor it, stop it, and resume or retry it.
- Agent reports include status, stages, counts, artifact paths, and recommendations.
- Agent reports do not include raw secrets, full `vmess://` links, or full tokenized subscription URLs.

## Stage 6: CI, Review, PR, and Delivery

### Goals

Make headless support a tested deliverable, not a local-only workflow.

### Required Work

Follow [Linux Delivery and Verification](linux-delivery.md).

Add or update CI to cover:

- Python package install.
- Node install.
- Playwright Chromium/headless shell install.
- Python tests.
- Electron/node tests.
- `autovpn doctor --output json` in non-deploy mode.
- CLI smoke tests.

### Project Workflow Requirements

Per `AGENTS.md`, any file-changing task must:

1. Run relevant unit tests.
2. Run e2e tests.
3. Run pixel/visual regression tests when UI/behavior changes require it.
4. Open a GitHub PR.
5. Run local code review, preferably with `superpowers:requesting-code-review`.
6. Apply review feedback and rerun required tests.
7. Merge only after tests and review are resolved.
8. Package a runnable/installable deliverable after merge.

For CLI/headless, the package can be a Python installable artifact, source install flow, Docker image, or systemd deployment bundle. Electron DMG packaging remains required only when the Electron app is part of the deliverable.

### Acceptance Criteria

- Linux headless path is documented and CI-tested.
- Electron desktop behavior remains intact.
- Release notes clearly separate macOS desktop and Linux headless installation paths.
- Packaging notes list external runtime dependencies that Python packaging does not install automatically.

## Stage 7: Optional Server Mode

### Trigger Conditions

Do this only after CLI, job manager, and Agent skill are stable, and only if one or more of these needs appear:

- Remote browser dashboard.
- Multi-user operation.
- Webhook-triggered runs.
- Queueing and scheduling.
- Centralized secret storage.
- Electron should talk to the same local API as headless clients.

### Possible API Shape

```text
GET  /doctor
GET  /profile
PUT  /profile
POST /runs
GET  /runs
GET  /runs/:id
GET  /runs/:id/events
POST /runs/:id/stop
GET  /artifacts
GET  /artifacts/latest
POST /artifacts/:id/retry
```

### Rule

Server mode must be a wrapper over the CLI/core service layer, not a second implementation of pipeline behavior.

## Milestone Breakdown

### PR 1: CLI MVP

- `autovpn` entrypoint.
- Profile, run, artifacts, resume, retry wrappers.
- CLI tests.
- Basic README update.

### PR 2: Doctor and Linux Docs

- `autovpn doctor`.
- Linux headless documentation.
- Dependency and redaction tests.
- Fix `xray`/`mihomo` documentation mismatch.

### PR 3: Job Manager

- Detached jobs.
- Persistent job store.
- Status/logs/stop.
- Reconcile logic.
- Stop/process-group tests.

### PR 4: Artifact Preview and Agent Skill

- Python artifact preview.
- Redacted summaries.
- Project-local `autovpn-agent` skill.
- Agent rehearsal documentation.

### PR 5: CI and Delivery

- Linux headless CI.
- Release docs.
- Packaging/installable artifact updates.
- End-to-end verification.

## Definition of Done

The headless and Agent track is complete when:

- A Linux user can install AutoVPN without Electron and run `autovpn doctor`.
- The user can generate local artifacts from terminal only.
- The user can deploy and verify from terminal when Cloudflare credentials are configured.
- A detached run survives SSH disconnect.
- An Agent can run, monitor, stop, resume, retry, and summarize AutoVPN through the skill.
- Secrets and node payloads are redacted by default.
- CI covers CLI/headless behavior.
- Electron desktop tests still pass.
