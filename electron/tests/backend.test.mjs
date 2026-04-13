import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBackendInvocation, parseBackendEventLine } from '../lib/backend.js';

test('buildBackendInvocation returns python module command', () => {
  const invocation = buildBackendInvocation('/repo', 'run');
  assert.equal(invocation.command, 'python3');
  assert.deepEqual(invocation.args, ['-m', 'vpn_automation.backend', 'run', '--project-root', '/repo']);
});

test('parseBackendEventLine decodes backend json line', () => {
  const event = parseBackendEventLine('{"type":"log","message":"hello"}');
  assert.equal(event.type, 'log');
  assert.equal(event.message, 'hello');
});
