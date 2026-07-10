import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { runCliShell } from '../dist/cli/main.js';

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

test('prints Node-native help without invoking Python backend', async () => {
  const io = createIo();
  const forwarded = [];

  const code = await runCliShell(['--help'], {
    packageVersion: '1.3.0',
    io,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 0;
    }
  });

  assert.equal(code, 0);
  assert.match(io.stdout, /AutoVPN headless command line interface/);
  assert.match(io.stdout, /Commands:/);
  assert.equal(io.stderr, '');
  assert.deepEqual(forwarded, []);
});

test('prints Node-native version without invoking Python backend', async () => {
  const io = createIo();
  const forwarded = [];

  const code = await runCliShell(['--version'], {
    packageVersion: '1.3.0',
    io,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 0;
    }
  });

  assert.equal(code, 0);
  assert.equal(io.stdout, 'autovpn 1.3.0\n');
  assert.equal(io.stderr, '');
  assert.deepEqual(forwarded, []);
});

test('rejects unknown top-level commands before invoking Python backend', async () => {
  const io = createIo();
  const forwarded = [];

  const code = await runCliShell(['unknown'], {
    packageVersion: '1.3.0',
    io,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 0;
    }
  });

  assert.equal(code, 2);
  assert.equal(io.stdout, '');
  assert.match(io.stderr, /unknown command: unknown/);
  assert.deepEqual(forwarded, []);
});

test('returns usage error when command is missing', async () => {
  const io = createIo();
  const forwarded = [];

  const code = await runCliShell([], {
    packageVersion: '1.3.0',
    io,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 0;
    }
  });

  assert.equal(code, 2);
  assert.equal(io.stdout, '');
  assert.match(io.stderr, /missing command/);
  assert.deepEqual(forwarded, []);
});

test('validates command-specific output flags before forwarding', async () => {
  const io = createIo();
  const forwarded = [];

  const code = await runCliShell(['doctor', '--output', 'jsonl'], {
    packageVersion: '1.3.0',
    io,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 0;
    }
  });

  assert.equal(code, 2);
  assert.equal(io.stdout, '');
  assert.match(io.stderr, /doctor --output must be one of: human, json/);
  assert.deepEqual(forwarded, []);
});

test('validates jobs subcommands when parent options precede the subcommand', async () => {
  const io = createIo();
  const forwarded = [];

  const code = await runCliShell(['jobs', '--project-root', '.', 'logs', 'abc', '--format', 'xml'], {
    packageVersion: '1.3.0',
    io,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 0;
    }
  });

  assert.equal(code, 2);
  assert.equal(io.stdout, '');
  assert.match(io.stderr, /jobs logs --format must be one of: human, jsonl/);
  assert.deepEqual(forwarded, []);
});

test('unknown backend values are rejected before business command execution', async () => {
  const io = createIo();
  const forwarded = [];
  const rawRoot = path.join(process.cwd(), '.', 'nested', '..');

  const code = await runCliShell(['run', '--project-root', rawRoot, '--output', 'jsonl'], {
    packageVersion: '1.3.0',
    env: { AUTOVPN_BACKEND: 'unsupported' },
    io,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 7;
    }
  });

  assert.equal(code, 1);
  assert.equal(io.stdout, '');
  assert.match(io.stderr, /Unsupported AUTOVPN_BACKEND/);
  assert.deepEqual(forwarded, []);
});

test('serve starts the native web server without invoking backend executeCli', async () => {
  const io = createIo();
  const forwarded = [];
  const created = [];

  const code = await runCliShell(['serve', '--host', '127.0.0.1', '--port', '8765'], {
    packageVersion: '1.5.0',
    io,
    cwd: '/repo',
    createServer: async (options) => {
      created.push(options);
      return {
        origin: 'http://127.0.0.1:8765',
        close: async () => {}
      };
    },
    serveExitAfterStart: true,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 0;
    },
    createBackend: () => ({
      kind: 'node',
      executeCli: async (argv) => {
        forwarded.push(argv);
        return 9;
      }
    })
  });

  assert.equal(code, 0);
  assert.match(io.stdout, /AutoVPN server listening on http:\/\/127\.0\.0\.1:8765/);
  assert.match(io.stdout, /Password: /);
  assert.doesNotMatch(io.stdout, /\?token=/);
  assert.equal(io.stderr, '');
  assert.equal(created.length, 1);
  assert.equal(created[0].projectRoot, '/repo');
  assert.ok(created[0].auth.password);
  assert.deepEqual(forwarded, []);
});

test('serve with password prints the plain URL instead of a token URL', async () => {
  const io = createIo();
  const created = [];

  const code = await runCliShell(['serve', '--host', '127.0.0.1', '--port', '8765', '--password', 'local-password'], {
    packageVersion: '1.5.0',
    io,
    cwd: '/repo',
    createServer: async (options) => {
      created.push(options);
      return {
        origin: 'http://127.0.0.1:8765',
        close: async () => {}
      };
    },
    serveExitAfterStart: true,
    createBackend: () => ({
      kind: 'node',
      executeCli: async () => 9
    })
  });

  assert.equal(code, 0);
  assert.match(io.stdout, /Open http:\/\/127\.0\.0\.1:8765\//);
  assert.match(io.stdout, /Password: local-password/);
  assert.doesNotMatch(io.stdout, /\?token=/);
  assert.equal(created[0].auth.password, 'local-password');
});
