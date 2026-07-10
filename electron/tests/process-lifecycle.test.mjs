import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSignalTarget, signalProcessTree } from '../lib/process-lifecycle.js';

test('resolveSignalTarget targets the detached process group on macOS and Linux', () => {
  assert.equal(resolveSignalTarget({ pid: 4242 }, 'darwin'), -4242);
  assert.equal(resolveSignalTarget({ pid: 4242 }, 'linux'), -4242);
});

test('resolveSignalTarget targets the child process on Windows', () => {
  assert.equal(resolveSignalTarget({ pid: 4242 }, 'win32'), 4242);
});

test('signalProcessTree preserves detached process-group stopping for the Node backend', () => {
  const calls = [];
  const signaled = signalProcessTree(
    { pid: 4242, kill: () => false },
    'SIGTERM',
    {
      platform: 'darwin',
      killProcess: (target, signal) => {
        calls.push({ target, signal });
      }
    }
  );

  assert.equal(signaled, true);
  assert.deepEqual(calls, [{ target: -4242, signal: 'SIGTERM' }]);
});

test('signalProcessTree falls back to child.kill when no process group exists', () => {
  const calls = [];
  const child = {
    pid: 4242,
    kill: (signal) => {
      calls.push({ target: 'child', signal });
      return true;
    }
  };
  const signaled = signalProcessTree(child, 'SIGKILL', {
    platform: 'darwin',
    killProcess: () => {
      const error = new Error('no such process group');
      error.code = 'ESRCH';
      throw error;
    }
  });

  assert.equal(signaled, true);
  assert.deepEqual(calls, [{ target: 'child', signal: 'SIGKILL' }]);
});
