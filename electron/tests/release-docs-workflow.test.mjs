import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

function readProjectFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), 'utf-8');
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
    'python -m pip install -e .[dev]',
    './scripts/run_pytest.sh tests -v',
    'npx playwright install chromium-headless-shell',
    'test_files = sorted(glob.glob("electron/tests/*.test.mjs"))',
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
});
