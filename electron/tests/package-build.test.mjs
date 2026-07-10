import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as packageBuild from '../build/package.mjs';
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
  cleanElectronOutputDir,
  resolveIconPaths,
  resolveLiveProfilePath,
  sanitizeBundledProfileToml,
  stageBundledProfileForPackaging,
  resolveShareWorkerPaths,
  buildCommandSpawnOptions,
  runOrThrow,
  retryOperation,
  shouldBundlePlaywrightBrowserRuntime,
  stagePlaywrightBrowserRuntime,
  stageShareWorkerRuntime
} from '../build/package.mjs';

test('resolveAutoVpnCliRuntimePaths stages the packaged CLI under electron runtime', () => {
  assert.equal(typeof packageBuild.resolveAutoVpnCliRuntimePaths, 'function');
  const paths = packageBuild.resolveAutoVpnCliRuntimePaths('/tmp/project');

  assert.equal(paths.sourceRoot, '/tmp/project/npm/autovpn-cli');
  assert.equal(paths.runtimeRoot, '/tmp/project/electron/runtime/autovpn-cli');
  assert.equal(paths.runtimeEntry, '/tmp/project/electron/runtime/autovpn-cli/bin/autovpn.mjs');
});

test('stageAutoVpnCliRuntime builds, copies, and installs the production CLI', () => {
  assert.equal(typeof packageBuild.stageAutoVpnCliRuntime, 'function');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-staged-cli-'));
  const sourceRoot = path.join(projectRoot, 'npm', 'autovpn-cli');
  for (const relativePath of ['bin/autovpn.mjs', 'dist/cli/main.js']) {
    const filePath = path.join(sourceRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, relativePath, 'utf-8');
  }
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: '@swimmingliu/autovpn' }), 'utf-8');
  fs.writeFileSync(path.join(sourceRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }), 'utf-8');
  const staleFile = path.join(projectRoot, 'electron', 'runtime', 'autovpn-cli', 'node_modules', 'stale.txt');
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(staleFile, 'stale', 'utf-8');
  const calls = [];

  const staged = packageBuild.stageAutoVpnCliRuntime(projectRoot, {
    run: (command, args, options) => calls.push({ command, args, options })
  });

  assert.equal(fs.readFileSync(staged.runtimeEntry, 'utf-8'), 'bin/autovpn.mjs');
  assert.equal(fs.existsSync(path.join(staged.runtimeRoot, 'dist', 'cli', 'main.js')), true);
  assert.equal(fs.existsSync(staleFile), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(staged.runtimeRoot, 'package-lock.json'), 'utf-8')),
    { lockfileVersion: 3 }
  );
  assert.deepEqual(packageBuild.buildAutoVpnCliProductionInstallArgs(staged.runtimeRoot), [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--prefix',
    staged.runtimeRoot
  ]);
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'npm', args: ['run', 'build', '--prefix', sourceRoot] },
    { command: 'npm', args: packageBuild.buildAutoVpnCliProductionInstallArgs(staged.runtimeRoot) }
  ]);
});

test('removeLegacyRuntimeArtifacts deletes stale vendor content before packaging', () => {
  assert.equal(typeof packageBuild.removeLegacyRuntimeArtifacts, 'function');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-stale-python-runtime-'));
  const vendorRoot = path.join(projectRoot, 'electron', 'runtime', 'python-vendor');
  fs.mkdirSync(vendorRoot, { recursive: true });
  fs.writeFileSync(path.join(vendorRoot, 'dependency.py'), 'stale', 'utf-8');

  packageBuild.removeLegacyRuntimeArtifacts(projectRoot);

  assert.equal(fs.existsSync(vendorRoot), false);
});

test('cleanGeneratedRuntimeArtifacts removes stale generated dirs but preserves seed and share source', () => {
  assert.equal(typeof packageBuild.cleanGeneratedRuntimeArtifacts, 'function');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-clean-runtime-'));
  const runtimeRoot = path.join(projectRoot, 'electron', 'runtime');
  const seedPath = path.join(runtimeRoot, 'default-profile.toml');
  const shareSource = path.join(projectRoot, 'templates', 'share-worker', 'vpn.js');
  for (const generatedDir of ['autovpn-cli', 'node-vendor', 'playwright-browsers', 'share-worker']) {
    fs.mkdirSync(path.join(runtimeRoot, generatedDir), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, generatedDir, 'stale.txt'), 'stale', 'utf-8');
  }
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  fs.writeFileSync(seedPath, 'seed', 'utf-8');
  fs.mkdirSync(path.dirname(shareSource), { recursive: true });
  fs.writeFileSync(shareSource, 'source', 'utf-8');

  packageBuild.cleanGeneratedRuntimeArtifacts(projectRoot, { bundlePlaywrightBrowser: false });

  for (const generatedDir of ['autovpn-cli', 'node-vendor', 'playwright-browsers', 'share-worker']) {
    assert.equal(fs.existsSync(path.join(runtimeRoot, generatedDir)), false);
  }
  assert.equal(fs.readFileSync(seedPath, 'utf-8'), 'seed');
  assert.equal(fs.readFileSync(shareSource, 'utf-8'), 'source');
});

test('Electron package inputs contain only Node runtime manifests and staged CLI content', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
  const packageInputs = packageJson.build.files;
  const packageSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'build', 'package.mjs'), 'utf-8');

  assert.ok(packageInputs.includes('electron/**/*'));
  assert.ok(packageInputs.includes('templates/**/*'));
  assert.equal(packageInputs.some((entry) => /(^|\/)src(\/|$)/.test(entry)), false);
  assert.equal(packageInputs.some((entry) => /pyproject\.toml|python-vendor/i.test(entry)), false);
  assert.doesNotMatch(packageSource, /RUNTIME_PYTHON_DEPENDENCIES|stagePythonVendorRuntime|buildPythonVendorInstallArgs/);
  assert.match(packageSource, /removeLegacyRuntimeArtifacts\(projectRoot\)/);
});

test('staged packaged CLI executes version and profile commands', () => {
  assert.equal(typeof packageBuild.stageAutoVpnCliRuntime, 'function');
  const sourceProjectRoot = process.cwd();
  const sourceCliRoot = path.join(sourceProjectRoot, 'npm', 'autovpn-cli');
  if (!fs.existsSync(path.join(sourceCliRoot, 'dist', 'cli', 'main.js'))) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const build = spawnSync(npmCommand, ['run', 'build', '--prefix', sourceCliRoot], { encoding: 'utf-8' });
    assert.equal(build.status, 0, build.stderr || build.stdout);
  }

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-packaged-cli-smoke-'));
  const testSourceRoot = path.join(projectRoot, 'npm', 'autovpn-cli');
  fs.mkdirSync(testSourceRoot, { recursive: true });
  for (const entry of ['bin', 'dist']) {
    fs.cpSync(path.join(sourceCliRoot, entry), path.join(testSourceRoot, entry), { recursive: true });
  }
  fs.copyFileSync(path.join(sourceCliRoot, 'package.json'), path.join(testSourceRoot, 'package.json'));
  fs.copyFileSync(path.join(sourceCliRoot, 'package-lock.json'), path.join(testSourceRoot, 'package-lock.json'));
  const staged = packageBuild.stageAutoVpnCliRuntime(projectRoot, { run: () => {} });
  fs.cpSync(path.join(sourceCliRoot, 'node_modules'), path.join(staged.runtimeRoot, 'node_modules'), { recursive: true });

  const version = spawnSync(process.execPath, [staged.runtimeEntry, '--version'], { encoding: 'utf-8' });
  assert.equal(version.status, 0, version.stderr || version.stdout);
  assert.match(version.stdout, /^autovpn \d+\.\d+\.\d+\n$/);

  const runtimeRoot = path.join(projectRoot, 'state');
  const profile = spawnSync(process.execPath, [staged.runtimeEntry, 'profile', 'show', '--project-root', projectRoot], {
    encoding: 'utf-8',
    env: { ...process.env, VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }
  });
  assert.equal(profile.status, 0, profile.stderr || profile.stdout);
  assert.equal(JSON.parse(profile.stdout).paths.profile_path, path.join(runtimeRoot, 'profile.toml'));
});

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

test('sanitizeBundledProfileToml blanks source and deploy credentials', () => {
  const sanitized = sanitizeBundledProfileToml(`[sources.fixture]
url = "PRIVATE_VALUE_1"
key = "PRIVATE_VALUE_2"
enabled = true

[deploy]
project_name = "structural-default"
subscription_url = "PRIVATE_VALUE_3"
verify_subscription_url = "PRIVATE_VALUE_4"
secret_query = "PRIVATE_VALUE_5"
account_id = "PRIVATE_VALUE_6"
cloudflare_api_token = "PRIVATE_VALUE_7"
cloudflare_global_key = "PRIVATE_VALUE_8"
cloudflare_email = "PRIVATE_VALUE_9"
pages_secret_admin = "PRIVATE_VALUE_10"
cloudflare_auth_mode = "api_token"
`);

  assert.doesNotMatch(sanitized, /PRIVATE_VALUE_/);
  assert.match(sanitized, /\[sources\.fixture\]\nurl = ""\nkey = ""\nenabled = true/);
  assert.match(sanitized, /project_name = "structural-default"/);
  assert.match(sanitized, /cloudflare_auth_mode = "api_token"/);
  assert.equal((sanitized.match(/= ""/g) ?? []).length, 10);
});

test('sanitizeBundledProfileToml structurally blanks multiline and inline credentials', () => {
  const sanitized = sanitizeBundledProfileToml(`[sources]
fixture = { url = "PRIVATE_VALUE_1", key = "PRIVATE_VALUE_2", enabled = true }

[deploy]
cloudflare_api_token = """PRIVATE_VALUE_3"""
pages_secret_admin = "PRIVATE_VALUE_4"
cloudflare_auth_mode = "api_token"
`);

  assert.doesNotMatch(sanitized, /PRIVATE_VALUE_/);
  assert.match(sanitized, /cloudflare_auth_mode/);
});

test('packaging profile staging always uses the sanitized default seed', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-packaged-profile-'));
  const runtimeDir = path.join(projectRoot, 'electron', 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'state'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'default-profile.toml'), '[sources.fixture]\nurl = "PRIVATE_VALUE_2"\nkey = "PRIVATE_VALUE_3"\n\n[deploy]\nproject_name = "default-seed"\nsecret_query = "PRIVATE_VALUE_4"\npages_secret_admin = "PRIVATE_VALUE_5"\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'state', 'profile.toml'), '[deploy]\nproject_name = "live-state"\nsecret_query = "PRIVATE_VALUE_1"\n', 'utf8');

  const bundledPath = stageBundledProfileForPackaging(projectRoot);
  const bundled = fs.readFileSync(bundledPath, 'utf8');

  assert.match(bundled, /project_name = "default-seed"/);
  assert.doesNotMatch(bundled, /live-state|PRIVATE_VALUE_/);
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
  assert.deepEqual(buildElectronBuilderArgs(), ['electron-builder', '--mac', 'dmg', '--publish', 'never']);
});

test('buildElectronBuilderArgs appends legacy macOS-compatible architecture flags explicitly', () => {
  assert.deepEqual(buildElectronBuilderArgs(['dmg'], ['x64', 'arm64', 'armv7l']), [
    'electron-builder',
    '--mac',
    'dmg',
    '--x64',
    '--arm64',
    '--publish',
    'never'
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
    ['electron-builder', '--mac', 'dmg', '--x64', '--publish', 'never']
  );

  assert.deepEqual(
    buildElectronBuilderArgs({
      platforms: ['linux'],
      archs: ['x64', 'arm64']
    }),
    ['electron-builder', '--linux', 'deb', 'rpm', '--x64', '--arm64', '--publish', 'never']
  );

  assert.deepEqual(
    buildElectronBuilderArgs({
      platforms: ['win'],
      archs: ['arm64']
    }),
    ['electron-builder', '--win', 'nsis', 'portable', '--arm64', '--publish', 'never']
  );
});

test('buildElectronBuilderArgs only emits architecture flags supported by every selected platform', () => {
  assert.deepEqual(
    buildElectronBuilderArgs({
      platforms: ['linux', 'win'],
      archs: ['x64', 'ia32']
    }),
    ['electron-builder', '--linux', 'deb', 'rpm', '--win', 'nsis', 'portable', '--x64', '--publish', 'never']
  );
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

test('buildCommandSpawnOptions uses a Windows shell for npm commands only', () => {
  assert.equal(buildCommandSpawnOptions('node', {}, 'win32').shell, false);
  assert.equal(buildCommandSpawnOptions('npm', {}, 'win32').shell, true);
  assert.equal(buildCommandSpawnOptions('npx', {}, 'win32').shell, true);
});

test('buildCommandSpawnOptions streams package command output by default', () => {
  assert.equal(buildCommandSpawnOptions('node').stdio, 'inherit');
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
  assert.deepEqual(packageJson.build.linux.target, ['deb', 'rpm']);
  assert.deepEqual(packageJson.build.win.target, ['nsis', 'portable']);
  assert.equal(packageJson.build.dmg.writeUpdateInfo, false);
  assert.equal(packageJson.build.nsis.differentialPackage, false);
  assert.equal(packageJson.build.dmg.artifactName, '${productName}-${version}-${arch}.${ext}');
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
