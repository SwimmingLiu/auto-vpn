import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildBackendInvocation, parseBackendEventLine, resolveBackendPython } from '../lib/backend.js';
import { findProjectRoot, resolveProjectRoot, resolveStateProfilePath } from '../paths.js';

test('buildBackendInvocation returns python module command', () => {
  const invocation = buildBackendInvocation('/repo', 'run');
  assert.deepEqual(invocation.commands, ['python3.12', 'python3']);
  assert.deepEqual(invocation.args, ['-m', 'vpn_automation.backend', 'run', '--project-root', '/repo']);
});

test('buildBackendInvocation supports profile-save command routing', () => {
  const invocation = buildBackendInvocation('/repo', 'profile-save');
  assert.deepEqual(invocation.args, ['-m', 'vpn_automation.backend', 'profile-save', '--project-root', '/repo']);
});

test('parseBackendEventLine decodes backend json line', () => {
  const event = parseBackendEventLine('{"type":"log","message":"hello"}');
  assert.equal(event.type, 'log');
  assert.equal(event.message, 'hello');
});

test('findProjectRoot climbs out of packaged output to repo root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-electron-root-'));
  const projectRoot = path.join(root, 'vpn-subscription-automation');
  fs.mkdirSync(path.join(projectRoot, 'src', 'vpn_automation'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'pyproject.toml'), '', 'utf-8');

  const execPath = path.join(
    projectRoot,
    'dist-electron',
    'mac-arm64',
    'VPN Subscription Automation.app',
    'Contents',
    'MacOS',
    'VPN Subscription Automation'
  );
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, '', 'utf-8');

  assert.equal(findProjectRoot(execPath), projectRoot);
});

test('resolveProjectRoot returns explicit root unchanged', () => {
  assert.equal(resolveProjectRoot('/repo'), '/repo');
});

test('resolveStateProfilePath prefers the repo-anchor state file for worktrees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-state-root-'));
  const repoRoot = path.join(root, 'vpn-subscription-automation');
  const worktreeRoot = path.join(repoRoot, '.worktrees', 'cleanup');
  const anchorProfile = path.join(repoRoot, 'state', 'profile.toml');
  const localProfile = path.join(worktreeRoot, 'state', 'profile.toml');

  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.mkdirSync(path.dirname(localProfile), { recursive: true });
  fs.mkdirSync(path.dirname(anchorProfile), { recursive: true });
  fs.writeFileSync(localProfile, '[sources]\n', 'utf-8');
  fs.writeFileSync(anchorProfile, '[sources]\n', 'utf-8');

  assert.equal(resolveStateProfilePath(worktreeRoot), anchorProfile);
});

test('resolveBackendPython prefers a project virtualenv when present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-python-root-'));
  const venvPython = path.join(root, '.venv', 'bin', 'python');

  fs.mkdirSync(path.dirname(venvPython), { recursive: true });
  fs.writeFileSync(venvPython, '', 'utf-8');

  assert.deepEqual(resolveBackendPython(root), [venvPython, 'python3.12', 'python3']);
});
