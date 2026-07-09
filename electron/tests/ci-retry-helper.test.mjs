import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const retryHelper = path.join(projectRoot, 'scripts', 'ci', 'retry-command.sh');

function runRetryHelper(args, options = {}) {
  return spawnSync('bash', [retryHelper, ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      AUTOVPN_CI_RETRIES: '2',
      AUTOVPN_CI_RETRY_BASE_SECONDS: '0',
      AUTOVPN_CI_RETRY_MAX_SECONDS: '0',
      ...options.env
    }
  });
}

test('CI retry helper retries a transient failure and preserves command arguments', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-ci-retry-'));
  const stateFile = path.join(tempDir, 'attempt');
  const argsFile = path.join(tempDir, 'args.json');

  try {
    const result = runRetryHelper([
      'transient command',
      '--',
      'node',
      '-e',
      `
        const fs = require('node:fs');
        const [stateFile, argsFile, ...rest] = process.argv.slice(1);
        fs.writeFileSync(argsFile, JSON.stringify(rest));
        if (!fs.existsSync(stateFile)) {
          fs.writeFileSync(stateFile, 'failed-once');
          process.exit(7);
        }
      `,
      stateFile,
      argsFile,
      'hello world',
      'second-arg'
    ]);

    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /transient command attempt 1\/2/);
    assert.match(result.stdout, /transient command attempt 2\/2/);
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf-8')), ['hello world', 'second-arg']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CI retry helper returns the final failed command status', () => {
  const result = runRetryHelper(['always failing', '--', 'bash', '-c', 'exit 9']);

  assert.equal(result.status, 9);
  assert.match(result.stderr, /always failing failed after 2 attempts/);
});

test('CI retry helper verifies npm cache between failed npm attempts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-ci-retry-npm-'));
  const npmShim = path.join(tempDir, 'npm');
  const logFile = path.join(tempDir, 'npm.log');

  try {
    fs.writeFileSync(
      npmShim,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${logFile}"\nif [ "$1" = "cache" ]; then exit 0; fi\nexit 4\n`,
      { mode: 0o755 }
    );

    const result = runRetryHelper(['npm command', '--', 'npm', 'ci'], {
      env: {
        PATH: `${tempDir}${path.delimiter}${process.env.PATH}`
      }
    });

    assert.equal(result.status, 4);
    const calls = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    assert.deepEqual(calls, ['ci', 'cache verify', 'ci']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
