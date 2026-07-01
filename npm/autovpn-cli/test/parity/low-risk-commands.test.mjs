import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCliShell } from '../../dist/cli/main.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const fixtureEnvs = new Map();

function createIo() {
  return {
    stdout: '',
    stderr: '',
    writeStdout(chunk) {
      this.stdout += chunk;
    },
    writeStderr(chunk) {
      this.stderr += chunk;
    }
  };
}

async function runNode(argv, { cwd, env = {}, runForwarder } = {}) {
  const io = createIo();
  const forwarded = [];
  const resolvedEnv = {
    ...process.env,
    ...(cwd && fixtureEnvs.get(cwd) ? fixtureEnvs.get(cwd) : {}),
    ...env
  };
  const code = await runCliShell(argv, {
    packageVersion: '1.3.0',
    cwd,
    env: resolvedEnv,
    io,
    runForwarder: runForwarder ?? (async (forwardedArgv) => {
      forwarded.push(forwardedArgv);
      return 99;
    })
  });
  return { code, stdout: io.stdout, stderr: io.stderr, forwarded };
}

async function createProjectFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autovpn-node-parity-'));
  const runtimeRoot = path.join(root, '.auto-vpn');
  const runtimeEnv = { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot };
  fixtureEnvs.set(root, runtimeEnv);
  await mkdir(path.join(runtimeRoot, 'jobs', '20260628-000000-abcdef'), { recursive: true });
  await mkdir(path.join(runtimeRoot, 'artifacts', '20260628-000000'), { recursive: true });
  await mkdir(path.join(root, 'templates', 'share-worker'), { recursive: true });
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "fixture"\n', 'utf8');
  await writeFile(path.join(root, 'templates', 'vmess_node.js'), '// worker\n', 'utf8');
  await writeFile(path.join(root, 'templates', 'share-worker', 'vpn.js'), '// share\n', 'utf8');
  await writeFile(path.join(runtimeRoot, 'profile.toml'), `
[sources.xuanfeng]
url = "https://example.invalid/source"
key = "secret-source-key"
enabled = true

[deploy]
project_name = "sub-nodes"
pages_project_url = "https://sub-nodes.pages.dev"
cloudflare_api_token = "secret-token"
cloudflare_global_key = ""
cloudflare_email = ""
account_id = "account-123"
subscription_url = "https://sub.example.invalid/sub"
verify_subscription_url = "https://sub.example.invalid/verify"
secret_query = "secret-query"

[speed_test]
timeout_seconds = 5
concurrency = 2
min_download_mb_s = 0
max_download_bytes = 1024
probe_url = "https://example.invalid/probe"
urls = ["https://example.invalid/file"]
`, 'utf8');

  const artifactDir = path.join(runtimeRoot, 'artifacts', '20260628-000000');
  await writeFile(path.join(artifactDir, 'pipeline_report.json'), JSON.stringify({
    run_status: 'success',
    stage_status: { extract: 'success', deploy: 'success' },
    counts: { raw_links: 2, final_links: 1 },
    source_counts: { xuanfeng: { raw_links: 2 } },
    deployment: {
      pages_project_url: 'https://sub-nodes.pages.dev',
      subscription_url: 'https://sub.example.invalid/sub?token=secret-token',
      secret_query: 'secret-query',
      cloudflare_api_token: 'secret-token'
    },
    retry_context: { stage: '' },
    error: 'failed with secret-token'
  }), 'utf8');
  await writeFile(path.join(artifactDir, 'vpn_node_emoji.txt'), 'vmess://not-valid-base64\n', 'utf8');

  const jobDir = path.join(runtimeRoot, 'jobs', '20260628-000000-abcdef');
  const job = {
    schema_version: 1,
    job_id: '20260628-000000-abcdef',
    kind: 'run',
    status: 'success',
    pid: 12345,
    pgid: 12345,
    created_at: '2026-06-28T00:00:00+08:00',
    started_at: '2026-06-28T00:00:00+08:00',
    finished_at: '2026-06-28T00:01:00+08:00',
    updated_at: '2026-06-28T00:01:00+08:00',
    exit_code: 0,
    signal: '',
    project_root: root,
    command: ['python', '-m', 'vpn_automation.backend', 'run', '--project-root', root],
    event_log: path.join(jobDir, 'events.jsonl'),
    human_log: path.join(jobDir, 'human.log'),
    stdout_log: path.join(jobDir, 'stdout.log'),
    stderr_log: path.join(jobDir, 'stderr.log'),
    artifact_dir: artifactDir,
    session_dir: jobDir,
    resume_from: '',
    retry: { source_artifact_dir: '', stage: '' },
    options: { resume_latest: false, skip_deploy: true, skip_verify: true, output_format: 'jsonl' },
    stop_requested_at: '',
    last_event_at: '2026-06-28T00:01:00+08:00',
    last_error: '',
    job_file: path.join(jobDir, 'job.json')
  };
  await writeFile(path.join(jobDir, 'job.json'), JSON.stringify(job), 'utf8');
  await writeFile(path.join(runtimeRoot, 'jobs', 'index.json'), JSON.stringify({
    schema_version: 1,
    latest_job_id: '20260628-000000-abcdef',
    jobs: [{
      job_id: '20260628-000000-abcdef',
      status: 'success',
      kind: 'run',
      created_at: '2026-06-28T00:00:00+08:00',
      job_file: path.join(jobDir, 'job.json')
    }]
  }), 'utf8');
  await writeFile(path.join(jobDir, 'human.log'), 'line 1\nline 2\nline 3\n', 'utf8');
  await writeFile(path.join(jobDir, 'events.jsonl'), '{"type":"summary","run_status":"success"}\n', 'utf8');

  return { root, artifactDir, runtimeRoot, env: runtimeEnv };
}

function resolvePythonCli() {
  const candidates = [
    process.env.AUTOVPN_PYTHON_CLI,
    path.join(REPO_ROOT, '.venv', 'bin', 'autovpn'),
    'autovpn'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'autovpn' || existsSync(candidate)) {
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
      if (result.status === 0) {
        return candidate;
      }
    }
  }
  return '';
}

function readOptionValue(argv, optionName) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === optionName) {
      return argv[index + 1];
    }
    if (value.startsWith(`${optionName}=`)) {
      return value.slice(optionName.length + 1);
    }
  }
  return undefined;
}

function runPython(argv) {
  const pythonCli = resolvePythonCli();
  if (!pythonCli) {
    return undefined;
  }
  const projectRoot = readOptionValue(argv, '--project-root');
  const env = {
    ...process.env,
    ...(projectRoot && fixtureEnvs.get(projectRoot) ? fixtureEnvs.get(projectRoot) : {})
  };
  return spawnSync(pythonCli, argv, { encoding: 'utf8', env });
}

function parseJsonLine(output) {
  return JSON.parse(output.trim());
}

function normalize(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll('\\', '/')
      .replaceAll('/private/var/', '/var/')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2})?/g, '<timestamp>');
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

test('Phase 3 low-risk commands run in Node by default', async () => {
  const { root, artifactDir } = await createProjectFixture();
  const commands = [
    { argv: ['doctor', '--project-root', root, '--output', 'json'], codes: [0, 1] },
    { argv: ['profile', 'show', '--project-root', root], codes: [0] },
    { argv: ['profile', 'summary', '--project-root', root, '--json'], codes: [0] },
    { argv: ['artifacts', 'latest', '--project-root', root], codes: [0] },
    { argv: ['artifacts', 'list', '--project-root', root], codes: [0] },
    { argv: ['artifacts', 'preview', artifactDir, '--project-root', root, '--json'], codes: [0] },
    { argv: ['status', '--project-root', root, '--json'], codes: [0] },
    { argv: ['logs', '--project-root', root, '--tail', '2'], codes: [0] },
    { argv: ['jobs', 'list', '--project-root', root, '--json'], codes: [0] },
    { argv: ['jobs', 'status', '20260628-000000-abcdef', '--project-root', root, '--json'], codes: [0] },
    { argv: ['jobs', 'logs', '20260628-000000-abcdef', '--project-root', root, '--tail', '2'], codes: [0] }
  ];

  for (const { argv, codes } of commands) {
    const result = await runNode(argv, { cwd: root });
    assert.ok(codes.includes(result.code), argv.join(' '));
    assert.equal(result.stderr, '', argv.join(' '));
    assert.deepEqual(result.forwarded, [], argv.join(' '));
    assert.notEqual(result.stdout, '', argv.join(' '));
  }
});

test('Phase 3 migrated non-job commands support explicit Python fallback', async () => {
  const { root, artifactDir } = await createProjectFixture();
  const cases = [
    { argv: ['doctor', '--project-root', root, '--output', 'json'], env: { AUTOVPN_DOCTOR_BACKEND: 'python' } },
    { argv: ['profile', 'show', '--project-root', root], env: { AUTOVPN_PROFILE_BACKEND: 'python' } },
    { argv: ['profile', 'summary', '--project-root', root, '--json'], env: { AUTOVPN_PROFILE_BACKEND: 'python' } },
    { argv: ['artifacts', 'latest', '--project-root', root], env: { AUTOVPN_ARTIFACTS_BACKEND: 'python' } },
    { argv: ['artifacts', 'list', '--project-root', root], env: { AUTOVPN_ARTIFACTS_BACKEND: 'python' } },
    { argv: ['artifacts', 'preview', artifactDir, '--project-root', root, '--json'], env: { AUTOVPN_ARTIFACTS_BACKEND: 'python' } }
  ];

  for (const item of cases) {
    const result = await runNode(item.argv, {
      cwd: root,
      env: item.env,
      runForwarder: async (forwardedArgv) => {
        assert.deepEqual(forwardedArgv, item.argv);
        return 7;
      }
    });

    assert.equal(result.code, 7, item.argv.join(' '));
    assert.equal(result.stdout, '', item.argv.join(' '));
    assert.equal(result.stderr, '', item.argv.join(' '));
  }
});

test('Phase 3 leaves doctor human output on the Python backend when requested', async () => {
  const { root } = await createProjectFixture();
  const argv = ['doctor', '--project-root', root];
  const result = await runNode(argv, {
    cwd: root,
    env: { AUTOVPN_DOCTOR_BACKEND: 'python' },
    runForwarder: async (forwardedArgv) => {
      assert.deepEqual(forwardedArgv, argv);
      return 7;
    }
  });

  assert.equal(result.code, 7);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('Phase 5 handles follow log streaming in Node', async () => {
  const { root } = await createProjectFixture();
  const cases = [
    ['logs', '--project-root', root, '--follow'],
    ['jobs', 'logs', '20260628-000000-abcdef', '--project-root', root, '--follow']
  ];

  for (const argv of cases) {
    const result = await runNode(argv, {
      cwd: root,
      runForwarder: async (forwardedArgv) => {
        assert.fail(`follow logs should not forward to Python: ${forwardedArgv.join(' ')}`);
        return 7;
      }
    });

    assert.equal(result.code, 0, argv.join(' '));
    assert.equal(result.stdout, 'line 1\nline 2\nline 3\n', argv.join(' '));
    assert.equal(result.stderr, '', argv.join(' '));
  }
});

test('Phase 3 reconciles completed running jobs from summary events', async () => {
  const { root, artifactDir, runtimeRoot } = await createProjectFixture();
  const jobPath = path.join(runtimeRoot, 'jobs', '20260628-000000-abcdef', 'job.json');
  const job = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(jobPath, 'utf8')));
  job.status = 'running';
  job.exit_code = null;
  job.finished_at = '';
  await writeFile(jobPath, JSON.stringify(job), 'utf8');
  await writeFile(job.event_log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n' + JSON.stringify({
    type: 'summary',
    artifact_dir: artifactDir,
    run_status: 'success'
  }) + '\n', 'utf8');

  const result = await runNode(['status', '--project-root', root, '--json'], { cwd: root });
  const payload = parseJsonLine(result.stdout);

  assert.equal(result.code, 0);
  assert.equal(payload.status, 'success');
  assert.equal(payload.exit_code, 0);
  assert.equal(payload.artifact_dir, artifactDir);
});

test('Phase 3 Node doctor reports missing runtime tools', async () => {
  const { root } = await createProjectFixture();
  const result = await runNode(['doctor', '--project-root', root, '--output', 'json'], {
    cwd: root,
    env: { PATH: '' }
  });
  const payload = parseJsonLine(result.stdout);
  const checks = Object.fromEntries(payload.checks.map((check) => [check.name, check]));

  assert.equal(result.code, 1);
  assert.equal(payload.ok, false);
  assert.equal(checks.mihomo.status, 'fail');
  assert.equal(checks.node_binaries.status, 'fail');
  assert.ok(checks.node_binaries.details.missing.includes('npx'));
});

test('Phase 3 artifacts list ignores non-artifact directories', async () => {
  const { root } = await createProjectFixture();
  await mkdir(path.join(root, 'artifacts', 'screenshots'), { recursive: true });
  await mkdir(path.join(root, 'artifacts', 'manual-runs'), { recursive: true });

  const result = await runNode(['artifacts', 'list', '--project-root', root], { cwd: root });
  const payload = parseJsonLine(result.stdout);

  assert.equal(result.code, 0);
  assert.deepEqual(payload.items.map((item) => item.artifact_name), ['20260628-000000']);
});

test('Phase 3 Node JSON outputs match Python for migrated fixture commands', async (t) => {
  const { root, artifactDir } = await createProjectFixture();
  const pythonVersion = runPython(['--version']);
  if (!pythonVersion) {
    t.skip('Python autovpn CLI is not available for parity comparison');
    return;
  }

  const commands = [
    ['profile', 'summary', '--project-root', root, '--json'],
    ['artifacts', 'latest', '--project-root', root],
    ['artifacts', 'list', '--project-root', root],
    ['artifacts', 'preview', artifactDir, '--project-root', root, '--json'],
    ['status', '--project-root', root, '--json'],
    ['jobs', 'list', '--project-root', root, '--json'],
    ['jobs', 'status', '20260628-000000-abcdef', '--project-root', root, '--json']
  ];

  for (const argv of commands) {
    const nodeResult = await runNode(argv, { cwd: root });
    const pythonResult = runPython(argv);
    assert.ok(pythonResult, argv.join(' '));
    assert.equal(nodeResult.code, pythonResult.status, argv.join(' '));
    assert.equal(nodeResult.stderr, '', argv.join(' '));
    assert.equal(pythonResult.stderr, '', argv.join(' '));
    assert.deepEqual(normalize(parseJsonLine(nodeResult.stdout)), normalize(parseJsonLine(pythonResult.stdout)), argv.join(' '));
  }
});

test('Phase 3 Node log outputs match Python for migrated fixture commands', async (t) => {
  const { root } = await createProjectFixture();
  const pythonVersion = runPython(['--version']);
  if (!pythonVersion) {
    t.skip('Python autovpn CLI is not available for parity comparison');
    return;
  }

  const commands = [
    ['logs', '--project-root', root, '--tail', '2'],
    ['jobs', 'logs', '20260628-000000-abcdef', '--project-root', root, '--tail', '2']
  ];

  for (const argv of commands) {
    const nodeResult = await runNode(argv, { cwd: root });
    const pythonResult = runPython(argv);
    assert.ok(pythonResult, argv.join(' '));
    assert.equal(nodeResult.code, pythonResult.status, argv.join(' '));
    assert.equal(nodeResult.stderr, '', argv.join(' '));
    assert.equal(pythonResult.stderr, '', argv.join(' '));
    assert.equal(nodeResult.stdout, pythonResult.stdout, argv.join(' '));
  }
});
