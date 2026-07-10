import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCliShell } from '../dist/cli/main.js';
import { normalizeEvent, parseEventLine } from '../dist/events/schema.js';
import { NodeBackend } from '../dist/backend/node-backend.js';
import { selectBackend } from '../dist/backend/select-backend.js';

const require = createRequire(import.meta.url);

function vmessLink(name, address) {
  return `vmess://${Buffer.from(JSON.stringify({
    v: 2,
    ps: name,
    add: address,
    port: '443',
    id: '11111111-1111-1111-1111-111111111111',
    aid: '0',
    scy: 'auto',
    net: 'ws',
    type: 'dtls',
    host: address,
    path: '/',
    tls: 'tls',
    sni: address
  }), 'utf8').toString('base64url')}`;
}

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

test('backend event schema normalizes Python JSONL event lines', () => {
  const event = parseEventLine('{"type":"stage","stage":"speedtest","status":"running"}');

  assert.deepEqual(event, {
    type: 'stage',
    stage: 'speedtest',
    status: 'running'
  });
  assert.deepEqual(normalizeEvent({ type: 'summary', run_status: 'success', counts: { raw_links: 2 } }), {
    type: 'summary',
    run_status: 'success',
    counts: { raw_links: 2 }
  });
});

test('backend event schema rejects invalid event envelopes', () => {
  assert.throws(() => parseEventLine('not json'), /Invalid backend event JSON/);
  assert.throws(() => normalizeEvent({ message: 'missing type' }), /Backend event is missing string type/);
});

test('high-risk CLI commands are executed through backend adapter', async () => {
  const io = createIo();
  const backendCalls = [];
  const directForwarderCalls = [];

  const code = await runCliShell(['run', '--project-root', '.', '--skip-deploy', '--skip-verify', '--output', 'jsonl'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async (argv) => {
      directForwarderCalls.push(argv);
      return 99;
    },
    createBackend: () => ({
      executeCli: async (argv) => {
        backendCalls.push(argv);
        return 5;
      }
    })
  });

  assert.equal(code, 5);
  assert.deepEqual(directForwarderCalls, []);
  assert.deepEqual(backendCalls, [['run', '--project-root', '/repo', '--skip-deploy', '--skip-verify', '--output', 'jsonl']]);
});

test('profile show is handled by Node shell without backend executeCli', async () => {
  const root = await mkdir(path.join(os.tmpdir(), `autovpn-profile-show-${Date.now()}`), { recursive: true });
  const profilePath = path.join(root, 'profile.toml');
  await writeFile(profilePath, [
    '[sources.leiting]',
    'enabled = true',
    'url = "https://source.example"',
    'key = "secret-key"',
    '',
    '[deploy]',
    'project_name = "sub-nodes"',
    'pages_project_url = "https://sub-nodes.pages.dev"'
  ].join('\n'), 'utf8');
  const io = createIo();
  let executeCliCalled = false;

  const code = await runCliShell(['profile', 'show', '--project-root', root], {
    packageVersion: '1.4.0',
    cwd: root,
    env: { PATH: '/bin', VPN_AUTOMATION_PROFILE_PATH: profilePath },
    io,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(executeCliCalled, false);
  const payload = JSON.parse(io.stdout);
  assert.equal(payload.sources.leiting.key, 'secret-key');
  assert.equal(payload.deploy.project_name, 'sub-nodes');
  assert.equal(payload.paths.profile_path, profilePath);
  assert.equal(path.basename(payload.workspace.project_root), path.basename(root));
  assert.equal(io.stderr, '');
});

test('profile without subcommand returns usage error before backend executeCli', async () => {
  const io = createIo();
  let executeCliCalled = false;

  const code = await runCliShell(['profile'], {
    packageVersion: '1.4.0',
    cwd: '/repo',
    env: { PATH: '/bin' },
    io,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      }
    })
  });

  assert.equal(code, 2);
  assert.equal(executeCliCalled, false);
  assert.equal(io.stdout, '');
  assert.match(io.stderr, /profile subcommand must be one of: show, save, summary/);
});

test('artifact and job commands validate required subcommands before backend executeCli', async () => {
  const cases = [
    { argv: ['artifacts'], message: /artifacts subcommand must be one of: latest, list, preview/ },
    { argv: ['jobs'], message: /jobs subcommand must be one of: list, status, logs, stop, resume, retry/ },
    { argv: ['jobs', 'retry', '--stage', 'render'], message: /jobs retry requires --artifact-dir/ },
    { argv: ['jobs', 'retry', '--artifact-dir', '/tmp/artifact'], message: /jobs retry requires --stage/ },
    { argv: ['jobs', 'resume'], message: /jobs resume requires job_id/ }
  ];

  for (const item of cases) {
    const io = createIo();
    let executeCliCalled = false;
    const code = await runCliShell(item.argv, {
      packageVersion: '1.4.0',
      cwd: '/repo',
      env: { PATH: '/bin' },
      io,
      createBackend: () => ({
        kind: 'node',
        executeCli: async () => {
          executeCliCalled = true;
          return 5;
        }
      })
    });

    assert.equal(code, 2, item.argv.join(' '));
    assert.equal(executeCliCalled, false, item.argv.join(' '));
    assert.match(io.stderr, item.message, item.argv.join(' '));
  }
});

test('profile save is handled by Node shell without installing Python backend', async () => {
  const root = await mkdir(path.join(os.tmpdir(), `autovpn-profile-save-${Date.now()}`), { recursive: true });
  const profilePath = path.join(root, 'profile.toml');
  const io = createIo();
  let executeCliCalled = false;

  const code = await runCliShell(['profile', 'save', '--project-root', root], {
    packageVersion: '1.4.0',
    cwd: root,
    env: { PATH: '/bin', VPN_AUTOMATION_PROFILE_PATH: profilePath },
    io,
    readStdin: async () => JSON.stringify({
      sources: {
        leiting: { enabled: true, url: 'https://source.example', key: 'secret-key' }
      },
      deploy: { project_name: 'sub-nodes', pages_project_url: 'https://sub-nodes.pages.dev' }
    }),
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(executeCliCalled, false);
  const payload = JSON.parse(io.stdout);
  assert.equal(payload.sources.leiting.key, 'secret-key');
  assert.equal(payload.deploy.project_name, 'sub-nodes');
  assert.match(await readFile(profilePath, 'utf8'), /project_name = "sub-nodes"/);
  assert.equal(io.stderr, '');
});

test('foreground run streams Node backend events when explicitly selected', async () => {
  const io = createIo();
  let executeCliCalled = false;

  const code = await runCliShell(['run', '--project-root', '.', '--skip-deploy', '--skip-verify', '--output', 'jsonl'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      },
      async *run(options) {
        yield { type: 'run_started', artifact_dir: '/repo/artifacts/1', skip_deploy: options.skipDeploy, skip_verify: options.skipVerify };
        yield { type: 'summary', artifact_dir: '/repo/artifacts/1', run_status: 'success' };
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(executeCliCalled, false);
  assert.deepEqual(io.stdout.trim().split(/\n/).map((line) => JSON.parse(line)), [
    { type: 'run_started', artifact_dir: '/repo/artifacts/1', skip_deploy: true, skip_verify: true },
    { type: 'summary', artifact_dir: '/repo/artifacts/1', run_status: 'success' }
  ]);
  assert.equal(io.stderr, '');
});

test('foreground run renders Node backend human events', async () => {
  const io = createIo();

  const code = await runCliShell(['run', '--project-root', '.', '--skip-deploy', '--skip-verify', '--output', 'human'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => 5,
      async *run() {
        yield { type: 'stage', stage: 'extract', status: 'success' };
        yield { type: 'summary', artifact_dir: '/repo/artifacts/1', run_status: 'success' };
      }
    })
  });

  assert.equal(code, 0);
  assert.match(io.stdout, /\[extract\] success/);
  assert.match(io.stdout, /summary: success \/repo\/artifacts\/1/);
  assert.equal(io.stderr, '');
});

test('foreground Node run passes event and human log paths to backend', async () => {
  const io = createIo();
  const seen = [];

  const code = await runCliShell([
    'run',
    '--project-root',
    '.',
    '--skip-deploy',
    '--skip-verify',
    '--output',
    'jsonl',
    '--event-log',
    '/tmp/events.jsonl',
    '--human-log',
    '/tmp/human.log'
  ], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => 5,
      async *run(options) {
        seen.push(options);
        yield { type: 'summary', artifact_dir: '/repo/artifacts/1', run_status: 'success' };
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(seen[0].eventLog, '/tmp/events.jsonl');
  assert.equal(seen[0].humanLog, '/tmp/human.log');
});

test('foreground Node retry-stage streams backend adapter events', async () => {
  const io = createIo();
  let executeCliCalled = false;
  const seen = [];

  const code = await runCliShell([
    'retry-stage',
    '--project-root',
    '.',
    '--artifact-dir',
    '/tmp/artifact',
    '--stage',
    'deploy',
    '--output',
    'jsonl',
    '--event-log',
    '/tmp/events.jsonl',
    '--human-log',
    '/tmp/human.log'
  ], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      },
      async *retryStage(options) {
        seen.push(options);
        yield { type: 'stage', stage: options.stage, status: 'running' };
        yield { type: 'summary', artifact_dir: '/repo/artifacts/retry', run_status: 'success' };
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(executeCliCalled, false);
  assert.deepEqual(seen, [{
    projectRoot: '/repo',
    artifactDir: '/tmp/artifact',
    stage: 'deploy',
    output: 'jsonl',
    eventLog: '/tmp/events.jsonl',
    humanLog: '/tmp/human.log'
  }]);
  assert.deepEqual(io.stdout.trim().split(/\n/).map((line) => JSON.parse(line)), [
    { type: 'stage', stage: 'deploy', status: 'running' },
    { type: 'summary', artifact_dir: '/repo/artifacts/retry', run_status: 'success' }
  ]);
  assert.equal(io.stderr, '');
});

test('foreground Node resume streams backend adapter events', async () => {
  const io = createIo();
  let executeCliCalled = false;
  const seen = [];

  const code = await runCliShell([
    'resume',
    'pipeline',
    '--project-root',
    '.',
    '--session',
    '/tmp/session',
    '--output',
    'jsonl',
    '--event-log',
    '/tmp/events.jsonl',
    '--human-log',
    '/tmp/human.log'
  ], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      },
      async *resume(options) {
        seen.push(options);
        yield { type: 'stage', stage: 'resume', status: 'running' };
        yield { type: 'summary', artifact_dir: '/repo/artifacts/resume', run_status: 'success' };
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(executeCliCalled, false);
  assert.deepEqual(seen, [{
    projectRoot: '/repo',
    mode: 'pipeline',
    session: '/tmp/session',
    output: 'jsonl',
    eventLog: '/tmp/events.jsonl',
    humanLog: '/tmp/human.log'
  }]);
  assert.deepEqual(io.stdout.trim().split(/\n/).map((line) => JSON.parse(line)), [
    { type: 'stage', stage: 'resume', status: 'running' },
    { type: 'summary', artifact_dir: '/repo/artifacts/resume', run_status: 'success' }
  ]);
  assert.equal(io.stderr, '');
});

test('foreground Node resume supports speedtest mode and human output', async () => {
  const io = createIo();
  const seen = [];

  const code = await runCliShell([
    'resume',
    'speedtest',
    '--project-root',
    '.',
    '--session',
    '/tmp/session',
    '--output',
    'human'
  ], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => 5,
      async *resume(options) {
        seen.push(options);
        yield { type: 'stage', stage: 'speedtest', status: 'running' };
        yield { type: 'summary', artifact_dir: '/repo/artifacts/resume-speedtest', run_status: 'success' };
      }
    })
  });

  assert.equal(code, 0);
  assert.deepEqual(seen, [{
    projectRoot: '/repo',
    mode: 'speedtest',
    session: '/tmp/session',
    output: 'human',
    eventLog: undefined,
    humanLog: undefined
  }]);
  assert.match(io.stdout, /\[speedtest\] running/);
  assert.match(io.stdout, /summary: success \/repo\/artifacts\/resume-speedtest/);
  assert.equal(io.stderr, '');
});

test('foreground Node retry-stage supports human output', async () => {
  const io = createIo();

  const code = await runCliShell([
    'retry-stage',
    '--project-root',
    '.',
    '--artifact-dir',
    '/tmp/artifact',
    '--stage',
    'verify',
    '--output',
    'human'
  ], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => 5,
      async *retryStage() {
        yield { type: 'stage', stage: 'verify', status: 'running' };
        yield { type: 'summary', artifact_dir: '/repo/artifacts/retry-human', run_status: 'success' };
      }
    })
  });

  assert.equal(code, 0);
  assert.match(io.stdout, /\[verify\] running/);
  assert.match(io.stdout, /summary: success \/repo\/artifacts\/retry-human/);
  assert.equal(io.stderr, '');
});

test('foreground Node resume rejects invalid subcommands and missing session before adapter dispatch', async () => {
  for (const argv of [
    ['resume', 'typo', '--project-root', '.', '--session', '/tmp/session', '--output', 'jsonl'],
    ['resume', 'pipeline', '--project-root', '.', '--output', 'jsonl']
  ]) {
    const io = createIo();
    let adapterCalled = false;
    const code = await runCliShell(argv, {
      packageVersion: '1.3.0',
      cwd: '/repo',
      io,
      runForwarder: async () => 99,
      createBackend: () => ({
        kind: 'node',
        executeCli: async () => 5,
        async *resume() {
          adapterCalled = true;
          yield { type: 'summary', run_status: 'success' };
        }
      })
    });

    assert.equal(code, 2, argv.join(' '));
    assert.equal(adapterCalled, false, argv.join(' '));
    assert.match(io.stderr, /autovpn:/);
  }
});

test('foreground Node retry-stage rejects missing required options before adapter dispatch', async () => {
  for (const argv of [
    ['retry-stage', '--project-root', '.', '--stage', 'deploy', '--output', 'jsonl'],
    ['retry-stage', '--project-root', '.', '--artifact-dir', '/tmp/artifact', '--output', 'jsonl']
  ]) {
    const io = createIo();
    let adapterCalled = false;
    const code = await runCliShell(argv, {
      packageVersion: '1.3.0',
      cwd: '/repo',
      io,
      runForwarder: async () => 99,
      createBackend: () => ({
        kind: 'node',
        executeCli: async () => 5,
        async *retryStage() {
          adapterCalled = true;
          yield { type: 'summary', run_status: 'success' };
        }
      })
    });

    assert.equal(code, 2, argv.join(' '));
    assert.equal(adapterCalled, false, argv.join(' '));
    assert.match(io.stderr, /autovpn:/);
  }
});

test('foreground Node run redacts raw backend errors written to stderr', async () => {
  const io = createIo();

  const code = await runCliShell(['run', '--project-root', '.', '--skip-deploy', '--skip-verify', '--output', 'jsonl'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => 5,
      async *run() {
        yield { type: 'run_failed', error: 'Error: boom token=<redacted> serect_key=<redacted> vmess://<redacted>' };
        throw new Error('boom token=SECRET serect_key=QUERY vmess://abcdef');
      }
    })
  });

  assert.equal(code, 1);
  assert.match(io.stdout, /token=<redacted>/);
  assert.match(io.stderr, /token=<redacted>/);
  assert.match(io.stderr, /serect_key=<redacted>/);
  assert.match(io.stderr, /vmess:\/\/<redacted>/);
  assert.doesNotMatch(io.stderr, /SECRET|QUERY|vmess:\/\/abcdef/);
});

test('Node backend allows detached run through the Node job manager', async () => {
  const io = createIo();
  let executeCliCalled = false;
  const spawns = [];
  const runtimeRoot = path.join(os.tmpdir(), `autovpn-node-detached-runtime-${Date.now()}-run`);

  const code = await runCliShell(['run', '--project-root', '.', '--skip-deploy', '--skip-verify', '--detach', '--json'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    env: {
      AUTOVPN_BACKEND: 'node',
      AUTOVPN_PYTHON_CLI: '/venv/bin/autovpn',
      VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot
    },
    io,
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 3456;
      child.unref = () => {};
      return child;
    },
    now: () => '2026-07-01T00:00:00+00:00',
    jobId: () => '20260701-000000-node-detached',
    jobToken: () => '1'.repeat(64),
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      }
    })
  });

  const payload = JSON.parse(io.stdout);
  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.job_id, '20260701-000000-node-detached');
  assert.equal(payload.pid, 3456);
  assert.equal(payload.options.skip_deploy, true);
  assert.equal(payload.options.skip_verify, true);
  assert.equal(executeCliCalled, false);
  assert.equal(spawns[0].command, process.execPath);
  assert.match(spawns[0].args[0], /bin[\\/]autovpn\.mjs$/);
  assert.deepEqual(spawns[0].args.slice(1, 10), [
    'run', '--project-root', '/repo', '--output', 'jsonl', '--internal-job-token', '1'.repeat(64), '--event-log', payload.event_log
  ]);
});

test('Node backend allows detached retry through the Node job manager', async () => {
  const io = createIo();
  const spawns = [];
  const runtimeRoot = path.join(os.tmpdir(), `autovpn-node-detached-runtime-${Date.now()}-retry`);

  const code = await runCliShell(['jobs', 'retry', '--project-root', '.', '--artifact-dir', '/repo/artifacts/1', '--stage', 'deploy', '--detach', '--json'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    env: {
      AUTOVPN_BACKEND: 'node',
      AUTOVPN_PYTHON_CLI: '/venv/bin/autovpn',
      VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot
    },
    io,
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 4567;
      child.unref = () => {};
      return child;
    },
    now: () => '2026-07-01T00:01:00+00:00',
    jobId: () => '20260701-000100-node-retry',
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => 5
    })
  });

  const payload = JSON.parse(io.stdout);
  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.kind, 'retry');
  assert.equal(payload.pid, 4567);
  assert.equal(payload.retry.stage, 'deploy');
  assert.equal(spawns[0].command, process.execPath);
  assert.match(spawns[0].args[0], /bin[\\/]autovpn\.mjs$/);
  assert.deepEqual(spawns[0].args.slice(1, 8), ['retry-stage', '--project-root', '/repo', '--artifact-dir', '/repo/artifacts/1', '--stage', 'deploy']);
});

test('non-detached resume and retry commands are executed through backend adapter', async () => {
  const cases = [
    ['resume', 'pipeline', '--project-root', '.', '--session', '/tmp/session', '--output', 'jsonl'],
    ['retry-stage', '--project-root', '.', '--artifact-dir', '/tmp/artifact', '--stage', 'deploy', '--output', 'jsonl']
  ];

  for (const argv of cases) {
    const io = createIo();
    const backendCalls = [];
    const code = await runCliShell(argv, {
      packageVersion: '1.3.0',
      cwd: '/repo',
      io,
      runForwarder: async () => 99,
      createBackend: () => ({
        executeCli: async (backendArgv) => {
          backendCalls.push(backendArgv);
          return 0;
        }
      })
    });

    assert.equal(code, 0, argv.join(' '));
    assert.equal(backendCalls.length, 1, argv.join(' '));
  }
});

test('selectBackend defaults to Node and rejects unknown backend values', () => {
  const backend = selectBackend({ env: {} });

  assert.equal(backend.kind, 'node');
  assert.ok(backend instanceof NodeBackend);
  assert.throws(() => selectBackend({ env: { AUTOVPN_BACKEND: 'unsupported' } }), /Unsupported AUTOVPN_BACKEND/);
});

test('selectBackend supports explicit Node backend selection', () => {
  const backend = selectBackend({ env: { AUTOVPN_BACKEND: 'node' } });

  assert.equal(backend.kind, 'node');
  assert.ok(backend instanceof NodeBackend);
});

test('NodeBackend allows full foreground runs through the Node deploy and verify stages', async () => {
  const projectRoot = await mkdir(path.join(os.tmpdir(), `autovpn-node-backend-full-run-${Date.now()}`, 'project'), { recursive: true });
  const events = [];
  const backend = new NodeBackend({
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime') },
    cwd: projectRoot
  });

  await assert.rejects(async () => {
    for await (const event of backend.run({ projectRoot, skipDeploy: false, skipVerify: false, output: 'jsonl' })) {
      events.push(event);
    }
  }, /profile\.toml/);

  assert.equal(events[0].type, 'run_started');
});

test('NodeBackend yields failure events before surfacing pipeline errors', async () => {
  const projectRoot = await mkdir(path.join(os.tmpdir(), `autovpn-node-backend-failure-${Date.now()}`, 'project'), { recursive: true });
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const events = [];
  const backend = new NodeBackend({
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    cwd: projectRoot
  });

  await assert.rejects(async () => {
    for await (const event of backend.run({ projectRoot, skipDeploy: true, skipVerify: true, output: 'jsonl' })) {
      events.push(event);
    }
  }, /profile\.toml/);

  assert.equal(events[0].type, 'run_started');
  assert.equal(events.at(-2).type, 'summary');
  assert.equal(events.at(-2).run_status, 'failed');
  assert.equal(events.at(-1).type, 'run_failed');
});

test('NodeBackend streams events before pipeline completion', async () => {
  const projectRoot = await mkdir(path.join(os.tmpdir(), `autovpn-node-backend-stream-${Date.now()}`, 'project'), { recursive: true });
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const backend = new NodeBackend({
    env: { VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot },
    cwd: projectRoot
  });

  const iterator = backend.run({ projectRoot, skipDeploy: true, skipVerify: true, output: 'jsonl' })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.type, 'run_started');
  await assert.rejects(async () => {
    while (!(await iterator.next()).done) {
      // consume
    }
  }, /profile\.toml/);
});

test('NodeBackend retryStage uses the native retry path instead of unsupported fallback', async () => {
  const projectRoot = await mkdir(path.join(os.tmpdir(), `autovpn-node-backend-retry-${Date.now()}`, 'project'), { recursive: true });
  const artifactDir = path.join(projectRoot, 'missing-artifact');
  const backend = new NodeBackend({
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime') },
    cwd: projectRoot
  });

  await assert.rejects(async () => {
    for await (const _event of backend.retryStage({ projectRoot, artifactDir, stage: 'render', output: 'jsonl' })) {
      // consume
    }
  }, /artifact dir not found/);
});

test('NodeBackend resume pipeline uses the native resume path instead of unsupported fallback', async () => {
  const projectRoot = await mkdir(path.join(os.tmpdir(), `autovpn-node-backend-resume-${Date.now()}`, 'project'), { recursive: true });
  const session = path.join(projectRoot, 'missing-session');
  const backend = new NodeBackend({
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime') },
    cwd: projectRoot
  });

  await assert.rejects(async () => {
    for await (const _event of backend.resume({ projectRoot, mode: 'pipeline', session, output: 'jsonl' })) {
      // consume
    }
  }, /session.json not found/);
});

test('NodeBackend resume speedtest uses the native resume path instead of unsupported fallback', async () => {
  const projectRoot = await mkdir(path.join(os.tmpdir(), `autovpn-node-backend-resume-speedtest-${Date.now()}`, 'project'), { recursive: true });
  const session = path.join(projectRoot, 'missing-session');
  const backend = new NodeBackend({
    env: { VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime') },
    cwd: projectRoot
  });

  await assert.rejects(async () => {
    for await (const _event of backend.resume({ projectRoot, mode: 'speedtest', session, output: 'jsonl' })) {
      // consume
    }
  }, /session.json not found/);
});

test('NodeBackend run resume-latest uses the latest incomplete run database', async () => {
  const projectRoot = await mkdir(path.join(os.tmpdir(), `autovpn-node-backend-resume-latest-${Date.now()}`, 'project'), { recursive: true });
  const runtimeRoot = path.join(projectRoot, '.runtime');
  const artifactsRoot = path.join(runtimeRoot, 'artifacts');
  const artifactDir = path.join(artifactsRoot, '20260701-010203');
  const link = vmessLink('resume-latest', 'resume.example');
  await mkdir(path.join(projectRoot, 'templates'), { recursive: true });
  await mkdir(path.join(projectRoot, 'state'), { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(projectRoot, 'pyproject.toml'), '[project]\nname = "fixture"\n', 'utf8');
  await writeFile(path.join(projectRoot, 'templates', 'vmess_node.js'), 'const MainData = `__MAIN_DATA__`;\n', 'utf8');
  await writeFile(path.join(projectRoot, 'state', 'profile.toml'), [
    'availability_targets = []',
    '',
    '[speed_test]',
    'min_download_mb_s = 1',
    'timeout_seconds = 20',
    'concurrency = 1',
    '',
    '[deploy]',
    'project_name = "fixture-project"',
    'subscription_url = "https://sub.example.invalid/?serect_key=fixture"',
    'pages_project_url = "https://fixture-project.pages.dev"',
    'secret_query = "serect_key=fixture"',
    '',
    '[worker_build]',
    'entry_filename = "_worker.js"',
    'bundle_subdir = "pages_bundle"',
    'manifest_filename = "manifest.json"',
    'emit_sidecar_modules = false',
    ''
  ].join('\n'), 'utf8');
  await writeFile(path.join(artifactDir, 'vpn_node_raw.txt'), `${link}\n`, 'utf8');
  await writeFile(path.join(artifactDir, 'vpn_node_deduped.txt'), `${link}\n`, 'utf8');
  await writeFile(path.join(artifactDir, 'vpn_node_speedtest.txt'), `${link}\n`, 'utf8');
  await writeFile(path.join(artifactDir, 'vpn_node_speedtest_report.json'), JSON.stringify([
    { link, reachable: true, average_download_mb_s: 2, latency_ms: 20, error: '' }
  ]), 'utf8');
  await writeFile(path.join(artifactDir, 'pipeline_report.json'), JSON.stringify({
    artifact_dir: artifactDir,
    stage_status: { speedtest: 'success' },
    counts: { speedtest_links: 1 },
    source_counts: {},
    deployment: {},
    retry_context: {},
    run_status: 'running',
    error: ''
  }), 'utf8');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(artifactDir, 'run.db'));
  db.exec(`
    CREATE TABLE runs (run_id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_dir TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE stage_events (stage_name TEXT NOT NULL, status TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO runs (artifact_dir, status) VALUES (?, ?)').run(artifactDir, 'running');
  db.prepare('INSERT INTO stage_events (stage_name, status) VALUES (?, ?)').run('speedtest', 'success');
  db.close();

  const backend = new NodeBackend({
    env: {
      AUTOVPN_NO_PYTHON: '1',
      VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot,
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    cwd: projectRoot
  });
  const events = [];

  for await (const event of backend.run({ projectRoot, resumeLatest: true, skipDeploy: true, skipVerify: true, output: 'jsonl' })) {
    events.push(event);
  }

  assert.equal(events[0].type, 'resume_latest_state');
  assert.equal(events[0].artifact_dir, artifactDir);
  assert.ok(events.some((event) => event.type === 'resume_pipeline_state'));
  assert.equal(events.at(-1).type, 'summary');
  assert.equal(events.at(-1).run_status, 'success');
  assert.equal(events.at(-1).stage_status.deploy, 'skipped');
  assert.equal(events.at(-1).stage_status.verify, 'skipped');
});
