# AutoVPN Server Web UI Design

## Goal

Add a server-hosted AutoVPN surface for users who run AutoVPN on a VPS or headless Linux host. The npm CLI remains the entrypoint, and `autovpn serve` starts an HTTP service that renders the existing Electron renderer as a browser-based Web UI.

## User Outcome

A user can install the npm CLI on a server, run a background-capable HTTP service, open the Web UI in a browser, and operate the same core workflows currently exposed through Electron:

- load and inspect the active profile
- start an AutoVPN run
- stop a running job
- monitor live logs and stage events
- inspect latest run artifacts and summary data
- access the same dashboard/results/settings presentation as the Electron renderer where practical

## Constraints

- Do not fork pipeline behavior. The server must reuse the existing npm CLI backend, native job manager, profile store, artifact readers, and pipeline adapters.
- Do not require Electron on servers. The Web UI must run as plain browser H5 assets.
- Do not expose a remote management API without authentication. Binding to non-loopback hosts requires a token unless the user explicitly passes `--no-auth`.
- Do not leak source keys, Cloudflare tokens, full secret URLs, or full nodes through logs or API responses.
- Keep the first server release single-user. Multi-account auth, role management, and hosted multi-tenant operation are out of scope for v1.5.0.

## Approach

### Recommended Architecture

Add `autovpn serve` to `npm/autovpn-cli`. The command starts a Node HTTP server using built-in `node:http`, so no new framework dependency is needed. The server exposes JSON API routes, an SSE event route, and static assets for the browser UI.

The existing Electron renderer remains the primary UI implementation. A new browser adapter provides `window.vpnAutomation` when the renderer is served over HTTP. Electron continues using preload/IPC; Web uses fetch/SSE. The renderer application code should consume the same shape of API from both adapters.

### Alternatives Considered

1. **Reuse renderer with Web adapter.** This is the chosen design. It minimizes UI duplication and keeps Electron and Web behavior aligned.
2. **Build a separate React/Vite Web app.** This would give a cleaner modern frontend stack, but it duplicates current renderer behavior and adds release risk.
3. **Expose API only.** This is useful for automation, but it does not satisfy the requirement to operate AutoVPN through a frontend.

## CLI Contract

```bash
autovpn serve
autovpn serve --host 127.0.0.1 --port 8765
autovpn serve --host 0.0.0.0 --port 8765 --token <secret>
autovpn serve --host 0.0.0.0 --port 8765 --no-auth
```

Defaults:

- host: `127.0.0.1`
- port: `8765`
- auth: generated process-local token for loopback, required explicit token for non-loopback
- project root: existing global `--project-root` behavior

Startup validation:

- `--host 0.0.0.0` or another non-loopback host without `--token` or `--no-auth` fails with a clear usage error.
- `--no-auth` is accepted only when explicitly provided and should print a warning.
- The server prints the listening URL and, when token auth is enabled, the token-login URL.

## HTTP API

All API routes return JSON unless noted. Authenticated requests use one of:

- `Authorization: Bearer <token>`
- `?token=<token>` for first page load and SSE convenience

Routes:

- `GET /api/health`
  - Returns service status, version, backend kind, and project root.
- `GET /api/state`
  - Returns redacted profile, run state, latest known artifacts, available retry artifacts, and deployment summary when present.
- `POST /api/runs`
  - Starts a run through the existing backend/job path. Body supports `skipDeploy`, `skipVerify`, and `resumeLatest`.
- `POST /api/runs/current/stop`
  - Stops the active run/job when one is running.
- `GET /api/events`
  - Server-Sent Events stream of pipeline/job events and log entries.

Static routes:

- `GET /`
  - Serves Web UI HTML.
- `GET /web-adapter.js`
  - Provides the browser `window.vpnAutomation` adapter.
- Existing renderer JS/CSS/assets are served from the current renderer directory.

## Runtime Behavior

The server keeps a small in-memory runtime state for the current process:

- latest loaded profile
- active run/job id and status
- recent event buffer for newly connected SSE clients
- latest artifact summary read through existing artifact preview helpers

Long-running execution must still be delegated to the existing backend/job abstractions. The server is an orchestration and presentation layer, not a second pipeline implementation.

## Frontend Behavior

When loaded through Electron, the renderer continues using the preload-provided `window.vpnAutomation`.

When loaded through Web, `web-adapter.js` installs `window.vpnAutomation` before `app.js` starts. The adapter implements the existing methods the renderer expects:

- `loadProfile()`
- `runPipeline(options)`
- `stopPipeline()`
- `onPipelineEvent(handler)`
- artifact and retry helper methods already used by the renderer, backed by `/api/state` where possible

The first Web iteration should prioritize operational parity for dashboard, runs, logs, and results. Settings editing can remain read-only unless the existing renderer method can be safely mapped to current profile-save APIs without broad UI rewrites.

## Security and Redaction

- Non-loopback serving requires `--token` or explicit `--no-auth`.
- API responses must be redacted using existing redaction utilities before leaving the process.
- SSE events must be redacted before broadcast.
- Static renderer assets are public after the user can reach the server, but API routes require auth when enabled.
- The token should not be written to persistent project files.

## Test Strategy

Use TDD for implementation. Required coverage:

- CLI command validation for `serve`, including host/token safety.
- HTTP API tests for health, auth rejection, state loading, run start, stop, and SSE event delivery.
- Renderer H5 tests that load the served Web UI in Playwright and verify the app leaves demo mode, calls Web API operations, and renders dashboard/run controls.
- Visual/pixel regression for the served Web UI.
- Existing npm CLI tests, Electron renderer tests, Python tests, and package build checks remain release gates.

## Release Criteria

v1.5.0 is releasable when:

- `autovpn serve` is documented and shipped in the npm package.
- The Web UI can operate against the server API in a plain browser.
- Remote binding is protected by default.
- Full regression tests pass, including H5/browser and visual checks.
- `superpowers:requesting-code-review` has been run and review feedback is resolved.
- Changes are pushed to the remote repository and the v1.5.0 release/tag/package flow is completed.

## Scope Boundaries

Out of scope for v1.5.0:

- multi-user accounts
- database-backed sessions
- HTTPS certificate automation
- public SaaS hosting
- replacing the Electron app
- rewriting the UI framework

