import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSvgIconRenderHtml,
  buildPackageArchList,
  buildElectronBuilderArgs,
  buildPackagePlatformList,
  buildNodeVendorInstallArgs,
  buildPlaywrightBrowserInstallArgs,
  isPlaywrightBrowserRuntimeReady,
  resolveNodeVendorRuntimePaths,
  resolvePlaywrightBrowserRuntimePaths,
  buildPythonVendorInstallArgs,
  cleanElectronOutputDir,
  resolveIconPaths,
  resolveLiveProfilePath,
  resolvePythonVendorRuntimePaths,
  sanitizeBundledProfileToml,
  resolveShareWorkerPaths,
  buildCommandSpawnOptions,
  runOrThrow,
  retryOperation,
  selectRunnablePythonCandidate,
  shouldBundlePlaywrightBrowserRuntime,
  stagePlaywrightBrowserRuntime,
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
  assert.equal(iconPaths.outputPng, '/tmp/project/electron/build/assets/app-icon-1024.png');
  assert.equal(iconPaths.outputIco, '/tmp/project/electron/build/assets/app-icon.ico');
  assert.equal(iconPaths.outputIcns, '/tmp/project/electron/build/assets/app-icon.icns');
  assert.equal(iconPaths.iconsetDir, '/tmp/project/electron/build/assets/app-icon.iconset');
});

test('packaging icon assets are committed so release builds do not need browser rendering', () => {
  for (const asset of [
    path.join('electron', 'build', 'assets', 'app-icon-1024.png'),
    path.join('electron', 'build', 'assets', 'app-icon.ico'),
    path.join('electron', 'build', 'assets', 'app-icon.icns')
  ]) {
    assert.equal(fs.existsSync(path.join(process.cwd(), asset)), true, `${asset} should exist`);
  }
});

test('sanitizeBundledProfileToml removes deprecated availability host and phrase fields', () => {
  const payload = `
# VPN Subscription Automation runtime profile
[availability_targets]
[availability_targets.gemini]
url = "https://gemini.google.com/"
enabled = true
allowed_hosts = ["gemini.google.com", "accounts.google.com"]
negative_phrases = ["not available in your country"]

[availability_targets.chatgpt]
url = "https://chatgpt.com/"
enabled = true
allowed_hosts = ["chatgpt.com"]
negative_phrases = ["unsupported region"]
`;

  const sanitized = sanitizeBundledProfileToml(payload);

  assert.match(sanitized, /\[availability_targets\.chatgpt_ios\]/);
  assert.match(sanitized, /url = "https:\/\/ios\.chat\.openai\.com\/"/);
  assert.match(sanitized, /\[availability_targets\.chatgpt_web\]/);
  assert.doesNotMatch(sanitized, /allowed_hosts/);
  assert.doesNotMatch(sanitized, /negative_phrases/);
  assert.doesNotMatch(sanitized, /\[availability_targets\.chatgpt\]/);
  assert.doesNotMatch(sanitized, /VPN Subscription Automation/);
  assert.match(sanitized, /# AutoVPN runtime profile/);
});

test('sanitizeBundledProfileToml preserves following top-level tables when availability is empty', () => {
  const sanitized = sanitizeBundledProfileToml(`[availability_targets]
[deploy]
project_name = "sub-links-auto"
`);

  assert.match(sanitized, /\[availability_targets\.chatgpt_ios\]/);
  assert.match(sanitized, /\[deploy\]/);
  assert.match(sanitized, /project_name = "sub-links-auto"/);
});

test('buildSvgIconRenderHtml renders the app icon on a transparent canvas', () => {
  const html = buildSvgIconRenderHtml('<svg viewBox="0 0 10 10"></svg>', 1024);

  assert.match(html, /background:\s*transparent/);
  assert.match(html, /width:\s*1024px/);
  assert.match(html, /height:\s*1024px/);
  assert.match(html, /data:image\/svg\+xml;base64,/);
});

test('retryOperation reruns transient icon rendering operations', async () => {
  let attempts = 0;
  const result = await retryOperation(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('transient screenshot failure');
    }
    return 'rendered';
  }, { retries: 2, delayMs: 0 });

  assert.equal(result, 'rendered');
  assert.equal(attempts, 2);
});

test('retryOperation requires at least one retry attempt', async () => {
  let attempts = 0;
  await assert.rejects(
    () => retryOperation(async () => {
      attempts += 1;
      return 'rendered';
    }, { retries: 0, delayMs: 0 }),
    {
      name: 'TypeError',
      message: 'retryOperation retries must be a positive integer'
    }
  );
  assert.equal(attempts, 0);
});

test('retryOperation rethrows the last failed attempt', async () => {
  let attempts = 0;
  const firstError = new Error('first screenshot failure');
  const lastError = new Error('final screenshot failure');

  await assert.rejects(
    () => retryOperation(async () => {
      attempts += 1;
      throw attempts === 1 ? firstError : lastError;
    }, { retries: 2, delayMs: 0 }),
    lastError
  );

  assert.equal(attempts, 2);
});

test('buildPackagePlatformList defaults to the host platform', () => {
  assert.deepEqual(buildPackagePlatformList({}, 'darwin'), ['mac']);
  assert.deepEqual(buildPackagePlatformList({}, 'linux'), ['linux']);
  assert.deepEqual(buildPackagePlatformList({}, 'win32'), ['win']);
});

test('buildPackagePlatformList accepts explicit platform aliases', () => {
  assert.deepEqual(buildPackagePlatformList({ AUTOVPN_PACKAGE_PLATFORM: 'macos' }, 'linux'), ['mac']);
  assert.deepEqual(buildPackagePlatformList({ AUTOVPN_PACKAGE_PLATFORM: 'windows' }, 'linux'), ['win']);
  assert.deepEqual(buildPackagePlatformList({ AUTOVPN_PACKAGE_PLATFORM: 'linux,win' }, 'darwin'), ['linux', 'win']);
});

test('buildPackageArchList accepts explicit architecture aliases', () => {
  assert.deepEqual(buildPackageArchList({ AUTOVPN_PACKAGE_ARCH: 'x64' }, 'arm64'), ['x64']);
  assert.deepEqual(buildPackageArchList({ AUTOVPN_PACKAGE_ARCH: 'amd64,arm64' }, 'x64'), ['x64', 'arm64']);
  assert.deepEqual(buildPackageArchList({ AUTOVPN_PACKAGE_ARCH: 'x64,arm64,armv7l' }, 'arm64'), [
    'x64',
    'arm64',
    'armv7l'
  ]);
});

test('buildElectronBuilderArgs builds a macOS DMG installer by default', () => {
  assert.deepEqual(buildElectronBuilderArgs(), ['electron-builder', '--mac', 'dmg']);
});

test('buildElectronBuilderArgs appends legacy macOS-compatible architecture flags explicitly', () => {
  assert.deepEqual(buildElectronBuilderArgs(['dmg'], ['x64', 'arm64', 'armv7l']), [
    'electron-builder',
    '--mac',
    'dmg',
    '--x64',
    '--arm64'
  ]);
});

test('buildPackageArchList defaults to the host architecture', () => {
  assert.deepEqual(buildPackageArchList({}, 'arm64'), ['arm64']);
  assert.deepEqual(buildPackageArchList({}, 'x64'), ['x64']);
});

test('buildElectronBuilderArgs builds target platform and architecture matrices', () => {
  assert.deepEqual(
    buildElectronBuilderArgs({
      platforms: ['mac'],
      archs: ['x64', 'armv7l']
    }),
    ['electron-builder', '--mac', 'dmg', '--x64']
  );

  assert.deepEqual(
    buildElectronBuilderArgs({
      platforms: ['linux'],
      archs: ['x64', 'arm64']
    }),
    ['electron-builder', '--linux', 'AppImage', 'deb', 'rpm', '--x64', '--arm64']
  );

  assert.deepEqual(
    buildElectronBuilderArgs({
      platforms: ['win'],
      archs: ['arm64']
    }),
    ['electron-builder', '--win', 'nsis', 'portable', '--arm64']
  );
});

test('buildElectronBuilderArgs only emits architecture flags supported by every selected platform', () => {
  assert.deepEqual(
    buildElectronBuilderArgs({
      platforms: ['linux', 'win'],
      archs: ['x64', 'ia32']
    }),
    ['electron-builder', '--linux', 'AppImage', 'deb', 'rpm', '--win', 'nsis', 'portable', '--x64']
  );
});

test('buildPythonVendorInstallArgs installs target-platform Python 3.12 wheels into vendor dir', () => {
  assert.deepEqual(buildPythonVendorInstallArgs('/tmp/vendor', {
    platform: 'linux',
    arch: 'x64'
  }), [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--only-binary',
    ':all:',
    '--target',
    '/tmp/vendor',
    '--platform',
    'manylinux2014_x86_64',
    '--implementation',
    'cp',
    '--python-version',
    '3.12',
    '--abi',
    'cp312',
    'cryptography>=45.0.0,<47',
    'python-dotenv>=1.0.1',
    'requests>=2.32.0',
    'tomlkit>=0.13.2'
  ]);

  assert.deepEqual(buildPythonVendorInstallArgs('/tmp/vendor', {
    platform: 'win',
    arch: 'arm64'
  }), [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--only-binary',
    ':all:',
    '--target',
    '/tmp/vendor',
    '--platform',
    'win_arm64',
    '--implementation',
    'cp',
    '--python-version',
    '3.12',
    '--abi',
    'cp312',
    'cryptography>=45.0.0,<47',
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

test('isPlaywrightBrowserRuntimeReady detects an installed Chromium headless shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-playwright-ready-'));
  const browserDir = path.join(root, 'electron', 'runtime', 'playwright-browsers');
  const executable = path.join(
    browserDir,
    'chromium_headless_shell-1217',
    'chrome-headless-shell-mac-arm64',
    'chrome-headless-shell'
  );
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(browserDir, 'chromium_headless_shell-1217', 'INSTALLATION_COMPLETE'), '', 'utf-8');
  fs.writeFileSync(executable, '', 'utf-8');

  assert.equal(isPlaywrightBrowserRuntimeReady(browserDir, 'darwin'), true);
});

test('stagePlaywrightBrowserRuntime reuses a CI-preinstalled browser runtime', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-playwright-reuse-'));
  const { browserDir } = resolvePlaywrightBrowserRuntimePaths(projectRoot);
  const executable = path.join(
    browserDir,
    'chromium_headless_shell-1217',
    'chrome-headless-shell-mac-arm64',
    'chrome-headless-shell'
  );
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(browserDir, 'chromium_headless_shell-1217', 'INSTALLATION_COMPLETE'), '', 'utf-8');
  fs.writeFileSync(executable, '', 'utf-8');

  let installCalls = 0;
  const stagedBrowserDir = stagePlaywrightBrowserRuntime(projectRoot, {
    platform: 'darwin',
    run: () => {
      installCalls += 1;
      throw new Error('Playwright install should not run when the browser is already staged');
    }
  });

  assert.equal(stagedBrowserDir, browserDir);
  assert.equal(installCalls, 0);
  assert.equal(fs.existsSync(executable), true);
});

test('stagePlaywrightBrowserRuntime installs missing runtime with a longer CI timeout', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-playwright-install-'));
  const { browserDir } = resolvePlaywrightBrowserRuntimePaths(projectRoot);
  const calls = [];

  stagePlaywrightBrowserRuntime(projectRoot, {
    run: (command, args, options) => {
      calls.push({ command, args, options });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'npx');
  assert.deepEqual(calls[0].args, buildPlaywrightBrowserInstallArgs());
  assert.equal(calls[0].options.cwd, projectRoot);
  assert.equal(calls[0].options.timeout, 900000);
  assert.equal(calls[0].options.env.PLAYWRIGHT_BROWSERS_PATH, browserDir);
});

test('Playwright browser runtime is not bundled by default for release packages', () => {
  assert.equal(shouldBundlePlaywrightBrowserRuntime({}), false);
  assert.equal(shouldBundlePlaywrightBrowserRuntime({ AUTOVPN_BUNDLE_PLAYWRIGHT_BROWSER: '0' }), false);
  assert.equal(shouldBundlePlaywrightBrowserRuntime({ AUTOVPN_BUNDLE_PLAYWRIGHT_BROWSER: 'false' }), false);
  assert.equal(shouldBundlePlaywrightBrowserRuntime({ AUTOVPN_BUNDLE_PLAYWRIGHT_BROWSER: '1' }), true);
  assert.equal(shouldBundlePlaywrightBrowserRuntime({ AUTOVPN_BUNDLE_PLAYWRIGHT_BROWSER: 'true' }), true);
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

test('selectRunnablePythonCandidate can fall back to the Windows setup-python command', () => {
  assert.equal(
    selectRunnablePythonCandidate(['python3.12', 'python3', 'python'], (candidate) => candidate === 'python'),
    'python'
  );
});

test('buildCommandSpawnOptions avoids a Windows shell for Python pip arguments', () => {
  assert.equal(buildCommandSpawnOptions('python', {}, 'win32').shell, false);
  assert.equal(buildCommandSpawnOptions('/opt/homebrew/bin/python3.12', {}, 'darwin').shell, false);
  assert.equal(buildCommandSpawnOptions('npm', {}, 'win32').shell, true);
  assert.equal(buildCommandSpawnOptions('npx', {}, 'win32').shell, true);
});

test('buildCommandSpawnOptions streams package command output by default', () => {
  assert.equal(buildCommandSpawnOptions('python').stdio, 'inherit');
  assert.equal(buildCommandSpawnOptions('npm').stdio, 'inherit');
});

test('runOrThrow reports command timeouts with the configured timeout', () => {
  assert.throws(
    () => runOrThrow('node', ['-e', 'setTimeout(() => {}, 1000)'], { timeout: 1, stdio: 'pipe' }),
    /node -e setTimeout\(\(\) => \{\}, 1000\) timed out after 1 ms/
  );
});

test('package configuration defines platform-specific Electron distribution targets', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')
  );

  assert.match(packageJson.homepage, /^https:\/\/github\.com\/SwimmingLiu\/auto-vpn/);
  assert.equal(packageJson.author.name, 'SwimmingLiu');
  assert.match(packageJson.author.email, /@users\.noreply\.github\.com$/);
  assert.match(packageJson.build.linux.maintainer, /^SwimmingLiu <.+@users\.noreply\.github\.com>$/);
  assert.equal(packageJson.build.productName, 'AutoVPN');
  assert.deepEqual(packageJson.build.mac.target, ['dmg']);
  assert.deepEqual(packageJson.build.linux.target, ['AppImage', 'deb', 'rpm']);
  assert.deepEqual(packageJson.build.win.target, ['nsis', 'portable']);
  assert.equal(packageJson.build.dmg.artifactName, '${productName}-${version}-${arch}.${ext}');
  assert.equal(packageJson.build.appImage.artifactName, '${productName}-${version}-${arch}.${ext}');
  assert.equal(packageJson.build.deb.artifactName, '${productName}-${version}-${arch}.${ext}');
  assert.equal(packageJson.build.rpm.artifactName, '${productName}-${version}-${arch}.${ext}');
  assert.equal(packageJson.build.nsis.artifactName, '${productName}-${version}-${arch}-setup.${ext}');
  assert.equal(packageJson.build.portable.artifactName, '${productName}-${version}-${arch}-portable.${ext}');
  assert.ok(packageJson.build.files.includes('!electron/tests/**/*'));
});

test('cleanElectronOutputDir removes stale packaged app artifacts before packaging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-package-output-'));
  const projectRoot = path.join(root, 'vpn-subscription-automation');
  const outputDir = path.join(projectRoot, 'dist-electron');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'VPN Subscription Automation-0.2.0-arm64.dmg'), '', 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'builder-effective-config.yaml'), 'productName: old', 'utf-8');

  cleanElectronOutputDir(projectRoot);

  assert.equal(fs.existsSync(outputDir), false);
});

test('resolveShareWorkerPaths points packaging to the source vpn.js and bundled runtime copy', () => {
  const projectRoot = '/tmp/workspace/vpn-subscription-automation';
  const shareWorkerPaths = resolveShareWorkerPaths(projectRoot);

  assert.equal(
    shareWorkerPaths.sourcePath,
    '/tmp/workspace/vpn-subscription-automation/templates/share-worker/vpn.js'
  );
  assert.deepEqual(shareWorkerPaths.sourceCandidates, [
    '/tmp/workspace/vpn-subscription-automation/templates/share-worker/vpn.js',
    '/tmp/workspace/cloudflarevpn/edgetunnel/vpn.js'
  ]);
  assert.equal(
    shareWorkerPaths.runtimePath,
    '/tmp/workspace/vpn-subscription-automation/electron/runtime/share-worker/vpn.js'
  );
});

test('stageShareWorkerRuntime copies repo template vpn.js into the packaged runtime tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-share-worker-'));
  const workspaceRoot = path.join(root, 'workspace');
  const projectRoot = path.join(workspaceRoot, 'vpn-subscription-automation');
  const shareWorkerSource = path.join(projectRoot, 'templates', 'share-worker', 'vpn.js');

  fs.mkdirSync(path.dirname(shareWorkerSource), { recursive: true });
  fs.writeFileSync(shareWorkerSource, "export default { async fetch() { return new Response('login'); } }", 'utf-8');

  const runtimePath = stageShareWorkerRuntime(projectRoot);

  assert.equal(
    runtimePath,
    path.join(projectRoot, 'electron', 'runtime', 'share-worker', 'vpn.js')
  );
  assert.equal(fs.readFileSync(runtimePath, 'utf-8'), fs.readFileSync(shareWorkerSource, 'utf-8'));
});
