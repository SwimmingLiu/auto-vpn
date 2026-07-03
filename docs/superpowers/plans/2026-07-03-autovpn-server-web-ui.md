# AutoVPN Server Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `autovpn serve`, a token-protected HTTP service that renders the existing Electron renderer as a browser Web UI.

**Architecture:** The npm CLI owns server mode. A small Node HTTP server exposes JSON APIs, SSE events, and static renderer assets. The browser UI reuses `electron/renderer` through a Web adapter that installs `window.vpnAutomation`, while Electron keeps using preload/IPC.

**Tech Stack:** Node.js 22+, TypeScript, `node:http`, `node:test`, Playwright, existing AutoVPN npm CLI modules, existing Electron renderer assets.

---

## File Structure

- Create `npm/autovpn-cli/src/server/options.ts`: parse and validate `serve` flags.
- Create `npm/autovpn-cli/src/server/http.ts`: HTTP routing, auth, JSON helpers, static asset serving, SSE.
- Create `npm/autovpn-cli/src/server/runtime.ts`: in-memory service state and backend orchestration facade.
- Create `npm/autovpn-cli/src/server/web-adapter.ts`: generated JavaScript served to browsers.
- Create `npm/autovpn-cli/test/server/options.test.mjs`: CLI/server option validation tests.
- Create `npm/autovpn-cli/test/server/http.test.mjs`: HTTP API, auth, static asset, and SSE tests.
- Create `electron/tests/web-server-e2e.test.mjs`: Playwright H5 test against served Web UI.
- Create `electron/tests/web-server-visual.test.mjs`: pixel hash check for served Web UI.
- Modify `npm/autovpn-cli/src/cli/commands/index.ts`: accept `serve`.
- Modify `npm/autovpn-cli/src/cli/output.ts`: document `serve`.
- Modify `npm/autovpn-cli/src/cli/main.ts`: dispatch `serve`.
- Modify `npm/autovpn-cli/package.json`: include server tests in npm test.
- Modify `npm/autovpn-cli/README.md` and root `README.md`: document server mode.
- Modify `package.json`, `npm/autovpn-cli/package.json`, and `pyproject.toml`: bump to `1.5.0` during release task.

## Task 1: Server Option Validation

**Files:**
- Create: `npm/autovpn-cli/src/server/options.ts`
- Create: `npm/autovpn-cli/test/server/options.test.mjs`
- Modify: `npm/autovpn-cli/src/cli/commands/index.ts`
- Modify: `npm/autovpn-cli/src/cli/output.ts`

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseServeOptions } from '../../dist/server/options.js';

test('serve defaults to loopback with token auth enabled', () => {
  const options = parseServeOptions(['serve'], { cwd: '/repo', env: {}, randomToken: () => 'generated-token' });
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 8765);
  assert.equal(options.projectRoot, '/repo');
  assert.equal(options.auth.enabled, true);
  assert.equal(options.auth.token, 'generated-token');
});

test('serve rejects non-loopback hosts without explicit auth decision', () => {
  assert.throws(
    () => parseServeOptions(['serve', '--host', '0.0.0.0'], { cwd: '/repo', env: {}, randomToken: () => 'generated-token' }),
    /serve requires --token or --no-auth when binding to non-loopback host/
  );
});

test('serve accepts non-loopback host with token', () => {
  const options = parseServeOptions(['serve', '--host', '0.0.0.0', '--token', 'secret'], {
    cwd: '/repo',
    env: {},
    randomToken: () => 'unused'
  });
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.auth.enabled, true);
  assert.equal(options.auth.token, 'secret');
});

test('serve accepts explicit no-auth and marks auth disabled', () => {
  const options = parseServeOptions(['serve', '--host', '0.0.0.0', '--no-auth'], {
    cwd: '/repo',
    env: {},
    randomToken: () => 'unused'
  });
  assert.equal(options.auth.enabled, false);
  assert.equal(options.auth.token, '');
});
```

- [ ] **Step 2: Verify RED**

Run: `cd npm/autovpn-cli && npm run build && node --test test/server/options.test.mjs`

Expected: FAIL with `Cannot find module .../dist/server/options.js`.

- [ ] **Step 3: Implement minimal option parser**

Create `options.ts` with:

```ts
import crypto from 'node:crypto';
import path from 'node:path';

import { CliUsageError } from '../cli/errors.js';
import { readOptionValue, resolveProjectRoot } from '../runtime/paths.js';

export interface ServeOptions {
  host: string;
  port: number;
  projectRoot: string;
  auth: { enabled: boolean; token: string };
}

export interface ParseServeOptionsContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  randomToken?: () => string;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function defaultRandomToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export function parseServeOptions(argv: string[], context: ParseServeOptionsContext): ServeOptions {
  const host = readOptionValue(argv, '--host') ?? context.env.AUTOVPN_SERVER_HOST ?? '127.0.0.1';
  const portText = readOptionValue(argv, '--port') ?? context.env.AUTOVPN_SERVER_PORT ?? '8765';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliUsageError('serve --port must be an integer from 1 to 65535');
  }
  const token = readOptionValue(argv, '--token') ?? context.env.AUTOVPN_SERVER_TOKEN ?? '';
  const noAuth = hasFlag(argv, '--no-auth');
  if (!isLoopbackHost(host) && !token && !noAuth) {
    throw new CliUsageError('serve requires --token or --no-auth when binding to non-loopback host');
  }
  return {
    host,
    port,
    projectRoot: path.resolve(resolveProjectRoot(argv, context.cwd)),
    auth: noAuth ? { enabled: false, token: '' } : { enabled: true, token: token || (context.randomToken ?? defaultRandomToken)() }
  };
}
```

- [ ] **Step 4: Register command and help**

Add `serve` to `TOP_LEVEL_COMMANDS`, return early for `command === 'serve'`, and add `serve` to `renderHelp()`.

- [ ] **Step 5: Verify GREEN**

Run: `cd npm/autovpn-cli && npm run build && node --test test/server/options.test.mjs test/cli-shell.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add npm/autovpn-cli/src/server/options.ts npm/autovpn-cli/test/server/options.test.mjs npm/autovpn-cli/src/cli/commands/index.ts npm/autovpn-cli/src/cli/output.ts
git commit -m "feat: validate server mode options"
```

## Task 2: HTTP Service Core

**Files:**
- Create: `npm/autovpn-cli/src/server/runtime.ts`
- Create: `npm/autovpn-cli/src/server/http.ts`
- Create: `npm/autovpn-cli/test/server/http.test.mjs`

- [ ] **Step 1: Write failing HTTP tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAutoVpnServer } from '../../dist/server/http.js';

test('health requires bearer token when auth is enabled', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: true, token: 'secret' },
    runtime: { loadState: async () => ({ profile: { sources: {} }, runState: 'idle' }) }
  });
  try {
    const denied = await fetch(`${service.origin}/api/health`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${service.origin}/api/health`, { headers: { Authorization: 'Bearer secret' } });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).status, 'ok');
  } finally {
    await service.close();
  }
});

test('state response is redacted before leaving API', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({
        profile: { sources: { demo: { url: 'https://example.test/sub?token=secret-token', key: 'source-key' } } },
        runState: 'idle'
      })
    }
  });
  try {
    const response = await fetch(`${service.origin}/api/state`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /secret-token|source-key/);
    assert.match(text, /REDACTED/);
  } finally {
    await service.close();
  }
});
```

- [ ] **Step 2: Verify RED**

Run: `cd npm/autovpn-cli && npm run build && node --test test/server/http.test.mjs`

Expected: FAIL with missing `dist/server/http.js`.

- [ ] **Step 3: Implement runtime facade and HTTP server**

`runtime.ts` exports `ServerRuntime` and `createServerRuntime()`. `http.ts` exports `createAutoVpnServer(options)`. Implement `GET /api/health`, `GET /api/state`, auth checking, JSON responses, and redaction using `redactText`.

- [ ] **Step 4: Verify GREEN**

Run: `cd npm/autovpn-cli && npm run build && node --test test/server/http.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add npm/autovpn-cli/src/server/runtime.ts npm/autovpn-cli/src/server/http.ts npm/autovpn-cli/test/server/http.test.mjs
git commit -m "feat: add autovpn web server api"
```

## Task 3: Serve Command Dispatch

**Files:**
- Modify: `npm/autovpn-cli/src/cli/main.ts`
- Modify: `npm/autovpn-cli/test/cli-shell.test.mjs`

- [ ] **Step 1: Write failing CLI dispatch test**

Add a test asserting `runCliShell(['serve', '--host', '127.0.0.1', '--port', '0'])` starts through an injectable `createServer` option and prints a listening URL.

- [ ] **Step 2: Verify RED**

Run: `cd npm/autovpn-cli && npm run build && node --test test/cli-shell.test.mjs`

Expected: FAIL because `runCliShell` has no server injection and forwards to backend.

- [ ] **Step 3: Implement dispatch**

Add `createServer?: typeof createAutoVpnServer` to `CliShellOptions`. When normalized argv starts with `serve`, parse options, create the server, write `AutoVPN server listening on <origin>` to stdout, and keep the process alive only in real CLI mode. In tests, the injected server closes immediately.

- [ ] **Step 4: Verify GREEN**

Run: `cd npm/autovpn-cli && npm run build && node --test test/cli-shell.test.mjs test/server/options.test.mjs test/server/http.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add npm/autovpn-cli/src/cli/main.ts npm/autovpn-cli/test/cli-shell.test.mjs
git commit -m "feat: wire serve command into cli"
```

## Task 4: Run, Stop, and SSE Operations

**Files:**
- Modify: `npm/autovpn-cli/src/server/runtime.ts`
- Modify: `npm/autovpn-cli/src/server/http.ts`
- Modify: `npm/autovpn-cli/test/server/http.test.mjs`

- [ ] **Step 1: Write failing operation tests**

Add tests for `POST /api/runs`, `POST /api/runs/current/stop`, and `GET /api/events` receiving a redacted event.

- [ ] **Step 2: Verify RED**

Run: `cd npm/autovpn-cli && npm run build && node --test test/server/http.test.mjs`

Expected: FAIL with 404 or missing event delivery.

- [ ] **Step 3: Implement operation routes**

Runtime methods:

```ts
startRun(options: { skipDeploy?: boolean; skipVerify?: boolean; resumeLatest?: boolean }): Promise<{ ok: true; runId: string }>;
stopRun(): Promise<{ ok: true; requested: boolean }>;
subscribe(handler: (event: unknown) => void): () => void;
```

Route behavior:

- `POST /api/runs` calls `runtime.startRun()`.
- `POST /api/runs/current/stop` calls `runtime.stopRun()`.
- `GET /api/events` keeps an SSE response open and writes `data: <json>\n\n`.

- [ ] **Step 4: Verify GREEN**

Run: `cd npm/autovpn-cli && npm run build && node --test test/server/http.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add npm/autovpn-cli/src/server/runtime.ts npm/autovpn-cli/src/server/http.ts npm/autovpn-cli/test/server/http.test.mjs
git commit -m "feat: stream server run events"
```

## Task 5: Web Adapter and Static Renderer Serving

**Files:**
- Create: `npm/autovpn-cli/src/server/web-adapter.ts`
- Modify: `npm/autovpn-cli/src/server/http.ts`
- Modify: `npm/autovpn-cli/test/server/http.test.mjs`

- [ ] **Step 1: Write failing static asset tests**

Assert `GET /` contains `web-adapter.js` before `app.js`, and `GET /web-adapter.js` contains `window.vpnAutomation`.

- [ ] **Step 2: Verify RED**

Run: `cd npm/autovpn-cli && npm run build && node --test test/server/http.test.mjs`

Expected: FAIL with missing static route or adapter.

- [ ] **Step 3: Implement Web adapter**

Serve `electron/renderer/index.html` with `<script src="/web-adapter.js"></script>` inserted before `app.js`. Adapter methods use `fetch('/api/state')`, `fetch('/api/runs')`, `fetch('/api/runs/current/stop')`, and `EventSource('/api/events')`.

- [ ] **Step 4: Verify GREEN**

Run: `cd npm/autovpn-cli && npm run build && node --test test/server/http.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add npm/autovpn-cli/src/server/web-adapter.ts npm/autovpn-cli/src/server/http.ts npm/autovpn-cli/test/server/http.test.mjs
git commit -m "feat: serve renderer web adapter"
```

## Task 6: Browser H5 and Visual Verification

**Files:**
- Create: `electron/tests/web-server-e2e.test.mjs`
- Create: `electron/tests/web-server-visual.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing Playwright test**

Start the compiled server with a fake runtime, open `/`, wait for `#dashboardOverview`, click Runs, click start, assert `POST /api/runs` was called and the UI shows running state after an SSE event.

- [ ] **Step 2: Verify RED**

Run: `npm run test:electron -- electron/tests/web-server-e2e.test.mjs`

Expected: FAIL until static serving and adapter are correct.

- [ ] **Step 3: Fix server/UI seams only**

Adjust adapter response mapping so renderer receives the same shapes as Electron preload methods.

- [ ] **Step 4: Add visual hash test**

Capture dashboard and runs pages from served Web UI at 1440x960 and compare SHA-256 hashes.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run test:electron -- electron/tests/web-server-e2e.test.mjs electron/tests/web-server-visual.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add electron/tests/web-server-e2e.test.mjs electron/tests/web-server-visual.test.mjs package.json
git commit -m "test: cover server web ui in browser"
```

## Task 7: Documentation and Version Bump

**Files:**
- Modify: `README.md`
- Modify: `npm/autovpn-cli/README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `npm/autovpn-cli/package.json`
- Modify: `npm/autovpn-cli/package-lock.json`

- [ ] **Step 1: Document server mode**

Add install and usage examples for `autovpn serve`, token auth, localhost default, and reverse proxy guidance.

- [ ] **Step 2: Bump versions**

Run:

```bash
npm version 1.5.0 --no-git-tag-version
cd npm/autovpn-cli && npm version 1.5.0 --no-git-tag-version
```

Then update `pyproject.toml` so `[project].version` is also `1.5.0`.

- [ ] **Step 3: Verify package metadata**

Run:

```bash
node -e "console.log(require('./package.json').version)"
node -e "console.log(require('./npm/autovpn-cli/package.json').version)"
python - <<'PY'
import tomllib
print(tomllib.loads(open('pyproject.toml','rb').read().decode())['project']['version'])
PY
```

Expected: all three commands print `1.5.0`.

- [ ] **Step 4: Commit**

Run:

```bash
git add README.md npm/autovpn-cli/README.md package.json package-lock.json npm/autovpn-cli/package.json npm/autovpn-cli/package-lock.json pyproject.toml
git commit -m "docs: prepare v1.5.0 server mode"
```

## Task 8: Full Verification, Review, Push, Release

**Files:**
- No planned source edits unless review finds issues.

- [ ] **Step 1: Run full regression**

Run:

```bash
./scripts/run_pytest.sh tests -v
cd npm/autovpn-cli && npm test
cd ../..
npm run test:electron
npm run package:electron
```

Expected: all commands pass. If UI behavior changes, rerun browser H5 and visual tests immediately after each fix.

- [ ] **Step 2: Use `superpowers:requesting-code-review`**

Run the code-review skill against the final diff. Fix every confirmed issue and repeat affected tests.

- [ ] **Step 3: Push branch and open PR**

Run:

```bash
git status --short
git push origin HEAD:feature/server-web-ui-v1.5.0
gh pr create --base main --head feature/server-web-ui-v1.5.0 --title "Add AutoVPN server Web UI" --body-file <generated-pr-body>
```

- [ ] **Step 4: Merge and tag release**

After required checks and review pass:

```bash
gh pr merge --squash --delete-branch
git checkout main
git pull --ff-only origin main
git tag v1.5.0
git push origin v1.5.0
```

- [ ] **Step 5: Publish package/release artifacts**

Use the repository's existing release workflow or npm publish process for `@swimmingliu/autovpn@1.5.0`. Confirm the GitHub release/tag and npm version are visible.

## Self-Review

- Spec coverage: server CLI, HTTP API, token auth, Web UI adapter, H5/browser test, visual test, full regression, code review, push, and v1.5.0 release are covered.
- Placeholder scan: no `TBD`, `TODO`, `implement later`, or `Similar to` placeholders are present.
- Type consistency: `ServeOptions`, `parseServeOptions`, `createAutoVpnServer`, and runtime method names are consistent across tasks.
