import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCliShell } from '../dist/cli/main.js';
import { normalizeEvent, parseEventLine } from '../dist/events/schema.js';
import { NodeBackend } from '../dist/backend/node-backend.js';
import { PythonBackend } from '../dist/backend/python-backend.js';
import { selectBackend } from '../dist/backend/select-backend.js';

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

test('PythonBackend executeCli owns Python process forwarding', async () => {
  const forwarded = [];
  const backend = new PythonBackend({
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 7;
    }
  });

  const code = await backend.executeCli(['run', '--project-root', '/repo', '--output', 'jsonl']);

  assert.equal(code, 7);
  assert.deepEqual(forwarded, [['run', '--project-root', '/repo', '--output', 'jsonl']]);
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

test('foreground run keeps Python backend executeCli forwarding by default', async () => {
  const io = createIo();
  const backendCalls = [];

  const code = await runCliShell(['run', '--project-root', '.', '--skip-deploy', '--skip-verify', '--output', 'jsonl'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'python',
      executeCli: async (argv) => {
        backendCalls.push(argv);
        return 6;
      },
      async *run() {
        throw new Error('python run should not be consumed by shell');
      }
    })
  });

  assert.equal(code, 6);
  assert.deepEqual(backendCalls, [['run', '--project-root', '/repo', '--skip-deploy', '--skip-verify', '--output', 'jsonl']]);
  assert.equal(io.stdout, '');
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

test('Node backend rejects detached run before native Python job handling', async () => {
  const io = createIo();
  let executeCliCalled = false;

  const code = await runCliShell(['run', '--project-root', '.', '--skip-deploy', '--skip-verify', '--detach', '--json'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    io,
    runForwarder: async () => 99,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => {
        executeCliCalled = true;
        return 5;
      }
    })
  });

  assert.equal(code, 1);
  assert.equal(executeCliCalled, false);
  assert.match(io.stderr, /Node backend detached runs are not available yet/);
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

test('low-risk Python fallbacks are executed through backend adapter', async () => {
  const io = createIo();
  const directForwarderCalls = [];
  const backendCalls = [];

  const code = await runCliShell(['doctor', '--project-root', '.', '--output', 'json'], {
    packageVersion: '1.3.0',
    cwd: '/repo',
    env: { AUTOVPN_DOCTOR_BACKEND: 'python' },
    io,
    runForwarder: async (argv) => {
      directForwarderCalls.push(argv);
      return 99;
    },
    createBackend: () => ({
      executeCli: async (argv) => {
        backendCalls.push(argv);
        return 6;
      }
    })
  });

  assert.equal(code, 6);
  assert.deepEqual(directForwarderCalls, []);
  assert.deepEqual(backendCalls, [['doctor', '--project-root', '/repo', '--output', 'json']]);
});

test('PythonBackend parses real JSON job payloads for job metadata methods', async () => {
  const spawns = [];
  const backend = new PythonBackend({
    resolvePythonCli: () => ({ command: '/opt/autovpn/bin/autovpn', args: [] }),
    spawn: (command, args) => {
      spawns.push([command, args]);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', '{"ok":true,"job_id":"job-1","pid":123,"status":"running"}\n');
        child.stdout.emit('end');
        child.emit('close', 0, null);
      });
      return child;
    }
  });

  const detached = await backend.startDetached({ projectRoot: '/repo', skipDeploy: true, skipVerify: true });
  const status = await backend.readJob('job-1', { projectRoot: '/repo' });

  assert.equal(detached.job_id, 'job-1');
  assert.equal(status.pid, 123);
  assert.deepEqual(spawns[0], ['/opt/autovpn/bin/autovpn', ['run', '--project-root', '/repo', '--output', 'jsonl', '--skip-deploy', '--skip-verify', '--detach', '--json']]);
  assert.deepEqual(spawns[1], ['/opt/autovpn/bin/autovpn', ['jobs', 'status', 'job-1', '--json', '--project-root', '/repo']]);
});

test('selectBackend defaults to Python backend and supports explicit Python fallback', () => {
  assert.equal(selectBackend({ env: {} }).kind, 'python');
  assert.equal(selectBackend({ env: { AUTOVPN_BACKEND: 'python' } }).kind, 'python');
});

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

test('PythonBackend can stream normalized events from captured JSONL stdout', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const spawns = [];
  const backend = new PythonBackend({
    resolvePythonCli: () => ({ command: '/opt/autovpn/bin/autovpn', args: [] }),
    spawn: (command, args) => {
      spawns.push([command, args]);
      return child;
    }
  });

  const events = [];
  const consume = (async () => {
    for await (const event of backend.run({ projectRoot: '/repo', skipDeploy: true, skipVerify: true, output: 'jsonl' })) {
      events.push(event);
    }
  })();
  child.stdout.emit('data', '{"type":"run_started","artifact_dir":"/repo/artifacts/1"}\n');
  child.stdout.emit('data', '{"type":"summary","run_status":"success"}\n');
  child.stdout.emit('end');
  child.emit('close', 0, null);
  await consume;

  assert.deepEqual(spawns[0], ['/opt/autovpn/bin/autovpn', ['run', '--project-root', '/repo', '--output', 'jsonl', '--skip-deploy', '--skip-verify']]);
  assert.deepEqual(events.map((event) => event.type), ['run_started', 'summary']);
});

test('PythonBackend merges project .env into spawned run environment without overriding explicit env', async () => {
  const projectRoot = await mkdir(path.join(os.tmpdir(), `autovpn-python-backend-env-${Date.now()}`), { recursive: true });
  await writeFile(path.join(projectRoot, '.env'), 'VPN_AUTOMATION_UPSTREAM_PROXY=off\nEXTRA_FROM_ENV=1\nPATH=/from-dotenv\n', 'utf8');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const spawns = [];
  const backend = new PythonBackend({
    env: { PATH: '/bin', VPN_AUTOMATION_UPSTREAM_PROXY: 'http://127.0.0.1:7890' },
    resolvePythonCli: () => ({ command: '/opt/autovpn/bin/autovpn', args: [] }),
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      return child;
    }
  });

  const consume = (async () => {
    for await (const _event of backend.run({ projectRoot, skipDeploy: true, skipVerify: true, output: 'jsonl' })) {
      // consume
    }
  })();
  child.stdout.emit('data', '{"type":"summary","run_status":"success"}\n');
  child.stdout.emit('end');
  child.emit('close', 0, null);
  await consume;

  assert.equal(spawns[0].options.env.VPN_AUTOMATION_UPSTREAM_PROXY, 'http://127.0.0.1:7890');
  assert.equal(spawns[0].options.env.EXTRA_FROM_ENV, '1');
  assert.equal(spawns[0].options.env.PATH, '/bin');
});

test('PythonBackend event streams surface non-zero Python exits', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const backend = new PythonBackend({
    resolvePythonCli: () => ({ command: '/opt/autovpn/bin/autovpn', args: [] }),
    spawn: () => child
  });

  const consume = (async () => {
    for await (const _event of backend.run({ projectRoot: '/repo', output: 'jsonl' })) {
      // consume stream
    }
  })();
  child.stderr.emit('data', 'bad config\n');
  child.stdout.emit('end');
  child.emit('close', 1, null);

  await assert.rejects(consume, /Python backend exited with code 1: bad config/);
});

test('PythonBackend readLogs streams Python job log output', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const spawns = [];
  const backend = new PythonBackend({
    resolvePythonCli: () => ({ command: '/opt/autovpn/bin/autovpn', args: [] }),
    spawn: (command, args) => {
      spawns.push([command, args]);
      return child;
    }
  });

  const lines = [];
  const consume = (async () => {
    for await (const line of backend.readLogs({ projectRoot: '/repo', jobId: 'job-1', format: 'jsonl', tail: 10 })) {
      lines.push(line);
    }
  })();
  child.stdout.emit('data', '{"level":"info","message":"one"}\n');
  child.stdout.emit('data', '{"level":"info","message":"two"}\n');
  child.stdout.emit('end');
  child.emit('close', 0, null);
  await consume;

  assert.deepEqual(spawns[0], ['/opt/autovpn/bin/autovpn', ['jobs', 'logs', 'job-1', '--project-root', '/repo', '--format', 'jsonl', '--tail', '10']]);
  assert.deepEqual(lines, ['{"level":"info","message":"one"}', '{"level":"info","message":"two"}']);
});
