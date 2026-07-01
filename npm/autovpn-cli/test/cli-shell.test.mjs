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

test('AUTOVPN_CLI_SHELL=python disables Node shell and forwards all arguments', async () => {
  const io = createIo();
  const forwarded = [];

  const code = await runCliShell(['--version'], {
    packageVersion: '1.3.0',
    env: { AUTOVPN_CLI_SHELL: 'python' },
    io,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 5;
    }
  });

  assert.equal(code, 5);
  assert.equal(io.stdout, '');
  assert.equal(io.stderr, '');
  assert.deepEqual(forwarded, [['--version']]);
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

test('normalizes provided project root and forwards business commands through explicit Python backend', async () => {
  const io = createIo();
  const forwarded = [];
  const rawRoot = path.join(process.cwd(), '.', 'nested', '..');

  const code = await runCliShell(['run', '--project-root', rawRoot, '--output', 'jsonl'], {
    packageVersion: '1.3.0',
    env: { AUTOVPN_BACKEND: 'python' },
    io,
    runForwarder: async (argv) => {
      forwarded.push(argv);
      return 7;
    }
  });

  assert.equal(code, 7);
  assert.equal(io.stdout, '');
  assert.equal(io.stderr, '');
  assert.deepEqual(forwarded, [['run', '--project-root', process.cwd(), '--output', 'jsonl']]);
});
