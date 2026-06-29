# Node Non-deploy Pipeline Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the v2 Node-first CLI iteration by adding an opt-in Node backend run path for non-deploy pipelines and hardening `.env` propagation for Python-backed runtime calls.

**Architecture:** Keep Python as the default backend. Add `AUTOVPN_BACKEND=node` support for `run --skip-deploy --skip-verify`, implemented through a dedicated Node orchestrator that reuses existing pipeline stage modules and preserves Python fallback per stage. Add a runtime environment helper so project `.env` values are merged into spawned Python backend/helper environments without overriding explicit process env.

**Tech Stack:** Node.js 24, TypeScript, `node:test`, `@iarna/toml`, existing npm CLI backend/stage modules, Python pytest compatibility suites, Electron node:test renderer/package tests.

---

## File Structure

- Modify `npm/autovpn-cli/src/backend/types.ts`
  - Allow `RunOptions.output` to include `human`.
- Modify `npm/autovpn-cli/src/backend/select-backend.ts`
  - Accept `AUTOVPN_BACKEND=node` and return `NodeBackend`.
- Modify `npm/autovpn-cli/src/backend/node-backend.ts`
  - Implement `run()` by delegating to the Node orchestrator.
  - Implement explicit unsupported-method errors.
- Create `npm/autovpn-cli/src/pipeline/orchestrator.ts`
  - Own opt-in Node non-deploy run orchestration, event emission, artifact writing, and summary handling.
- Create `npm/autovpn-cli/src/runtime/env.ts`
  - Load project `.env` and merge it with process env for Python child processes.
- Modify stage modules that spawn Python helpers:
  - `npm/autovpn-cli/src/pipeline/dedupe.ts`
  - `npm/autovpn-cli/src/pipeline/postprocess.ts`
  - `npm/autovpn-cli/src/pipeline/render.ts`
  - `npm/autovpn-cli/src/pipeline/obfuscate.ts`
  - `npm/autovpn-cli/src/pipeline/availability.ts`
  - `npm/autovpn-cli/src/pipeline/extract.ts`
  - `npm/autovpn-cli/src/pipeline/speedtest.ts`
  - Use merged env when `cwd` or `projectRoot` identifies a project.
- Modify `npm/autovpn-cli/src/backend/python-backend.ts`
  - Merge project `.env` into spawned Python backend commands when project root is known.
- Inspect `npm/autovpn-cli/src/cli/native-commands.ts`
  - Confirm foreground high-risk commands still pass through the backend adapter and do not bypass `NodeBackend.run()`.
  - Modify this file only when the Task 5 failing test proves the command path bypasses backend streaming.
- Add tests:
  - `npm/autovpn-cli/test/backend-contract.test.mjs`
  - `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`
  - `npm/autovpn-cli/test/runtime/env.test.mjs`
- Add fixture directories:
  - `tests/fixtures/node-migration/pipeline/orchestrator/`

## Task 1: Backend Selection and Unsupported Node Backend Behavior

**Files:**
- Modify: `npm/autovpn-cli/src/backend/types.ts`
- Modify: `npm/autovpn-cli/src/backend/select-backend.ts`
- Modify: `npm/autovpn-cli/src/backend/node-backend.ts`
- Test: `npm/autovpn-cli/test/backend-contract.test.mjs`

- [ ] **Step 1: Write failing tests for `AUTOVPN_BACKEND=node` selection and unsupported deploy run**

Append to `npm/autovpn-cli/test/backend-contract.test.mjs`:

```js
import { NodeBackend } from '../dist/backend/node-backend.js';

test('selectBackend supports explicit Node backend opt-in', () => {
  const backend = selectBackend({ env: { AUTOVPN_BACKEND: 'node' } });

  assert.equal(backend.kind, 'node');
  assert.ok(backend instanceof NodeBackend);
});

test('NodeBackend rejects deploy and verify runs before creating artifacts', async () => {
  const backend = new NodeBackend({ env: {}, cwd: '/repo' });

  await assert.rejects(async () => {
    for await (const _event of backend.run({ projectRoot: '/repo', skipDeploy: false, skipVerify: false, output: 'jsonl' })) {
      // consume
    }
  }, /Node backend deploy is not available yet/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "Node backend|selectBackend"
```

Expected: FAIL because `NodeBackend` is not exported with a constructor that accepts options and `selectBackend()` rejects `node`.

- [ ] **Step 3: Implement minimal backend selection and unsupported methods**

Replace `npm/autovpn-cli/src/backend/node-backend.ts` with:

```ts
import { AutoVpnBackend, DetachedRunOptions, JobSummary, LogOptions, ResumeOptions, RetryOptions, RunOptions } from './types.js';
import { AutoVpnEvent } from '../events/schema.js';

export interface NodeBackendOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function unsupported(method: string): Error {
  return new Error(`Node backend ${method} is not available yet; use AUTOVPN_BACKEND=python`);
}

export class NodeBackend implements AutoVpnBackend {
  readonly kind = 'node' as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;

  constructor(options: NodeBackendOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
  }

  async *run(options: RunOptions): AsyncIterable<AutoVpnEvent> {
    if (!options.skipDeploy || !options.skipVerify) {
      throw new Error('Node backend deploy is not available yet; use AUTOVPN_BACKEND=python or --skip-deploy --skip-verify');
    }
    if (options.resumeLatest) {
      throw new Error('Node backend resume-latest is not available yet; use AUTOVPN_BACKEND=python');
    }
    throw new Error('Node backend non-deploy orchestrator is not implemented yet');
  }

  async *retryStage(_options: RetryOptions): AsyncIterable<AutoVpnEvent> {
    throw unsupported('retry-stage');
  }

  async *resume(_options: ResumeOptions): AsyncIterable<AutoVpnEvent> {
    throw unsupported('resume');
  }

  async startDetached(_options: DetachedRunOptions): Promise<JobSummary> {
    throw unsupported('startDetached');
  }

  async stopJob(_jobId: string): Promise<JobSummary> {
    throw unsupported('stopJob');
  }

  async readJob(_jobId: string): Promise<JobSummary> {
    throw unsupported('readJob');
  }

  async *readLogs(_options: LogOptions): AsyncIterable<string> {
    throw unsupported('readLogs');
  }

  async executeCli(_argv: string[]): Promise<number> {
    throw unsupported('executeCli');
  }
}
```

Update `npm/autovpn-cli/src/backend/select-backend.ts`:

```ts
import { NodeBackend } from './node-backend.js';
import { PythonBackend, PythonBackendOptions } from './python-backend.js';
import { AutoVpnBackend } from './types.js';

export interface SelectBackendOptions extends PythonBackendOptions {
  env?: NodeJS.ProcessEnv;
}

export function selectBackend(options: SelectBackendOptions = {}): AutoVpnBackend {
  const backend = String(options.env?.AUTOVPN_BACKEND ?? '').trim().toLowerCase();
  if (backend === 'node') {
    return new NodeBackend(options);
  }
  if (backend && backend !== 'python') {
    throw new Error(`Unsupported AUTOVPN_BACKEND: ${backend}`);
  }
  return new PythonBackend(options);
}
```

Update `npm/autovpn-cli/src/backend/types.ts`:

```ts
export interface RunOptions {
  projectRoot: string;
  skipDeploy?: boolean;
  skipVerify?: boolean;
  resumeLatest?: boolean;
  output?: 'jsonl' | 'human';
  eventLog?: string;
  humanLog?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "Node backend|selectBackend"
```

Expected: PASS for the new backend selection and deploy rejection tests.

- [ ] **Step 5: Commit**

```bash
git add npm/autovpn-cli/src/backend/types.ts npm/autovpn-cli/src/backend/select-backend.ts npm/autovpn-cli/src/backend/node-backend.ts npm/autovpn-cli/test/backend-contract.test.mjs
git commit -m "feat: add node backend opt-in"
```

## Task 2: Runtime `.env` Merge Helper

**Files:**
- Create: `npm/autovpn-cli/src/runtime/env.ts`
- Modify: `npm/autovpn-cli/src/backend/python-backend.ts`
- Test: `npm/autovpn-cli/test/runtime/env.test.mjs`
- Test: `npm/autovpn-cli/test/backend-contract.test.mjs`

- [ ] **Step 1: Write failing tests for `.env` precedence and PythonBackend spawn env**

Create `npm/autovpn-cli/test/runtime/env.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadProjectDotEnv, mergeProjectEnv } from '../../dist/runtime/env.js';

test('loadProjectDotEnv reads project .env without exposing missing files as errors', async () => {
  const root = await mkdir(path.join(os.tmpdir(), `autovpn-env-${Date.now()}`), { recursive: true });
  await writeFile(path.join(root, '.env'), 'VPN_AUTOMATION_UPSTREAM_PROXY=off\nCLOUDFLARE_API_TOKEN=secret\n', 'utf8');

  assert.deepEqual(loadProjectDotEnv(root), {
    VPN_AUTOMATION_UPSTREAM_PROXY: 'off',
    CLOUDFLARE_API_TOKEN: 'secret'
  });
  assert.deepEqual(loadProjectDotEnv(path.join(root, 'missing')), {});
});

test('mergeProjectEnv lets explicit process env override .env values', async () => {
  const root = await mkdir(path.join(os.tmpdir(), `autovpn-env-precedence-${Date.now()}`), { recursive: true });
  await writeFile(path.join(root, '.env'), 'VPN_AUTOMATION_UPSTREAM_PROXY=off\nEXTRA=value\n', 'utf8');

  const merged = mergeProjectEnv(root, {
    VPN_AUTOMATION_UPSTREAM_PROXY: 'http://127.0.0.1:7890',
    PATH: '/bin'
  });

  assert.equal(merged.VPN_AUTOMATION_UPSTREAM_PROXY, 'http://127.0.0.1:7890');
  assert.equal(merged.EXTRA, 'value');
  assert.equal(merged.PATH, '/bin');
});
```

Append to `npm/autovpn-cli/test/backend-contract.test.mjs`:

```js
test('PythonBackend merges project .env into spawned run environment without overriding explicit env', async () => {
  const spawns = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const backend = new PythonBackend({
    env: { PATH: '/bin', VPN_AUTOMATION_UPSTREAM_PROXY: 'http://127.0.0.1:7890' },
    resolvePythonCli: () => ({ command: '/opt/autovpn/bin/autovpn', args: [] }),
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      return child;
    }
  });

  const consume = (async () => {
    for await (const _event of backend.run({ projectRoot: '/tmp/project-with-env', skipDeploy: true, skipVerify: true, output: 'jsonl' })) {
      // consume
    }
  })();
  child.stdout.emit('data', '{"type":"summary","run_status":"success"}\n');
  child.stdout.emit('end');
  child.emit('close', 0, null);
  await consume;

  assert.equal(spawns[0].options.env.VPN_AUTOMATION_UPSTREAM_PROXY, 'http://127.0.0.1:7890');
});
```

This backend test verifies the hook point. A later step will add a temp project `.env` test once `PythonBackend` supports dependency injection for env loading or uses real temp paths.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "ProjectDotEnv|mergeProjectEnv|PythonBackend merges"
```

Expected: FAIL because `dist/runtime/env.js` does not exist and `PythonBackend` does not merge `.env`.

- [ ] **Step 3: Implement runtime env helper**

Create `npm/autovpn-cli/src/runtime/env.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

function parseDotEnv(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

export function loadProjectDotEnv(projectRoot: string): Record<string, string> {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  return parseDotEnv(fs.readFileSync(envPath, 'utf8'));
}

export function mergeProjectEnv(projectRoot: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...loadProjectDotEnv(projectRoot),
    ...env
  };
}
```

- [ ] **Step 4: Use merged env in PythonBackend**

Modify `npm/autovpn-cli/src/backend/python-backend.ts`:

```ts
import { mergeProjectEnv } from '../runtime/env.js';
```

Add helper:

```ts
function projectRootFromArgv(argv: string[]): string | undefined {
  const index = argv.indexOf('--project-root');
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  return undefined;
}
```

In the spawn paths for event streams and captured JSON, compute:

```ts
const projectRoot = projectRootFromArgv(argv);
const env = projectRoot ? mergeProjectEnv(projectRoot, this.env) : this.env;
```

Use that `env` in the child spawn options and Python CLI resolution calls for those command invocations.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "ProjectDotEnv|mergeProjectEnv|PythonBackend merges"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add npm/autovpn-cli/src/runtime/env.ts npm/autovpn-cli/src/backend/python-backend.ts npm/autovpn-cli/test/runtime/env.test.mjs npm/autovpn-cli/test/backend-contract.test.mjs
git commit -m "fix: merge project env into python backend"
```

## Task 3: Orchestrator Fixture and Failing Node Run Test

**Files:**
- Create: `tests/fixtures/node-migration/pipeline/orchestrator/profile.toml`
- Create: `tests/fixtures/node-migration/pipeline/orchestrator/template.js`
- Create: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`

- [ ] **Step 1: Create deterministic orchestrator fixture**

Create `tests/fixtures/node-migration/pipeline/orchestrator/profile.toml`:

```toml
[sources]
[sources.fixture]
url = "https://fixture.example/source?t=123"
key = "abcdabcdabcdabcd"
enabled = true
max_iterations = 1
min_iterations = 0
plateau_limit = 1
use_random_area = false
failure_limit = 1
max_runtime_seconds = 0

[speed_test]
min_download_mb_s = 1
timeout_seconds = 20
concurrency = 1
urls = ["https://speed.example/10mb"]
probe_url = "https://www.gstatic.com/generate_204"
max_download_bytes = 1000
startup_wait_seconds = 1
max_download_candidates = 0

[availability_targets]
[availability_targets.custom]
url = "https://custom.example/"
enabled = true
allowed_hosts = ["custom.example"]
negative_phrases = []

[deploy]
project_name = "fixture-project"
subscription_url = "https://sub.example.invalid/?serect_key=fixture"
verify_subscription_url = "https://sub.example.invalid/verify?serect_key=fixture"
pages_project_url = "https://fixture-project.pages.dev"
custom_domain = ""
secret_query = "serect_key=fixture"
cloudflare_auth_mode = "api_token"
cloudflare_api_token = ""
cloudflare_global_key = ""
cloudflare_email = ""
account_id = ""
use_wrangler = true
auto_create_project_on_blocked = true
fallback_project_prefix = ""

[worker_build]
environment_name = "production"
entry_filename = "_worker.js"
bundle_subdir = "pages_bundle"
modules_subdir = "modules"
manifest_filename = "manifest.json"
variable_prefix = "sg"
comment_template = "subscription worker: returns encoded payload on secret match, random bytes otherwise"
random_noise_min_length = 24
random_noise_max_length = 96
enable_keyword_fragmentation = false
enable_identifier_randomization = false
emit_sidecar_modules = true

[filters]
excluded_country_codes = []

[filters.per_country_limit]
```

Create `tests/fixtures/node-migration/pipeline/orchestrator/template.js`:

```js
export default {
  async fetch(request) {
    const MainData = `__AUTO_VPN_MAIN_DATA__`;
    return new Response(MainData);
  }
};
```

- [ ] **Step 2: Write failing orchestrator test with injected stage functions**

Create `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runNodePipeline } from '../../dist/pipeline/orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'node-migration', 'pipeline', 'orchestrator');

async function makeProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-node-run-'));
  await mkdir(path.join(projectRoot, 'templates'), { recursive: true });
  await mkdir(path.join(projectRoot, 'state'), { recursive: true });
  await writeFile(path.join(projectRoot, 'pyproject.toml'), '[project]\nname = "fixture"\n', 'utf8');
  await writeFile(path.join(projectRoot, 'state', 'profile.toml'), await readFile(path.join(fixtureDir, 'profile.toml'), 'utf8'), 'utf8');
  await writeFile(path.join(projectRoot, 'templates', 'vmess_node.js'), await readFile(path.join(fixtureDir, 'template.js'), 'utf8'), 'utf8');
  return projectRoot;
}

test('runNodePipeline emits compatible events and writes non-deploy artifacts', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime') },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: ['vmess://one', 'vmess://one', 'vmess://two'] }),
      speedtest: async (links) => links.map((link, index) => ({ link, reachable: true, average_download_mb_s: index === 0 ? 3 : 2, latency_ms: 20 + index, error: '' })),
      availability: async (results) => results.map((speed_result) => ({ ...speed_result, all_passed: true, provider_results: { custom: { provider: 'custom', passed: true, reason: 'ok', status_code: 200, final_url: 'https://custom.example/', matched_phrase: '' } } })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ entrypoint: '_worker.js', transformed_source: transformedSource, modules: [], manifest: { main_module: '_worker.js', modules: [] } })
    }
  });

  assert.equal(result.run_status, 'success');
  assert.deepEqual(result.counts.raw_links, 3);
  assert.deepEqual(result.counts.deduped_links, 2);
  assert.deepEqual(result.counts.speedtest_links, 2);
  assert.deepEqual(result.counts.availability_links, 2);
  assert.deepEqual(result.counts.final_links, 2);
  assert.deepEqual(events.map((event) => event.type).filter((type) => type === 'summary'), ['summary']);

  const artifactDir = result.artifact_dir;
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_raw.txt'), 'utf8')).trim().split(/\n/).length, 3);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_deduped.txt'), 'utf8')).trim().split(/\n/).length, 2);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_speedtest.txt'), 'utf8')).trim().split(/\n/).length, 2);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_availability.txt'), 'utf8')).trim().split(/\n/).length, 2);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_emoji.txt'), 'utf8')).includes('🇺🇸 US'), true);
  assert.equal(JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8')).run_status, 'success');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern runNodePipeline
```

Expected: FAIL because `dist/pipeline/orchestrator.js` does not exist.

- [ ] **Step 4: Commit fixture and failing test**

```bash
git add tests/fixtures/node-migration/pipeline/orchestrator npm/autovpn-cli/test/pipeline/orchestrator.test.mjs
git commit -m "test: add node orchestrator fixture"
```

## Task 4: Implement Minimal Node Orchestrator

**Files:**
- Create: `npm/autovpn-cli/src/pipeline/orchestrator.ts`
- Modify: `npm/autovpn-cli/src/backend/node-backend.ts`
- Test: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`

- [ ] **Step 1: Implement `runNodePipeline()`**

Create `npm/autovpn-cli/src/pipeline/orchestrator.ts` with these exported shapes:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@iarna/toml';

import { dedupeVmessLinksWithBackend } from './dedupe.js';
import { renderMainDataWithBackend } from './render.js';
import { buildWorkerArtifactsWithBackend } from './obfuscate.js';
import { selectLinksByCountryLimit, decorateLinkWithCountry } from './postprocess.js';
import { fetchSourceLinksWithBackend } from './extract.js';
import { speedtestLinksWithBackend, SpeedTestResult } from './speedtest.js';
import { checkLinkAvailabilityBatchWithBackend } from './availability.js';
import { AutoVpnEvent } from '../events/schema.js';
import { resolveArtifactsRoot, resolveProfilePath } from '../runtime/paths.js';
import { safeDeployment, redactText } from '../runtime/redaction.js';

export interface NodePipelineOptions {
  projectRoot: string;
  skipDeploy?: boolean;
  skipVerify?: boolean;
  output?: 'jsonl' | 'human';
  eventLog?: string;
  humanLog?: string;
}

export interface PipelineSummary {
  artifact_dir: string;
  stage_status: Record<string, string>;
  counts: Record<string, number>;
  source_counts: Record<string, Record<string, number | string>>;
  deployment: Record<string, unknown>;
  retry_context: Record<string, unknown>;
  run_status: string;
  error: string;
}

export interface NodePipelineTestStages {
  extract?: (sourceName: string, source: Record<string, unknown>) => Promise<{ links: string[]; requested_iterations?: number; successful_iterations?: number; failed_iterations?: number }>;
  speedtest?: (links: string[], config: Record<string, unknown>) => Promise<SpeedTestResult[]>;
  availability?: (results: SpeedTestResult[], config: Record<string, unknown>) => Promise<Array<SpeedTestResult & { all_passed: boolean; provider_results: Record<string, unknown> }>>;
  countryLookup?: (link: string) => string;
  obfuscate?: (input: { transformedSource: string; profile: Record<string, any> }) => Promise<{ entrypoint: string; transformed_source: string; modules: unknown[]; manifest: Record<string, unknown> }>;
}

export interface RunNodePipelineContext {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  emit?: (event: AutoVpnEvent) => void;
  stages?: NodePipelineTestStages;
}
```

Implement minimal behavior:

- Read profile from `resolveProfilePath(projectRoot, env)`.
- Create artifact dir under `resolveArtifactsRoot(projectRoot, env)` using `YYYYMMDD-HHMMSS`.
- Initialize stage status for `doctor`, `extract`, `dedupe`, `speedtest`, `availability`, `postprocess`, `render`, `obfuscate`, `deploy`, `verify`.
- Emit events through `context.emit`.
- Write line files with newline termination.
- For injected test stages, use them.
- For real stages, call existing stage modules.
- In this first implementation, use batch flow rather than streaming.
- Mark `deploy` and `verify` skipped when requested.
- Write `pipeline_report.json` after each meaningful stage.
- Return `PipelineSummary`.

- [ ] **Step 2: Update `NodeBackend.run()` to call orchestrator**

Modify `npm/autovpn-cli/src/backend/node-backend.ts`:

```ts
import { runNodePipeline } from '../pipeline/orchestrator.js';
```

In `run()` replace the placeholder implementation:

```ts
const events: AutoVpnEvent[] = [];
const summary = await runNodePipeline(options, {
  env: this.env,
  emit: (event) => events.push(event)
});
for (const event of events) {
  yield event;
}
if (summary.run_status !== 'success') {
  throw new Error(summary.error || 'Node backend pipeline failed');
}
```

- [ ] **Step 3: Run orchestrator fixture test**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern runNodePipeline
```

Expected: PASS.

- [ ] **Step 4: Run full npm test**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add npm/autovpn-cli/src/pipeline/orchestrator.ts npm/autovpn-cli/src/backend/node-backend.ts
git commit -m "feat: add node non-deploy orchestrator"
```

## Task 5: Node Backend CLI Integration Test

**Files:**
- Modify: `npm/autovpn-cli/test/backend-contract.test.mjs`

- [ ] **Step 1: Write failing CLI integration test for `AUTOVPN_BACKEND=node run`**

Append:

```js
test('CLI foreground run streams Node backend events when AUTOVPN_BACKEND=node', async () => {
  const io = createIo();
  const code = await runCliShell(['run', '--project-root', '.', '--skip-deploy', '--skip-verify', '--output', 'jsonl'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    env: { AUTOVPN_BACKEND: 'node' },
    io,
    createBackend: () => ({
      executeCli: async () => {
        throw new Error('executeCli should not be used for Node backend run');
      },
      run: async function* () {
        yield { type: 'run_started', artifact_dir: '/tmp/artifact' };
        yield { type: 'summary', run_status: 'success', artifact_dir: '/tmp/artifact' };
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(io.stderr, '');
  assert.deepEqual(io.stdout.trim().split(/\n/).map((line) => JSON.parse(line).type), ['run_started', 'summary']);
});
```

- [ ] **Step 2: Run test to verify it fails if CLI ignores `run()`**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "foreground run streams Node"
```

Expected before implementation: FAIL if high-risk command execution only calls `executeCli()`.

- [ ] **Step 3: Implement backend event streaming in CLI shell**

Modify the high-risk command path in `npm/autovpn-cli/src/cli/main.ts` so foreground `run`, `retry-stage`, and `resume` use backend streaming methods when the backend object provides them. For `run`, stream JSON events to stdout:

```ts
for await (const event of backend.run(runOptions)) {
  io.writeStdout(`${JSON.stringify(event)}\n`);
}
return 0;
```

Keep Python compatibility by using `PythonBackend.run()` rather than `executeCli()` where the backend supports streaming. If this is too invasive for retry/resume in the same task, implement only `run` and keep retry/resume on `executeCli()` with tests documenting the boundary.

- [ ] **Step 4: Run focused and full npm tests**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "foreground run streams Node|high-risk CLI"
rtk proxy npm test --prefix npm/autovpn-cli
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add npm/autovpn-cli/src/cli/main.ts npm/autovpn-cli/test/backend-contract.test.mjs
git commit -m "feat: stream node backend run events"
```

## Task 6: Python Helper `.env` Propagation for Stage Rollbacks

**Files:**
- Modify Python-helper stage files listed in File Structure.
- Test: each relevant `npm/autovpn-cli/test/pipeline/*.test.mjs`

- [ ] **Step 1: Add one failing test per helper pattern**

For `extract`, `availability`, and `speedtest`, extend their existing rollback adapter tests to assert that spawn options include `.env` merged values when `cwd` points to a temp project containing `.env`.

Example for `npm/autovpn-cli/test/pipeline/extract.test.mjs`:

```js
test('Python extract rollback adapter merges project .env into helper environment', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-extract-env-'));
  await writeFile(path.join(projectRoot, '.env'), 'VPN_AUTOMATION_UPSTREAM_PROXY=off\nEXTRA_FROM_ENV=1\n', 'utf8');
  const spawns = [];
  await fetchSourceLinksWithBackend({
    source_name: 'leiting',
    source: { url: 'https://example.com/api', key: 'abcdabcdabcdabcd', max_iterations: 0 }
  }, {
    cwd: projectRoot,
    env: { AUTOVPN_STAGE_BACKEND_EXTRACT: 'python', PATH: '/bin' },
    resolvePythonCli: () => ({ command: '/opt/autovpn/.venv/bin/autovpn', args: [] }),
    spawn: (command, args, options) => {
      spawns.push(options);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write(chunk) { this.input = String(chunk); }, end() { child.stdout.emit('data', '{"source_name":"leiting","requested_iterations":0,"successful_iterations":0,"failed_iterations":0,"links":[]}\n'); child.emit('close', 0, null); } };
      return child;
    }
  });

  assert.equal(spawns[0].env.VPN_AUTOMATION_UPSTREAM_PROXY, 'off');
  assert.equal(spawns[0].env.EXTRA_FROM_ENV, '1');
  assert.equal(spawns[0].env.PATH, '/bin');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "merges project .env"
```

Expected: FAIL because helper spawn options use raw `options.env`.

- [ ] **Step 3: Implement helper env merge**

In each helper module, import:

```ts
import { mergeProjectEnv } from '../runtime/env.js';
```

Change:

```ts
const env = options.env ?? process.env;
```

to:

```ts
const baseEnv = options.env ?? process.env;
const env = mergeProjectEnv(options.cwd ?? process.cwd(), baseEnv);
```

Do this only in Python helper adapter paths, not pure Node stage paths.

- [ ] **Step 4: Run focused and full pipeline tests**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "merges project .env|rollback adapter"
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern pipeline
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add npm/autovpn-cli/src/pipeline npm/autovpn-cli/test/pipeline
git commit -m "fix: merge project env into python stage helpers"
```

## Task 7: Failure, Redaction, and Stability Tests

**Files:**
- Modify: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`
- Modify: `npm/autovpn-cli/src/pipeline/orchestrator.ts`

- [ ] **Step 1: Add failing tests for failed stage summary and redaction**

Append to `orchestrator.test.mjs`:

```js
test('runNodePipeline writes failed report and redacts secret-bearing errors', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime') },
    now: () => new Date('2026-06-29T02:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => {
        throw new Error('bad url https://example.invalid/sub?token=secret');
      }
    }
  });

  assert.equal(result.run_status, 'failed');
  assert.match(result.error, /token=<redacted>/);
  assert.equal(events.some((event) => event.type === 'run_failed'), true);
  const report = JSON.parse(await readFile(path.join(result.artifact_dir, 'pipeline_report.json'), 'utf8'));
  assert.equal(report.run_status, 'failed');
  assert.match(report.error, /token=<redacted>/);
});

test('runNodePipeline creates separate artifact directories for repeated runs', async () => {
  const projectRoot = await makeProject();
  const env = { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime') };
  const first = await runNodePipeline({ projectRoot, skipDeploy: true, skipVerify: true }, { env, now: () => new Date('2026-06-29T03:00:00Z'), stages: { extract: async () => ({ links: [] }) } });
  const second = await runNodePipeline({ projectRoot, skipDeploy: true, skipVerify: true }, { env, now: () => new Date('2026-06-29T03:00:01Z'), stages: { extract: async () => ({ links: [] }) } });

  assert.notEqual(first.artifact_dir, second.artifact_dir);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "failed report|separate artifact"
```

Expected: FAIL until orchestrator catches errors and writes failed summaries.

- [ ] **Step 3: Implement failure handling and redaction**

In `runNodePipeline()` wrap the stage execution in `try/catch`:

```ts
try {
  // stages
  summary.run_status = 'success';
  writeReport();
  emit({ type: 'summary', ...summary });
  return summary;
} catch (error) {
  if (currentStage && summary.stage_status[currentStage] === 'running') {
    setStage(currentStage, 'failed');
  }
  summary.run_status = 'failed';
  summary.error = redactText(`${error instanceof Error ? error.name : 'Error'}: ${error instanceof Error ? error.message : String(error)}`);
  writeReport();
  emit({ type: 'run_failed', error: summary.error });
  emit({ type: 'summary', ...summary });
  return summary;
}
```

- [ ] **Step 4: Run focused and full npm tests**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "runNodePipeline"
rtk proxy npm test --prefix npm/autovpn-cli
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add npm/autovpn-cli/src/pipeline/orchestrator.ts npm/autovpn-cli/test/pipeline/orchestrator.test.mjs
git commit -m "test: cover node orchestrator failure handling"
```

## Task 8: Performance Fixture Test

**Files:**
- Modify: `npm/autovpn-cli/test/pipeline/orchestrator.test.mjs`

- [ ] **Step 1: Add bounded performance test**

Append:

```js
test('runNodePipeline handles large deterministic link sets within a bounded local runtime', async () => {
  const projectRoot = await makeProject();
  const links = Array.from({ length: 1000 }, (_, index) => `vmess://node-${index % 500}`);
  const started = performance.now();
  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime') },
    now: () => new Date('2026-06-29T04:00:00Z'),
    stages: {
      extract: async () => ({ links }),
      speedtest: async (deduped) => deduped.map((link) => ({ link, reachable: true, average_download_mb_s: 2, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speed_result) => ({ ...speed_result, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ entrypoint: '_worker.js', transformed_source: transformedSource, modules: [], manifest: { main_module: '_worker.js', modules: [] } })
    }
  });
  const elapsedMs = performance.now() - started;

  assert.equal(result.counts.raw_links, 1000);
  assert.equal(result.counts.deduped_links, 500);
  assert.ok(elapsedMs < 2000, `expected fixture run under 2000ms, got ${elapsedMs}`);
});
```

- [ ] **Step 2: Run test**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli -- --test-name-pattern "large deterministic"
```

Expected: PASS. If this is flaky on CI, raise the bound to `5000ms` and document why in the test name.

- [ ] **Step 3: Commit**

```bash
git add npm/autovpn-cli/test/pipeline/orchestrator.test.mjs
git commit -m "test: add node orchestrator performance fixture"
```

## Task 9: Documentation Updates

**Files:**
- Modify: `npm/autovpn-cli/README.md`
- Modify: `README.md`
- Modify: `docs/npm-cli/node-first-migration-sop.md`

- [ ] **Step 1: Update npm CLI README runtime shape**

In `npm/autovpn-cli/README.md`, update Runtime Shape to say:

```markdown
- Node.js can run the non-deploy pipeline when explicitly selected with `AUTOVPN_BACKEND=node` and `--skip-deploy --skip-verify`.
- Python remains the default backend and the deploy/verify backend during v2.
```

Add example:

```bash
AUTOVPN_BACKEND=node autovpn run --project-root . --skip-deploy --skip-verify --output jsonl
```

Add `.env` note:

```markdown
Project `.env` values are merged into Python-backed helper processes. Explicit shell environment variables win over `.env`; use `VPN_AUTOMATION_UPSTREAM_PROXY=off` to disable the default upstream proxy fallback on headless hosts.
```

- [ ] **Step 2: Update root README CLI quickstart**

Add the same opt-in Node backend example and warn that deploy/verify remain Python-backed.

- [ ] **Step 3: Update SOP completion state**

In `docs/npm-cli/node-first-migration-sop.md`, add a short note under Phase 6:

```markdown
Phase 6.5 closes the orchestration gap by connecting migrated Node stages into an opt-in non-deploy `AUTOVPN_BACKEND=node` run path. Phase 7 still owns deploy and verify.
```

- [ ] **Step 4: Run README tests**

Run:

```bash
rtk proxy npm run test:electron -- --test-name-pattern README
```

Expected: PASS for README structure tests.

- [ ] **Step 5: Commit**

```bash
git add npm/autovpn-cli/README.md README.md docs/npm-cli/node-first-migration-sop.md
git commit -m "docs: document node non-deploy backend"
```

## Task 10: Full Verification, Review, PR, and Merge

**Files:**
- All touched files.

- [ ] **Step 1: Run full verification matrix**

Run:

```bash
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh tests/pipeline -q
rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh -q
rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh tests/e2e -q
rtk proxy npm run test:electron
rtk proxy npm run package:electron
rtk proxy npm pack --pack-destination /tmp --prefix npm/autovpn-cli
```

Expected:

- npm CLI tests pass.
- Python pipeline tests pass.
- Python full tests pass.
- e2e tests pass.
- Electron tests pass, including visual hashes.
- Electron package succeeds and logs project PNG/ICNS icons without `default Electron icon is used`.
- npm tarball includes `dist/pipeline/orchestrator.js`.

- [ ] **Step 2: npm tarball smoke**

Run:

```bash
tmpdir="$(mktemp -d /tmp/autovpn-node-orchestrator-smoke.XXXXXX)"
cd "$tmpdir"
rtk proxy npm init -y >/dev/null
rtk proxy npm install /tmp/swimmingliu-autovpn-1.3.0.tgz >/dev/null
node --input-type=module -e "import { runNodePipeline } from '@swimmingliu/autovpn/dist/pipeline/orchestrator.js'; if (typeof runNodePipeline !== 'function') throw new Error('missing orchestrator'); console.log('node orchestrator package smoke ok')"
```

Expected: prints `node orchestrator package smoke ok`.

- [ ] **Step 3: Local review**

Use `superpowers:requesting-code-review` if subagent capacity allows. If not, run a main-thread review:

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- npm/autovpn-cli/src npm/autovpn-cli/test README.md docs
```

Review for:

- Node backend does not become default.
- Deploy/verify are rejected or remain Python-backed.
- `.env` merge precedence is explicit env over `.env`.
- No secret-bearing values are printed in test snapshots or docs.
- All new artifacts are under expected runtime/artifact roots.

- [ ] **Step 4: Apply review feedback and rerun verification**

If files change after review, rerun the full matrix from Step 1.

- [ ] **Step 5: Push branch and open PR**

Run:

```bash
rtk proxy git push -u origin codex/node-cli-v2-orchestrator
cat > /tmp/node-orchestrator-pr.md <<'EOF'
## Summary
- add opt-in Node backend selection for non-deploy pipeline runs
- add a Node non-deploy pipeline orchestrator for `run --skip-deploy --skip-verify`
- merge project `.env` values into Python-backed backend/helper processes without overriding explicit shell env
- keep deploy and verify in the Phase 7 Python-backed path

## Rollback
- `AUTOVPN_BACKEND=python`
- `AUTOVPN_PIPELINE_BACKEND=python`
- `AUTOVPN_STAGE_BACKEND_<STAGE>=python`

## Verification
- `rtk proxy npm test --prefix npm/autovpn-cli`
- `rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh tests/pipeline -q`
- `rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh -q`
- `rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh tests/e2e -q`
- `rtk proxy npm run test:electron`
- `rtk proxy npm run package:electron`
- `rtk proxy npm pack --pack-destination /tmp --prefix npm/autovpn-cli`
- npm tarball import smoke for `dist/pipeline/orchestrator.js`

## Notes
- Electron packaging must continue to use project PNG/ICNS icons and must not report `default Electron icon is used`.
- Deploy and verify remain Phase 7.
EOF
rtk proxy gh pr create --repo SwimmingLiu/auto-vpn --base main --head codex/node-cli-v2-orchestrator --title "feat: add node non-deploy pipeline orchestrator" --body-file /tmp/node-orchestrator-pr.md
```

PR body must include:

- Summary.
- Rollback flags.
- Verification matrix.
- Packaging icon verification.
- Note that deploy/verify remain Phase 7.

- [ ] **Step 6: Watch CI and merge**

Run:

```bash
PR_NUMBER="$(rtk proxy gh pr view codex/node-cli-v2-orchestrator --repo SwimmingLiu/auto-vpn --json number --jq .number)"
rtk proxy gh pr checks "$PR_NUMBER" --watch --interval 10 --repo SwimmingLiu/auto-vpn
rtk proxy gh pr merge "$PR_NUMBER" --squash --delete-branch --repo SwimmingLiu/auto-vpn
```

Expected: CI passes and PR merges.

- [ ] **Step 7: Post-merge audit on `origin/main`**

Run from a clean `origin/main` checkout or detached worktree:

```bash
rtk proxy git fetch origin main --prune
git switch --detach origin/main
rtk proxy npm test --prefix npm/autovpn-cli
rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh -q
rtk proxy env PATH="$PWD/.venv/bin:$PATH" ./scripts/run_pytest.sh tests/e2e -q
rtk proxy npm run test:electron
rtk proxy npm run package:electron
```

Expected: all pass on merged main.
