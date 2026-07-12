import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCliShell } from '../../dist/cli/main.js';
import { createJobStore } from '../../dist/jobs/store.js';
import { startDetachedRun, stopManagedJob } from '../../dist/jobs/commands.js';
import { cmdlineMatchesJob, processMatchesJob, terminateProcessGroup } from '../../dist/jobs/process.js';
import { RunStore, readRunStatus } from '../../dist/pipeline/run-store.js';

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

async function createProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autovpn-node-jobs-'));
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "fixture"\n', 'utf8');
  process.env.VPN_AUTOMATION_RUNTIME_ROOT = path.join(root, '.auto-vpn');
  return root;
}

function jobsRoot() {
  return path.join(process.env.VPN_AUTOMATION_RUNTIME_ROOT, 'jobs');
}

function runtimeEnv(extra = {}) {
  return {
    ...process.env,
    ...extra
  };
}

function fakeSpawn(spawns, pid = 4321) {
  return (command, args, options) => {
    spawns.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = pid;
    child.unref = () => {
      child.unrefCalled = true;
    };
    return child;
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('Node job store creates Python-compatible job metadata and index', async () => {
  const projectRoot = await createProject();
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => '20260628-000000-node01' });

  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 1234,
    options: { skip_deploy: true, skip_verify: true, output_format: 'jsonl' }
  });

  const jobPayload = JSON.parse(await readFile(path.join(jobsRoot(), '20260628-000000-node01', 'job.json'), 'utf8'));
  const indexPayload = JSON.parse(await readFile(path.join(jobsRoot(), 'index.json'), 'utf8'));

  assert.equal(job.job_id, '20260628-000000-node01');
  assert.equal(jobPayload.schema_version, 1);
  assert.equal(jobPayload.status, 'running');
  assert.equal(jobPayload.pid, 1234);
  assert.equal(jobPayload.pgid, 1234);
  assert.equal(jobPayload.event_log, path.join(jobsRoot(), '20260628-000000-node01', 'events.jsonl'));
  assert.equal(jobPayload.human_log, path.join(jobsRoot(), '20260628-000000-node01', 'human.log'));
  assert.equal(indexPayload.latest_job_id, '20260628-000000-node01');
  assert.deepEqual(indexPayload.jobs.map((item) => item.job_id), ['20260628-000000-node01']);
});

test('default run --detach spawns the Node CLI worker', async () => {
  const projectRoot = await createProject();
  const spawns = [];
  const io = createIo();

  const code = await runCliShell(['run', '--project-root', projectRoot, '--skip-deploy', '--skip-verify', '--detach', '--json'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    env: runtimeEnv({ AUTOVPN_NO_PYTHON: '1' }),
    io,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        throw new Error('detached run should not be forwarded to backend.executeCli');
      }
    }),
    runForwarder: async () => {
      throw new Error('detached run should not use direct forwarder');
    },
    spawn: fakeSpawn(spawns, 6789),
    now: () => '2026-06-28T00:01:00+00:00',
    jobId: () => '20260628-000100-node-worker',
    jobToken: () => 'a'.repeat(64)
  });

  const payload = JSON.parse(io.stdout);
  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.job_id, '20260628-000100-node-worker');
  assert.equal(payload.pid, 6789);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.match(spawns[0].args[0], /bin[\\/]autovpn\.mjs$/);
  assert.deepEqual(spawns[0].args.slice(1), [
    'run', '--project-root', payload.project_root, '--output', 'jsonl', '--internal-job-token', 'a'.repeat(64), '--event-log', payload.event_log, '--human-log', payload.human_log, '--skip-deploy', '--skip-verify'
  ]);
});

test('detached run only forwards proxy flag when explicitly requested', async () => {
  const projectRoot = await createProject();
  const spawns = [];

  await startDetachedRun({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    outputFormat: 'jsonl',
    useProxy: true,
    proxyUrl: 'http://127.0.0.1:7897'
  }, {
    env: runtimeEnv({ AUTOVPN_NO_PYTHON: '1' }),
    spawn: fakeSpawn(spawns, 6790),
    now: () => '2026-06-28T00:01:00+00:00',
    jobId: () => 'proxy-node-worker'
  });

  assert.ok(spawns[0].args.includes('--proxy'));
  assert.equal(spawns[0].args.at(-1), 'http://127.0.0.1:7897');
});

test('Node job manager stop marks job stopped and targets process group', async () => {
  const projectRoot = await createProject();
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => '20260628-000000-node03' });
  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 2468,
    options: { output_format: 'jsonl' }
  });
  const signals = [];

  const stopped = await stopManagedJob(projectRoot, job.job_id, {
    timeoutMs: 0,
    now: () => '2026-06-28T00:00:01+00:00',
    isAlive: () => true,
    processMatchesJob: () => true,
    signalProcess: (target, signal) => {
      signals.push([target, signal]);
    }
  });

  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.signal, 'SIGTERM');
  assert.deepEqual(signals[0], [process.platform === 'win32' ? 2468 : -2468, 'SIGTERM']);
  assert.deepEqual(signals.at(-1), [process.platform === 'win32' ? 2468 : -2468, 'SIGKILL']);
});

test('Node job manager stop tolerates processes that exit before signal delivery', async () => {
  const projectRoot = await createProject();
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'vanished-job' });
  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 2468,
    options: { output_format: 'jsonl' }
  });

  const stopped = await stopManagedJob(projectRoot, job.job_id, {
    timeoutMs: 0,
    now: () => '2026-06-28T00:00:01+00:00',
    isAlive: () => true,
    processMatchesJob: () => true,
    signalProcess: () => {
      const error = new Error('kill ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
  });

  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.signal, 'SIGTERM');
});

test('Node job manager stop marks the active artifact stopped', async () => {
  const projectRoot = await createProject();
  const artifactDir = path.join(projectRoot, 'artifacts', 'stopping-run');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'pipeline_report.json'), JSON.stringify({
    run_status: 'running',
    stage_status: { extract: 'running', speedtest: 'pending' },
    error: ''
  }), 'utf8');
  const runStore = RunStore.open(path.join(artifactDir, 'run.db'));
  runStore.initializeRun('running');
  runStore.setStageStatus('extract', 'running');
  runStore.close();
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'stop-artifact-job' });
  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 2468,
    options: { output_format: 'jsonl' }
  });
  job.artifact_dir = artifactDir;
  store.writeJob(job);

  await stopManagedJob(projectRoot, job.job_id, {
    timeoutMs: 0,
    now: () => '2026-06-28T00:00:01+00:00',
    isAlive: () => true,
    processMatchesJob: () => true,
    signalProcess: () => {}
  });

  const report = JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8'));
  assert.equal(report.run_status, 'stopped');
  assert.equal(report.stage_status.extract, 'stopped');
  assert.match(report.error, /Stopped by user/);
  assert.equal(readRunStatus(path.join(artifactDir, 'run.db')), 'stopped');
});

test('Node job manager stop falls back to report when run.db is corrupt', async () => {
  const projectRoot = await createProject();
  const artifactDir = path.join(projectRoot, 'artifacts', 'corrupt-stop');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'run.db'), 'not sqlite', 'utf8');
  await writeFile(path.join(artifactDir, 'pipeline_report.json'), JSON.stringify({ run_status: 'running', stage_status: { extract: 'running' }, error: '' }));
  const store = createJobStore(projectRoot, { jobId: () => 'corrupt-stop-job' });
  const job = store.createRunningJob({ kind: 'run', command: ['/venv/bin/autovpn', 'run'], pid: 0, options: {} });
  job.artifact_dir = artifactDir;
  store.writeJob(job);

  const stopped = await stopManagedJob(projectRoot, job.job_id);

  assert.equal(stopped.status, 'stopped');
  assert.equal(JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8')).run_status, 'stopped');
});

test('Node job manager preserves completed sqlite truth when stop races completion', async () => {
  const projectRoot = await createProject();
  const artifactDir = path.join(projectRoot, 'artifacts', 'completed-race');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'pipeline_report.json'), JSON.stringify({ run_status: 'running', stage_status: {}, error: '' }));
  const runStore = RunStore.open(path.join(artifactDir, 'run.db'));
  runStore.initializeRun('success');
  runStore.close();
  const store = createJobStore(projectRoot, { jobId: () => 'completed-race-job' });
  const job = store.createRunningJob({ kind: 'run', command: ['/venv/bin/autovpn', 'run'], pid: 0, options: {} });
  job.artifact_dir = artifactDir;
  store.writeJob(job);

  const completed = await stopManagedJob(projectRoot, job.job_id);

  assert.equal(completed.status, 'success');
  assert.equal(completed.exit_code, 0);
  assert.equal(JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8')).run_status, 'success');
});

test('Node job manager stop refuses mismatched process metadata', async () => {
  const projectRoot = await createProject();
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'mismatch-job' });
  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 2468,
    options: { output_format: 'jsonl' }
  });

  await assert.rejects(
    () => stopManagedJob(projectRoot, job.job_id, {
      isAlive: () => true,
      processMatchesJob: () => false
    }),
    /command does not match AutoVPN job/
  );
});

test('process metadata guard distinguishes AutoVPN workers from unrelated Node processes', async () => {
  const projectRoot = await createProject();
  const entry = path.join(projectRoot, 'autovpn.mjs');
  const wrongEntry = path.join(projectRoot, 'other.mjs');
  const token = 'b'.repeat(64);
  const command = [process.execPath, entry, 'run', '--project-root', projectRoot, '--output', 'jsonl', '--internal-job-token', token];
  const actual = Buffer.from(`${command.join('\0')}\0`, 'utf8');

  assert.equal(cmdlineMatchesJob(actual, [process.execPath, wrongEntry, ...command.slice(2)]), false);
  assert.equal(cmdlineMatchesJob(actual, [process.execPath, entry, 'resume', ...command.slice(3)]), false);
  assert.equal(cmdlineMatchesJob(actual, command.slice(0, -2)), false);
  assert.equal(cmdlineMatchesJob(actual, [...command.slice(0, -1), 'c'.repeat(64)]), false);
  assert.equal(cmdlineMatchesJob(actual, command), true);
});

test('darwin and Windows process readers require the saved worker token and identity', async () => {
  const projectRoot = await createProject();
  const entry = path.join(projectRoot, 'autovpn.mjs');
  const token = 'd'.repeat(64);
  const command = [process.execPath, entry, 'run', '--project-root', projectRoot, '--internal-job-token', token];
  const rendered = command.join(' ');
  const readers = [
    { platform: 'darwin', executable: 'ps' },
    { platform: 'win32', executable: 'powershell.exe' }
  ];

  for (const reader of readers) {
    const calls = [];
    const spawnSync = (executable, args) => {
      calls.push([executable, args]);
      return { status: 0, stdout: rendered };
    };
    assert.equal(processMatchesJob(2468, command, { platform: reader.platform, spawnSync }), true);
    assert.equal(calls[0][0], reader.executable);
    assert.equal(processMatchesJob(2468, [...command.slice(0, -1), 'e'.repeat(64)], { platform: reader.platform, spawnSync }), false);
    assert.equal(processMatchesJob(2468, [process.execPath, path.join(projectRoot, 'other.mjs'), ...command.slice(2)], { platform: reader.platform, spawnSync }), false);
  }
});

test('production metadata guard recognizes a live worker on the host platform', async (t) => {
  if (!['linux', 'darwin'].includes(process.platform)) {
    t.skip('live process command reader integration runs on Linux and macOS');
    return;
  }
  const projectRoot = await createProject();
  const entry = path.join(projectRoot, 'autovpn.mjs');
  await writeFile(entry, 'setInterval(() => {}, 1000);\n', 'utf8');
  const command = [process.execPath, entry, 'run', '--project-root', projectRoot, '--output', 'jsonl', '--internal-job-token', 'f'.repeat(64)];
  const child = spawn(command[0], command.slice(1), { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  assert.equal(processMatchesJob(child.pid, [command[0], path.join(projectRoot, 'wrong.mjs'), ...command.slice(2)]), false);
  assert.equal(processMatchesJob(child.pid, command), true);
});

test('Windows process termination uses taskkill process tree mode', async () => {
  const calls = [];

  await terminateProcessGroup(2468, {
    platform: 'win32',
    timeoutMs: 0,
    isAlive: () => true,
    spawnSync: (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    }
  });

  assert.deepEqual(calls[0], ['taskkill', ['/pid', '2468', '/t']]);
  assert.deepEqual(calls.at(-1), ['taskkill', ['/pid', '2468', '/t', '/f']]);
});

test('top-level stop refuses to choose when multiple jobs are active', async () => {
  const projectRoot = await createProject();
  const ids = ['active-one', 'active-two'];
  for (const id of ids) {
    const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => id });
    store.createRunningJob({
      kind: 'run',
      command: ['/venv/bin/autovpn', 'run'],
      pid: id === 'active-one' ? process.pid : process.pid,
      options: { output_format: 'jsonl' }
    });
  }
  const io = createIo();

  const code = await runCliShell(['stop', '--project-root', projectRoot], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    io
  });

  assert.equal(code, 1);
  assert.match(io.stderr, /multiple active jobs/);
});

test('default jobs resume and retry detached spawn Node CLI workers', async () => {
  const projectRoot = await createProject();
  const sessionDir = path.join(jobsRoot(), 'source-node-job');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'session.json'), '{}\n', 'utf8');
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'source-node-job' });
  store.createRunningJob({
    kind: 'run',
    command: [process.execPath, 'autovpn.mjs', 'run'],
    pid: 1111,
    options: { session_dir: sessionDir, output_format: 'jsonl' }
  });
  const artifactDir = path.join(projectRoot, 'artifacts', '20260628-000000');
  await mkdir(artifactDir, { recursive: true });
  const spawns = [];

  const resume = await runCliShell(['jobs', 'resume', 'source-node-job', '--project-root', projectRoot, '--detach', '--json'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    env: runtimeEnv({ AUTOVPN_NO_PYTHON: '1' }),
    io: createIo(),
    createBackend: () => ({ kind: 'node', executeCli: async () => 99 }),
    spawn: fakeSpawn(spawns, 5555),
    now: () => '2026-06-28T00:00:01+00:00',
    jobId: () => 'node-resume-job'
  });
  const retry = await runCliShell(['jobs', 'retry', '--project-root', projectRoot, '--artifact-dir', artifactDir, '--stage', 'deploy', '--detach', '--json'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    env: runtimeEnv({ AUTOVPN_NO_PYTHON: '1' }),
    io: createIo(),
    createBackend: () => ({ kind: 'node', executeCli: async () => 99 }),
    spawn: fakeSpawn(spawns, 6666),
    now: () => '2026-06-28T00:00:02+00:00',
    jobId: () => 'node-retry-job'
  });

  assert.equal(resume, 0);
  assert.equal(retry, 0);
  assert.equal(spawns[0].command, process.execPath);
  assert.match(spawns[0].args[0], /bin[/\\]autovpn\.mjs$/);
  assert.deepEqual(spawns[0].args.slice(1, 4), ['resume', 'pipeline', '--project-root']);
  assert.equal(spawns[0].args[5], '--session');
  assert.equal(spawns[1].command, process.execPath);
  assert.match(spawns[1].args[0], /bin[/\\]autovpn\.mjs$/);
  assert.deepEqual(spawns[1].args.slice(1, 3), ['retry-stage', '--project-root']);
  assert.deepEqual(spawns[1].args.slice(4, 8), ['--artifact-dir', artifactDir, '--stage', 'deploy']);
});

test('default jobs resume detached uses Node resume-latest worker for run jobs without session metadata', async () => {
  const projectRoot = await createProject();
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'source-run' });
  store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 1111,
    options: { skip_deploy: true, skip_verify: true, output_format: 'jsonl' }
  });
  const spawns = [];
  const io = createIo();

  const code = await runCliShell(['jobs', 'resume', 'source-run', '--project-root', projectRoot, '--detach', '--json'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    env: runtimeEnv({ AUTOVPN_NO_PYTHON: '1' }),
    io,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        throw new Error('detached resume-latest should not call backend.executeCli');
      }
    }),
    spawn: fakeSpawn(spawns, 4444),
    now: () => '2026-06-28T00:00:01+00:00',
    jobId: () => 'resume-latest-job'
  });

  const payload = JSON.parse(io.stdout);
  assert.equal(code, 0);
  assert.equal(payload.kind, 'run');
  assert.equal(payload.options.source_job_id, 'source-run');
  assert.equal(payload.options.resume_latest, true);
  assert.equal(payload.options.skip_deploy, true);
  assert.equal(payload.options.skip_verify, true);
  assert.equal(spawns[0].command, process.execPath);
  assert.match(spawns[0].args[0], /bin[/\\]autovpn\.mjs$/);
  assert.ok(spawns[0].args.includes('--resume-latest'));
});

test('default jobs retry without detach streams through Node backend retryStage', async () => {
  const projectRoot = await createProject();
  const artifactDir = path.join(projectRoot, 'artifacts', '20260628-000000');
  await mkdir(artifactDir, { recursive: true });
  const io = createIo();
  let executeCliCalled = false;
  const retryCalls = [];

  const code = await runCliShell(['jobs', 'retry', '--project-root', projectRoot, '--artifact-dir', artifactDir, '--stage', 'render', '--output', 'jsonl'], {
    cwd: projectRoot,
    packageVersion: '1.4.0',
    env: runtimeEnv({ AUTOVPN_NO_PYTHON: '1' }),
    io,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      },
      async *retryStage(options) {
        retryCalls.push(options);
        yield { type: 'summary', run_status: 'success', artifact_dir: artifactDir };
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(executeCliCalled, false);
  assert.equal(retryCalls[0].artifactDir, artifactDir);
  assert.equal(retryCalls[0].stage, 'render');
  assert.deepEqual(JSON.parse(io.stdout), { type: 'summary', run_status: 'success', artifact_dir: artifactDir });
});

test('default jobs resume without detach streams through Node backend resume', async () => {
  const projectRoot = await createProject();
  const sessionDir = path.join(jobsRoot(), 'source-resume-job');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'session.json'), '{}\n', 'utf8');
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'source-resume-job' });
  store.createRunningJob({
    kind: 'run',
    command: [process.execPath, 'autovpn.mjs', 'run'],
    pid: 1111,
    options: { session_dir: sessionDir, output_format: 'jsonl' }
  });
  const io = createIo();
  let executeCliCalled = false;
  const resumeCalls = [];

  const code = await runCliShell(['jobs', 'resume', 'source-resume-job', '--project-root', projectRoot, '--output', 'jsonl'], {
    cwd: projectRoot,
    packageVersion: '1.4.0',
    env: runtimeEnv({ AUTOVPN_NO_PYTHON: '1' }),
    io,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      },
      async *resume(options) {
        resumeCalls.push(options);
        yield { type: 'summary', run_status: 'success', artifact_dir: '/tmp/resumed' };
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(executeCliCalled, false);
  assert.equal(resumeCalls[0].mode, 'pipeline');
  assert.equal(resumeCalls[0].session, sessionDir);
  assert.deepEqual(JSON.parse(io.stdout), { type: 'summary', run_status: 'success', artifact_dir: '/tmp/resumed' });
});

test('logs --follow is handled by Node for completed jobs', async () => {
  const projectRoot = await createProject();
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'completed-job' });
  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 0,
    options: { output_format: 'jsonl' }
  });
  job.status = 'success';
  job.finished_at = '2026-06-28T00:00:01+00:00';
  job.exit_code = 0;
  store.writeJob(job);
  await writeFile(job.human_log, 'one\ntwo\nthree\n', 'utf8');
  const io = createIo();
  const backendCalls = [];

  const code = await runCliShell(['logs', '--project-root', projectRoot, '--tail', '2', '--follow'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    io,
    createBackend: () => ({ executeCli: async (argv) => { backendCalls.push(argv); return 99; } })
  });

  assert.equal(code, 0);
  assert.equal(io.stdout, 'two\nthree\n');
  assert.deepEqual(backendCalls, []);
});

test('logs --follow writes new chunks before the job finishes', async () => {
  const projectRoot = await createProject();
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'streaming-job' });
  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: process.pid,
    options: { output_format: 'jsonl' }
  });
  await writeFile(job.human_log, '开始\n', 'utf8');
  const io = createIo();
  const writes = [];
  io.writeStdout = (chunk) => {
    writes.push(chunk);
    io.stdout += chunk;
  };
  let slept = false;

  const codePromise = runCliShell(['logs', '--project-root', projectRoot, '--tail', '1', '--follow'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    io,
    createBackend: () => ({ executeCli: async () => 99 }),
    sleep: async () => {
      if (!slept) {
        slept = true;
        await writeFile(job.human_log, '开始\n下一步\n', 'utf8');
        const current = store.loadJob('streaming-job');
        current.status = 'success';
        current.pid = 0;
        store.writeJob(current);
      }
    }
  });

  await waitFor(() => writes.length > 0);
  assert.equal(writes[0], '开始\n');
  const code = await codePromise;
  assert.equal(code, 0);
  assert.deepEqual(writes, ['开始\n', '下一步\n']);
});

test('crash recovery reconciles dead running jobs from pipeline report', async () => {
  const projectRoot = await createProject();
  const artifactDir = path.join(projectRoot, 'artifacts', 'finished-run');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'pipeline_report.json'), JSON.stringify({ run_status: 'success', error: '' }), 'utf8');
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'crashed-job' });
  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 0,
    options: { output_format: 'jsonl' }
  });
  await writeFile(job.event_log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n', 'utf8');
  const io = createIo();

  const code = await runCliShell(['jobs', 'status', 'crashed-job', '--project-root', projectRoot, '--json'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    io
  });

  const payload = JSON.parse(io.stdout);
  assert.equal(code, 0);
  assert.equal(payload.status, 'success');
  assert.equal(payload.exit_code, 0);
});

test('crash recovery does not treat a half-written running stage report as success', async () => {
  const projectRoot = await createProject();
  const artifactDir = path.join(projectRoot, 'artifacts', 'half-written-run');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'pipeline_report.json'), JSON.stringify({
    run_status: 'success',
    stage_status: { doctor: 'success', extract: 'running' },
    error: ''
  }), 'utf8');
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'half-written-job' });
  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 0,
    options: { output_format: 'jsonl' }
  });
  await writeFile(job.event_log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n', 'utf8');
  const io = createIo();

  const code = await runCliShell(['jobs', 'status', 'half-written-job', '--project-root', projectRoot, '--json'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    io
  });

  const payload = JSON.parse(io.stdout);
  assert.equal(code, 0);
  assert.equal(payload.status, 'failed');
  assert.equal(payload.exit_code, 1);
  assert.match(payload.last_error, /process exited without terminal status/);
});

test('crash recovery reconciles dead running jobs from run database', async () => {
  const projectRoot = await createProject();
  const artifactDir = path.join(projectRoot, 'artifacts', 'run-db-finished');
  await mkdir(artifactDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(artifactDir, 'run.db'));
  db.exec('CREATE TABLE runs (run_id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_dir TEXT NOT NULL, status TEXT NOT NULL)');
  db.prepare('INSERT INTO runs (artifact_dir, status) VALUES (?, ?)').run(artifactDir, 'success');
  db.close();
  const store = createJobStore(projectRoot, { now: () => '2026-06-28T00:00:00+00:00', jobId: () => 'run-db-crashed-job' });
  const job = store.createRunningJob({
    kind: 'run',
    command: ['/venv/bin/autovpn', 'run'],
    pid: 0,
    options: { output_format: 'jsonl' }
  });
  await writeFile(job.event_log, JSON.stringify({ type: 'run_started', artifact_dir: artifactDir }) + '\n', 'utf8');
  const io = createIo();

  const code = await runCliShell(['jobs', 'status', 'run-db-crashed-job', '--project-root', projectRoot, '--json'], {
    cwd: projectRoot,
    packageVersion: '1.3.0',
    io
  });

  const payload = JSON.parse(io.stdout);
  assert.equal(code, 0);
  assert.equal(payload.status, 'success');
  assert.equal(payload.exit_code, 0);
});
