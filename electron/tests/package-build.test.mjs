import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSvgIconRenderHtml,
  buildElectronBuilderArgs,
  buildNodeVendorInstallArgs,
  buildPlaywrightBrowserInstallArgs,
  resolveNodeVendorRuntimePaths,
  resolvePlaywrightBrowserRuntimePaths,
  buildPythonVendorInstallArgs,
  resolveIconPaths,
  resolveLiveProfilePath,
  resolvePythonVendorRuntimePaths,
  resolveShareWorkerPaths,
  selectRunnablePythonCandidate,
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

test('buildSvgIconRenderHtml renders the app icon on a transparent canvas', () => {
  const html = buildSvgIconRenderHtml('<svg viewBox="0 0 10 10"></svg>', 1024);

  assert.match(html, /background:\s*transparent/);
  assert.match(html, /width:\s*1024px/);
  assert.match(html, /height:\s*1024px/);
  assert.match(html, /data:image\/svg\+xml;base64,/);
});

test('buildElectronBuilderArgs builds a macOS DMG installer by default', () => {
  assert.deepEqual(buildElectronBuilderArgs(), ['electron-builder', '--mac', 'dmg']);
});

test('buildPythonVendorInstallArgs installs runtime Python dependencies into vendor dir', () => {
  assert.deepEqual(buildPythonVendorInstallArgs('/tmp/vendor'), [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--target',
    '/tmp/vendor',
    'cryptography>=45.0.0',
    'python-dotenv>=1.0.1',
    'requests>=2.32.0',
    'tomlkit>=0.13.2'
  ]);
});

test('resolvePythonVendorRuntimePaths stores packaged dependencies under electron runtime', () => {
  assert.deepEqual(resolvePythonVendorRuntimePaths('/tmp/project'), {
    vendorDir: '/tmp/project/electron/runtime/python-vendor'
  });
});

test('resolveNodeVendorRuntimePaths stores packaged browser probe dependencies under electron runtime', () => {
  assert.deepEqual(resolveNodeVendorRuntimePaths('/tmp/project'), {
    vendorDir: '/tmp/project/electron/runtime/node-vendor'
  });
});

test('resolvePlaywrightBrowserRuntimePaths stores bundled Chromium under electron runtime', () => {
  assert.deepEqual(resolvePlaywrightBrowserRuntimePaths('/tmp/project'), {
    browserDir: '/tmp/project/electron/runtime/playwright-browsers'
  });
});

test('buildNodeVendorInstallArgs installs Playwright runtime dependencies into vendor dir', () => {
  assert.deepEqual(buildNodeVendorInstallArgs('/tmp/vendor'), [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--prefix',
    '/tmp/vendor',
    'playwright@1.59.1'
  ]);
});

test('buildPlaywrightBrowserInstallArgs installs only the Chromium headless shell', () => {
  assert.deepEqual(buildPlaywrightBrowserInstallArgs(), [
    'playwright',
    'install',
    'chromium-headless-shell'
  ]);
});

test('selectRunnablePythonCandidate skips missing commands on PATH', () => {
  assert.equal(
    selectRunnablePythonCandidate(['python3.12', 'python3'], (candidate) => candidate === 'python3'),
    'python3'
  );
});

test('package configuration uses DMG as the macOS distribution target', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')
  );

  assert.deepEqual(packageJson.build.mac.target, ['dmg']);
  assert.equal(packageJson.build.dmg.artifactName, '${productName}-${version}-${arch}.${ext}');
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
