import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { main, resolvePythonCli, runForwarder } from '../lib/runner.mjs';

test('resolvePythonCli prefers AUTOVPN_PYTHON_CLI without probing PATH', () => {
  const calls = [];

  const result = resolvePythonCli({
    env: { AUTOVPN_PYTHON_CLI: '/opt/autovpn/bin/autovpn' },
    packageVersion: '1.3.0',
    spawnSync: (...args) => {
      calls.push(args);
      return { status: 1, stdout: '', stderr: '' };
    }
  });

  assert.deepEqual(result, {
    command: '/opt/autovpn/bin/autovpn',
    args: [],
    source: 'AUTOVPN_PYTHON_CLI'
  });
  assert.deepEqual(calls, []);
});

test('resolvePythonCli accepts PATH autovpn only when version matches', () => {
  const probes = [];

  const result = resolvePythonCli({
    env: {},
    packageVersion: '1.3.0',
    spawnSync: (command, args) => {
      probes.push([command, args]);
      return { status: 0, stdout: 'autovpn 1.3.0\n', stderr: '' };
    }
  });

  assert.deepEqual(result, {
    command: 'autovpn',
    args: [],
    source: 'PATH'
  });
  assert.deepEqual(probes, [['autovpn', ['--version']]]);
});

test('resolvePythonCli marks PATH probes so the npm wrapper can avoid self-recursion', () => {
  const probeEnvs = [];

  assert.throws(
    () => resolvePythonCli({
      env: {},
      packageVersion: '1.3.0',
      spawnSync: (_command, _args, options) => {
        probeEnvs.push(options.env);
        return { status: 42, stdout: '', stderr: '' };
      }
    }),
    /compatible Python autovpn CLI/
  );

  assert.equal(probeEnvs[0].AUTOVPN_WRAPPER_PROBE, '1');
});

test('main exits nonzero during wrapper self-probe', async () => {
  const code = await main(['--version'], {
    env: { AUTOVPN_WRAPPER_PROBE: '1' }
  });

  assert.equal(code, 42);
});

test('resolvePythonCli refuses PATH autovpn with mismatched version', () => {
  assert.throws(
    () => resolvePythonCli({
      env: {},
      packageVersion: '1.3.0',
      spawnSync: () => ({ status: 0, stdout: 'autovpn 9.9.9\n', stderr: '' })
    }),
    /compatible Python autovpn CLI/
  );
});

test('runForwarder forwards argv and returns child exit code', async () => {
  const child = new EventEmitter();
  const spawns = [];

  const codePromise = runForwarder(['doctor', '--output', 'json'], {
    env: { AUTOVPN_PYTHON_CLI: '/opt/autovpn/bin/autovpn' },
    packageVersion: '1.3.0',
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      return child;
    }
  });

  child.emit('exit', 7, null);
  const code = await codePromise;

  assert.equal(code, 7);
  assert.equal(spawns[0].command, '/opt/autovpn/bin/autovpn');
  assert.deepEqual(spawns[0].args, ['doctor', '--output', 'json']);
  assert.deepEqual(spawns[0].options.stdio, 'inherit');
});
