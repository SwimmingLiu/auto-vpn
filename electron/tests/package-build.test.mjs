import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveIconPaths, resolveLiveProfilePath } from '../build/package.mjs';

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
