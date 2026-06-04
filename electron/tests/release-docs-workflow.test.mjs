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
    'electron/renderer/assets/vpn-auto-logo-v2-minimal.svg'
  ]) {
    assert.ok(readme.includes(requiredText), `README should mention ${requiredText}`);
  }
});

test('release workflow packages AutoVPN after a GitHub Release is published', () => {
  const workflow = readProjectFile('.github', 'workflows', 'release-electron.yml');

  for (const requiredText of [
    'release:',
    'types: [published]',
    'contents: write',
    'runs-on: macos-latest',
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
    'default Electron icon is used',
    'AutoVPN.app/Contents/Resources',
    'softprops/action-gh-release',
    'tag_name: ${{ github.event.release.tag_name }}',
    'dist-electron/**/*.dmg',
    'dist-electron/**/*.blockmap'
  ]) {
    assert.ok(workflow.includes(requiredText), `workflow should contain ${requiredText}`);
  }

  assert.doesNotMatch(workflow, /dist-electron\/\*\*\/\*\.yml/);
});
