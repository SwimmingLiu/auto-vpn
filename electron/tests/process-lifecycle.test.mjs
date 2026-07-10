import test from 'node:test';
import assert from 'node:assert/strict';

import { pipelineStopResponse, requestProcessTreeStop, resolveSignalTarget, signalProcessTree } from '../lib/process-lifecycle.js';

test('resolveSignalTarget targets the detached process group on macOS and Linux', () => {
  assert.equal(resolveSignalTarget({ pid: 4242 }, 'darwin'), -4242);
  assert.equal(resolveSignalTarget({ pid: 4242 }, 'linux'), -4242);
});

test('resolveSignalTarget targets the child process on Windows', () => {
  assert.equal(resolveSignalTarget({ pid: 4242 }, 'win32'), 4242);
});

test('signalProcessTree terminates the complete Windows process tree', () => {
  const calls = [];
  const signaled = signalProcessTree({ pid: 4242 }, 'SIGTERM', {
    platform: 'win32',
    runTaskkill: (args) => {
      calls.push(args);
      return { status: 0 };
    }
  });

  assert.equal(signaled, true);
  assert.deepEqual(calls, [['/PID', '4242', '/T']]);
});

test('signalProcessTree force-kills the complete Windows process tree after timeout', () => {
  const calls = [];
  const signaled = signalProcessTree({ pid: 4242 }, 'SIGKILL', {
    platform: 'win32',
    runTaskkill: (args) => {
      calls.push(args);
      return { status: 0 };
    }
  });

  assert.equal(signaled, true);
  assert.deepEqual(calls, [['/PID', '4242', '/T', '/F']]);
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

test('requestProcessTreeStop force-kills a Windows tree after initial taskkill failure', () => {
  const calls = [];
  const timers = [];
  const child = { pid: 4242 };
  const result = requestProcessTreeStop(child, {
    platform: 'win32',
    runTaskkill: (args) => {
      calls.push(args);
      return { status: calls.length === 1 ? 1 : 0 };
    },
    setTimeoutFn: (callback, delay) => {
      timers.push({ callback, delay });
      return { unref() {} };
    },
    isChildActive: () => true
  });

  assert.equal(result.signaled, false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 4000);
  timers[0].callback();
  assert.deepEqual(calls, [
    ['/PID', '4242', '/T'],
    ['/PID', '4242', '/T', '/F']
  ]);
});

test('requestProcessTreeStop does not force-kill a Windows tree confirmed exited', () => {
  const calls = [];
  let timer;
  let active = true;
  requestProcessTreeStop({ pid: 4242 }, {
    platform: 'win32',
    runTaskkill: (args) => {
      calls.push(args);
      return { status: 1 };
    },
    setTimeoutFn: (callback) => {
      timer = callback;
      return { unref() {} };
    },
    isChildActive: () => active
  });

  active = false;
  timer();
  assert.deepEqual(calls, [['/PID', '4242', '/T']]);
});

test('pipeline stop reports accepted while Windows forced escalation is pending', () => {
  assert.deepEqual(pipelineStopResponse({ signaled: false, timer: { unref() {} } }), {
    ok: true,
    requested: true
  });
});

test('pipeline stop reports failure when neither a signal nor escalation was scheduled', () => {
  assert.deepEqual(pipelineStopResponse({ signaled: false, timer: null }), {
    ok: false,
    requested: true
  });
});
