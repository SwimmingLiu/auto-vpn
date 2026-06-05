import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();

function readProjectFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), 'utf-8');
}

function extractReleaseTagValidationScript(workflow) {
  const startMarker = 'PKG_VERSION="$(node -p "require(\'./package.json\').version")"';
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf('git fetch --no-tags origin main:refs/remotes/origin/main', start);

  assert.notEqual(start, -1, 'workflow should define package version lookup before tag validation');
  assert.notEqual(end, -1, 'workflow should fetch origin/main after tag validation');

  return workflow.slice(start, end).replace(/^          /gm, '').trim();
}

function extractWorkflowSegment(workflow, startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker, start);

  assert.notEqual(start, -1, `workflow should contain ${startMarker}`);
  assert.notEqual(end, -1, `workflow should contain ${endMarker} after ${startMarker}`);

  return workflow.slice(start, end);
}

function runReleaseTagValidation(script, { version, tagName }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-release-tag-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version }), 'utf-8');
    return spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: tempDir,
      env: {
        ...process.env,
        TAG_NAME: tagName
      },
      encoding: 'utf-8'
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('README follows the AutoVPN desktop app structure', () => {
  const readme = readProjectFile('README.md');

  assert.match(readme, /^# AutoVPN/m);
  assert.match(readme, /!\[AutoVPN desktop screenshot\]\(assets\/vpn-sub-[^)]+\.png\)/);

  for (const section of [
    'Features',
    'Tech Stack',
    'Installation',
    'Project Structure',
    'Development',
    'Release Packaging',
    'Trust & Security',
    'License'
  ]) {
    assert.match(readme, new RegExp(`^## .*${section}`, 'm'));
  }

  for (const requiredText of [
    'Cloudflare Pages',
    'state/profile.toml',
    'npm run package:electron',
    'electron/renderer/assets/vpn-auto-logo-v2-minimal.svg',
    'AutoVPN-<version>-arm64.dmg',
    'AutoVPN-<version>-x86_64.AppImage',
    'AutoVPN-<version>-amd64.deb',
    'AutoVPN-<version>-aarch64.rpm',
    'AutoVPN-<version>-arm64.deb',
    'AutoVPN-<version>-x64-setup.exe',
    'AutoVPN-<version>-arm64-portable.exe'
  ]) {
    assert.ok(readme.includes(requiredText), `README should mention ${requiredText}`);
  }

  assert.ok(readme.includes('SwimmingLiu/auto-vpn/releases'));
  assert.ok(readme.includes('SwimmingLiu/auto-vpn/actions'));
  assert.doesNotMatch(readme, /SwimmingLiu\/vpn-subscription-automation/);
  assert.doesNotMatch(readme, /\/Users\/swimmingliu/);
  assert.doesNotMatch(readme, /\/user\/swimmingliu/i);
});

test('release workflow packages AutoVPN for native OS and CPU variants after a GitHub Release is published', () => {
  const workflow = readProjectFile('.github', 'workflows', 'release-electron.yml');
  const testJob = extractWorkflowSegment(workflow, '  test:', '  package-electron:');
  const packageInstallAndBuild = extractWorkflowSegment(
    workflow,
    '      - name: Install dependencies\n        run: |\n          for attempt in 1 2',
    '      - name: Verify project icon was packaged'
  );
  const packageInstallStep = extractWorkflowSegment(
    workflow,
    '      - name: Install dependencies\n        run: |\n          for attempt in 1 2',
    '      - name: Package Electron app'
  );

  for (const requiredText of [
    'release:',
    'types: [published]',
    'contents: write',
    'fetch-depth: 0',
    'test:',
    'package-electron:',
    'needs: test',
    'Check release tag and package version',
    'PKG_VERSION="$(node -p "require(\'./package.json\').version")"',
    'TAG_NAME: ${{ github.event.release.tag_name }}',
    'EXPECTED_TAG="v${PKG_VERSION}"',
    'Release tag ${TAG_NAME} does not match package.json version ${PKG_VERSION}',
    'git fetch --no-tags origin main:refs/remotes/origin/main',
    'TAG_COMMIT="$(git rev-list -n 1 "${TAG_NAME}")"',
    'git merge-base --is-ancestor "${TAG_COMMIT}" origin/main',
    'Release tag ${TAG_NAME} is not contained in origin/main',
    'fail-fast: false',
    'package_platform: mac',
    'package_platform: linux',
    'package_platform: win',
    'package_arch: x64',
    'package_arch: arm64',
    'runs-on: macos-latest',
    'runs-on: ${{ matrix.os }}',
    'ubuntu-24.04',
    'ubuntu-24.04-arm',
    'windows-2025',
    'windows-11-arm',
    'node-version: 24',
    'python-version: "3.12"',
    'npm ci',
    'for attempt in 1 2',
    'npm ci && break',
    'npm ci failed; retrying in 15 seconds.',
    'Cache Playwright browser runtime',
    'uses: actions/cache@v4',
    'path: electron/runtime/playwright-browsers',
    "key: playwright-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}",
    'playwright-${{ runner.os }}-${{ runner.arch }}-',
    'Install Playwright browser runtime',
    'timeout-minutes: 15',
    'PLAYWRIGHT_BROWSERS_PATH: electron/runtime/playwright-browsers',
    'npx playwright install chromium-headless-shell',
    './scripts/run_pytest.sh tests -v',
    'test_files = sorted(glob.glob("electron/tests/*.test.mjs"))',
    'browser_dependent_tests = {',
    "'app-launch.test.mjs'",
    "'renderer-e2e.test.mjs'",
    "'renderer-visual.test.mjs'",
    'test_files = [test_file for test_file in test_files if os.path.basename(test_file) not in browser_dependent_tests]',
    'process.wait(timeout=600)',
    'Electron tests timed out after 600 seconds.',
    'npm run package:electron',
    'set -o pipefail',
    'AUTOVPN_PACKAGE_PLATFORM: ${{ matrix.package_platform }}',
    'AUTOVPN_PACKAGE_ARCH: ${{ matrix.package_arch }}',
    'default Electron icon is used',
    'electron/renderer/assets/vpn-auto-logo-v2-minimal.svg',
    'AutoVPN.app/Contents/Resources',
    'AutoVPN-${PKG_VERSION}-${{ matrix.package_arch }}.dmg',
    'AutoVPN-${PKG_VERSION}-${{ matrix.package_arch }}.dmg.blockmap',
    'AutoVPN-${PKG_VERSION}-x86_64.AppImage',
    'AutoVPN-${PKG_VERSION}-amd64.deb',
    'AutoVPN-${PKG_VERSION}-x86_64.rpm',
    'AutoVPN-${PKG_VERSION}-aarch64.rpm',
    'AutoVPN-${PKG_VERSION}-${{ matrix.package_arch }}-setup.exe',
    'AutoVPN-${PKG_VERSION}-${{ matrix.package_arch }}-portable.exe',
    'Missing release artifact: ${artifact}',
    'dist-electron/**/*.AppImage',
    'dist-electron/**/*.deb',
    'dist-electron/**/*.rpm',
    'dist-electron/**/*.exe',
    'softprops/action-gh-release',
    'tag_name: ${{ github.event.release.tag_name }}',
    'dist-electron/**/*.dmg',
    'dist-electron/**/*.blockmap'
  ]) {
    assert.ok(workflow.includes(requiredText), `workflow should contain ${requiredText}`);
  }

  assert.doesNotMatch(workflow, /dist-electron\/\*\*\/\*\.zip/);
  assert.doesNotMatch(workflow, /dist-electron\/\*\*\/\*\.yml/);
  assert.match(testJob, /python -m pip install -e \.\[dev\]/);
  assert.doesNotMatch(packageInstallAndBuild, /python -m pip install -e \.\[dev\]/);
  assert.match(packageInstallStep, /shell: bash/);
});

test('release renderer tests use the headless shell installed by the workflow', () => {
  const workflow = readProjectFile('.github', 'workflows', 'release-electron.yml');
  assert.doesNotMatch(workflow, /Install Playwright browsers for tests/);
  assert.doesNotMatch(workflow, /command = \["npx", "playwright", "install", "chromium-headless-shell"\]/);
  assert.doesNotMatch(workflow, /command = \["npx", "playwright", "install", "chromium", "--no-shell"\]/);

  for (const testFile of ['renderer-e2e.test.mjs', 'renderer-visual.test.mjs']) {
    const source = readProjectFile('electron', 'tests', testFile);
    assert.doesNotMatch(source, /channel: 'chromium'/, `${testFile} should not force full Chromium`);
    assert.match(source, /chromium\.launch\(\)/, `${testFile} should rely on the installed headless shell`);
  }
});

test('release workflow accepts short minor tags only for zero patch releases', () => {
  const workflow = readProjectFile('.github', 'workflows', 'release-electron.yml');
  const script = extractReleaseTagValidationScript(workflow);

  for (const tagName of ['v1.1.0', 'v1.1']) {
    const result = runReleaseTagValidation(script, { version: '1.1.0', tagName });
    assert.equal(result.status, 0, `${tagName} should be accepted: ${result.stderr}${result.stdout}`);
  }

  const patchResult = runReleaseTagValidation(script, { version: '1.1.1', tagName: 'v1.1' });
  assert.notEqual(patchResult.status, 0, 'v1.1 should not be accepted for package version 1.1.1');
  assert.match(patchResult.stdout, /Expected v1\.1\.1\./);

  const emptyTagResult = runReleaseTagValidation(script, { version: '1.1.1', tagName: '' });
  assert.notEqual(emptyTagResult.status, 0, 'empty release tags should fail');
  assert.match(emptyTagResult.stdout, /Expected v1\.1\.1\./);

  const wrongResult = runReleaseTagValidation(script, { version: '1.1.0', tagName: 'v1.2' });
  assert.notEqual(wrongResult.status, 0, 'mismatched minor tags should fail');
  assert.match(wrongResult.stdout, /Expected v1\.1\.0 or v1\.1\./);
});
