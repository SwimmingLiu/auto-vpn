import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveIconPaths,
  resolveLiveProfilePath,
  resolveShareWorkerPaths,
  stageShareWorkerRuntime
} from '../build/package.mjs';

test('resolveLiveProfilePath prefers the repo-anchor state file for worktrees', () => {
  const projectRoot = '/Users/demo/vpn-subscription-automation/.worktrees/feature-a';

  assert.equal(
    resolveLiveProfilePath(projectRoot),
    '/Users/demo/vpn-subscription-automation/state/profile.toml'
  );
});

test('resolveIconPaths points packaging to generated icns and source svg', () => {
  const projectRoot = '/tmp/project';
  const iconPaths = resolveIconPaths(projectRoot);

  assert.equal(
    iconPaths.sourceSvg,
    '/tmp/project/electron/renderer/assets/vpn-auto-logo-v2-minimal.svg'
  );
  assert.equal(iconPaths.outputDir, '/tmp/project/electron/build/assets');
  assert.equal(iconPaths.outputIcns, '/tmp/project/electron/build/assets/app-icon.icns');
  assert.equal(iconPaths.iconsetDir, '/tmp/project/electron/build/assets/app-icon.iconset');
});

test('resolveShareWorkerPaths points packaging to the source vpn.js and bundled runtime copy', () => {
  const projectRoot = '/tmp/workspace/vpn-subscription-automation';
  const shareWorkerPaths = resolveShareWorkerPaths(projectRoot);

  assert.equal(
    shareWorkerPaths.sourcePath,
    '/tmp/workspace/cloudflarevpn/edgetunnel/vpn.js'
  );
  assert.equal(
    shareWorkerPaths.runtimePath,
    '/tmp/workspace/vpn-subscription-automation/electron/runtime/share-worker/vpn.js'
  );
});

test('stageShareWorkerRuntime copies vpn.js into the packaged runtime tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-share-worker-'));
  const workspaceRoot = path.join(root, 'workspace');
  const projectRoot = path.join(workspaceRoot, 'vpn-subscription-automation');
  const shareWorkerSource = path.join(workspaceRoot, 'cloudflarevpn', 'edgetunnel', 'vpn.js');

  fs.mkdirSync(path.dirname(shareWorkerSource), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(shareWorkerSource, "export default { async fetch() { return new Response('login'); } }", 'utf-8');

  const runtimePath = stageShareWorkerRuntime(projectRoot);

  assert.equal(
    runtimePath,
    path.join(projectRoot, 'electron', 'runtime', 'share-worker', 'vpn.js')
  );
  assert.equal(fs.readFileSync(runtimePath, 'utf-8'), fs.readFileSync(shareWorkerSource, 'utf-8'));
});
