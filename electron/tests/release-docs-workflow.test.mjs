import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';

const projectRoot = process.cwd();

function readProjectFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), 'utf-8');
}

function extractReleaseTagValidationScript(workflow) {
  const startMarker = 'PKG_VERSION="$(node -p "require(\'./package.json\').version")"';
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf('bash scripts/ci/retry-command.sh "fetch origin/main"', start);

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

function extractNamedStep(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow should contain step ${name}`);
  const end = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

function testFilesFromScript(script) {
  return [...script.matchAll(/electron\/tests\/([\w-]+\.test\.mjs)/g)].map((match) => match[1]);
}

function assertWorkflowTestGates(workflow, packageJson, allFiles) {
  const scripts = packageJson.scripts;
  const normalizeCommand = (command) => command.trim().replace(/\s+/g, ' ');
  const h5FilesExpected = [
    'mobile-layout-contract.test.mjs',
    'web-server-e2e.test.mjs',
    'web-server-visual.test.mjs'
  ];
  const nativeFilesExpected = allFiles.filter((file) => !h5FilesExpected.includes(file));
  const commandFor = (files) => `node --test --test-concurrency=1 ${files.map((file) => `electron/tests/${file}`).join(' ')}`;
  assert.equal(normalizeCommand(scripts['test:h5']), commandFor(h5FilesExpected), 'H5 script must match the exact approved command');
  assert.equal(normalizeCommand(scripts['test:electron-native']), commandFor(nativeFilesExpected), 'native script must match the exact approved command');
  const parsedWorkflow = parseYaml(workflow);
  const rejectVisualBaselineUpdateEnv = (node) => {
    if (!node || typeof node !== 'object') return;
    if (!Array.isArray(node) && node.env && typeof node.env === 'object') {
      assert.equal(Object.hasOwn(node.env, 'UPDATE_VISUAL_BASELINES'), false, 'CI must never update reviewed visual baselines');
    }
    for (const value of Array.isArray(node) ? node : Object.values(node)) rejectVisualBaselineUpdateEnv(value);
  };
  rejectVisualBaselineUpdateEnv(parsedWorkflow);

  const h5Files = testFilesFromScript(scripts['test:h5']);
  const nativeFiles = testFilesFromScript(scripts['test:electron-native']);
  assert.deepEqual([...new Set([...h5Files, ...nativeFiles])].sort(), allFiles, 'gate scripts must cover every Electron test');
  assert.equal(new Set([...h5Files, ...nativeFiles]).size, h5Files.length + nativeFiles.length, 'gate scripts must cover tests exactly once');

  for (const [name, exactCommand] of [
    ['Run H5 mobile Chromium and WebKit gate', 'npm run test:h5'],
    ['Run Electron native and desktop gate', 'npm run test:electron-native']
  ]) {
    const step = extractNamedStep(workflow, name);
    const runLines = [...step.matchAll(/^\s+run:\s*(.*?)\s*$/gm)].map((match) => match[1]);
    assert.deepEqual(runLines, [exactCommand], `${name} must run only ${exactCommand}`);
    assert.doesNotMatch(step, /^\s+(?:continue-on-error|if):/m, `${name} must be unconditional and fail closed`);
  }
}

function runReleaseTagValidation(script, { version, tagName }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-release-tag-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version }), 'utf-8');
    fs.mkdirSync(path.join(tempDir, 'npm', 'autovpn-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'npm', 'autovpn-cli', 'package.json'),
      JSON.stringify({ version }),
      'utf-8'
    );
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
  assert.match(readme, /!\[AutoVPN desktop intro\]\(assets\/intro\.png\)/);

  for (const section of [
    'Tech Stack',
    'Installation',
    'Project Structure',
    'Runtime Configuration',
    'License'
  ]) {
    assert.match(readme, new RegExp(`^## .*${section}`, 'm'));
  }

  for (const removedSection of [
    'Features',
    'CLI Quickstart',
    'Development',
    'Release Packaging',
    'Trust & Security'
  ]) {
    assert.doesNotMatch(readme, new RegExp(`^## .*${removedSection}`, 'm'));
  }

  for (const requiredText of [
    'Cloudflare Pages',
    '$HOME/.auto-vpn/profile.toml',
    'GitHub Releases](https://github.com/SwimmingLiu/auto-vpn/releases/latest)',
    'badge.svg?event=push',
    '.dmg` for Apple Silicon or Intel',
    '.deb` or `.rpm` for x64 or ARM64',
    'portable `.exe` for x64 or ARM64',
    'export AUTOVPN_VERSION=1.8.0',
    'npm install -g @swimmingliu/autovpn',
    'autovpn --version',
    'autovpn doctor --project-root',
    'Node.js `>=22.5.0`',
    'swimmingliu-autovpn-${AUTOVPN_VERSION}.tgz',
    'VPN_AUTOMATION_RUNTIME_ROOT',
    'GNU Affero General Public License v3.0',
    '[LICENSE](LICENSE)'
  ]) {
    assert.ok(readme.includes(requiredText), `README should mention ${requiredText}`);
  }

  assert.ok(readme.includes('SwimmingLiu/auto-vpn/releases'));
  assert.ok(readme.includes('SwimmingLiu/auto-vpn/actions'));
  assert.doesNotMatch(readme, /SwimmingLiu\/vpn-subscription-automation/);
  assert.doesNotMatch(readme, /vpn-subscription-automation/);
  assert.doesNotMatch(readme, /proprietary software/i);
  assert.doesNotMatch(readme, /commercial purposes/i);
  assert.doesNotMatch(readme, /\/Users\/swimmingliu/);
  assert.doesNotMatch(readme, /\/user\/swimmingliu/i);
});

test('release workflow packages AutoVPN for native OS and CPU variants after a GitHub Release is published', () => {
  const workflow = readProjectFile('.github', 'workflows', 'release-electron.yml');
  const testJob = extractWorkflowSegment(workflow, '  test:', '  package-electron:');
  const packageJob = extractWorkflowSegment(workflow, '  package-electron:', '  package-cli:');
  const packageCliJob = extractWorkflowSegment(workflow, '  package-cli:', '  publish-release-notes:');
  const packageInstallAndBuild = extractWorkflowSegment(
    packageJob,
    '      - name: Install dependencies\n        run: |\n          bash scripts/ci/retry-command.sh "npm ci"',
    '      - name: Verify project icon was packaged'
  );
  const packageInstallStep = extractWorkflowSegment(
    packageJob,
    '      - name: Install dependencies\n        run: |\n          bash scripts/ci/retry-command.sh "npm ci"',
    '      - name: Package Electron app'
  );

  for (const requiredText of [
    'release:',
    'types: [published]',
    'push:',
    'tags:',
    "'v*.*'",
    "'v*.*.*'",
    'workflow_dispatch:',
    'tag_name:',
    'RELEASE_TAG_NAME: ${{ github.event.inputs.tag_name || github.event.release.tag_name || github.ref_name }}',
    'contents: write',
    'id-token: write',
    'fetch-depth: 0',
    'test:',
    'prepare-release:',
    'package-cli:',
    'package-electron:',
    'needs: test',
    'needs: prepare-release',
    'gh release create "${RELEASE_TAG_NAME}"',
    'Release ${RELEASE_TAG_NAME} already exists; keeping it.',
    'Check release tag and package version',
    'PKG_VERSION="$(node -p "require(\'./package.json\').version")"',
    'TAG_NAME: ${{ env.RELEASE_TAG_NAME }}',
    'EXPECTED_TAG="v${PKG_VERSION}"',
    'Release tag ${TAG_NAME} does not match package.json version ${PKG_VERSION}',
    'git fetch --no-tags origin main:refs/remotes/origin/main',
    'scripts/ci/retry-command.sh "fetch origin/main"',
    'TAG_COMMIT="$(git rev-list -n 1 "${TAG_NAME}")"',
    'git merge-base --is-ancestor "${TAG_COMMIT}" origin/main',
    'Release tag ${TAG_NAME} is not contained in origin/main',
    'fail-fast: false',
    'max-parallel: 2',
    'package_platform: mac',
    'package_platform: linux',
    'package_platform: win',
    'package_arch: x64',
    'package_arch: arm64',
    'os: macos-latest',
    'runs-on: ${{ matrix.os }}',
    'ubuntu-24.04',
    'ubuntu-24.04-arm',
    'windows-2025',
    'windows-11-arm',
    'node-version: 24',
    'cache-dependency-path:',
    'npm/autovpn-cli/package-lock.json',
    'NPM_CONFIG_FETCH_RETRIES: "5"',
    'NPM_CONFIG_FETCH_TIMEOUT: "600000"',
    'NPM_CONFIG_PREFER_OFFLINE: "true"',
    'registry-url: https://registry.npmjs.org',
    'npm ci',
    'scripts/ci/retry-command.sh "npm ci"',
    '--prefer-offline --no-audit --fund=false',
    'scripts/ci/retry-command.sh "npm ci --prefix npm/autovpn-cli"',
    'Build npm CLI web server',
    'npm run build --prefix npm/autovpn-cli',
    'Install pinned Playwright Chromium and WebKit runtimes',
    'npx playwright install --with-deps chromium-headless-shell webkit',
    'npm run test:h5',
    'npm run test:electron-native',
    'Upload renderer visual diffs',
    'electron/tests/visual-artifacts/**',
    'npm run package:electron',
    'bash -eo pipefail -c',
    'AUTOVPN_PACKAGE_PLATFORM: ${{ matrix.package_platform }}',
    'AUTOVPN_PACKAGE_ARCH: ${{ matrix.package_arch }}',
    'default Electron icon is used',
    'electron/renderer/assets/vpn-auto-logo-v2-minimal.svg',
    'find dist-electron -type f -path "*/AutoVPN.app/Contents/Resources/*.icns"',
    'AutoVPN.app/Contents/Resources',
    'AutoVPN-${PKG_VERSION}-${{ matrix.package_arch }}.dmg',
    'AutoVPN-${PKG_VERSION}-amd64.deb',
    'AutoVPN-${PKG_VERSION}-x86_64.rpm',
    'AutoVPN-${PKG_VERSION}-aarch64.rpm',
    'AutoVPN-${PKG_VERSION}-${{ matrix.package_arch }}-setup.exe',
    'AutoVPN-${PKG_VERSION}-${{ matrix.package_arch }}-portable.exe',
    'Missing release artifact: ${artifact}',
    'upload ${asset_name}',
    'existing_assets="$(gh release view "${RELEASE_TAG_NAME}" --repo "${GITHUB_REPOSITORY}" --json assets --jq \'.assets[].name\')"',
    'already exists on ${RELEASE_TAG_NAME}; skipping upload.',
    'gh release upload "${RELEASE_TAG_NAME}" "${release_file}" --repo "${GITHUB_REPOSITORY}"',
    'npm test --prefix npm/autovpn-cli',
    'npm pack --json --pack-destination ../../dist',
    'Publish npm CLI package',
    'NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
    'npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version --registry=https://registry.npmjs.org',
    'Publishing ${PACKAGE_NAME}@${PACKAGE_VERSION} with NPM_TOKEN.',
    'Publishing ${PACKAGE_NAME}@${PACKAGE_VERSION} with npm trusted publishing/OIDC.',
    'PACKAGE_TARBALL="./dist/swimmingliu-autovpn-${PACKAGE_VERSION}.tgz"',
    'npm publish "${PACKAGE_TARBALL}" --access public --provenance --registry=https://registry.npmjs.org',
    'verify npm publication visibility',
    'is visible after a failed publish response; treating publish as complete.',
    'upload ${asset_name}',
    'already exists on ${RELEASE_TAG_NAME}; skipping upload.',
    'dist/swimmingliu-autovpn-${PKG_VERSION}.tgz',
    'publish-release-notes:',
    'node scripts/generate-release-notes.mjs',
    'update release notes',
    'gh release edit "${RELEASE_TAG_NAME}"',
    'AutoVPN ${RELEASE_TAG_NAME}'
  ]) {
    assert.ok(workflow.includes(requiredText), `workflow should contain ${requiredText}`);
  }

  assert.doesNotMatch(workflow, /AutoVPN-\$\{PKG_VERSION\}-\$\{\{ matrix\.package_arch \}\}\.dmg\.blockmap/);
  assert.doesNotMatch(workflow, /AutoVPN-\$\{PKG_VERSION\}-x86_64\.AppImage/);
  assert.doesNotMatch(workflow, /AutoVPN-\$\{PKG_VERSION\}-arm64\.AppImage/);
  assert.doesNotMatch(workflow, /dist-electron\/\*\*\/\*\.zip/);
  assert.doesNotMatch(workflow, /dist-electron\/\*\*\/\*\.yml/);
  assert.doesNotMatch(workflow, /dist-electron\/\*\*\/\*\.blockmap/);
  assert.doesNotMatch(workflow, /dist-electron\/\*\*\/\*\.exe/);
  assert.doesNotMatch(workflow, /dist-electron\/mac-\*/);
  assert.match(testJob, /npm test --prefix npm\/autovpn-cli/);
  assert.match(packageInstallStep, /npm ci --prefix npm\/autovpn-cli/);
  assert.match(packageInstallStep, /shell: bash/);
  assert.doesNotMatch(packageInstallAndBuild, /Install Playwright browser runtime/);
  assert.doesNotMatch(packageInstallAndBuild, /PLAYWRIGHT_BROWSERS_PATH: electron\/runtime\/playwright-browsers/);
  assert.doesNotMatch(packageInstallAndBuild, /npx playwright install chromium-headless-shell/);
  const verifyIndex = packageCliJob.indexOf('      - name: Verify and smoke CLI artifact');
  const publishIndex = packageCliJob.indexOf('      - name: Publish npm CLI package');
  const uploadIndex = packageCliJob.indexOf('      - name: Upload CLI release assets');
  assert.ok(verifyIndex >= 0, 'package CLI job should verify its tarball');
  assert.ok(verifyIndex < publishIndex, 'tarball verification should happen before npm publish');
  assert.ok(publishIndex < uploadIndex, 'npm publish should happen before GitHub asset upload');
  assert.match(
    packageCliJob,
    /npm exec --yes --package="\.\/dist\/swimmingliu-autovpn-\$\{PKG_VERSION\}\.tgz" -- autovpn --version/
  );
  assert.doesNotMatch(packageCliJob, /npx -y "\.\/dist\/.*\.tgz"/);
  assert.doesNotMatch(packageCliJob, /cd npm\/autovpn-cli && npm publish/);
});

test('active CI and release workflows are Node-only and publish only npm and Electron assets', () => {
  const headless = readProjectFile('.github', 'workflows', 'headless-cli.yml');
  const release = readProjectFile('.github', 'workflows', 'release-electron.yml');
  const workflows = `${headless}\n${release}`;

  for (const pattern of [
    /setup-python/i,
    /\bpython(?:3(?:\.\d+)?)?\b/i,
    /\bpip(?:x)?\b/i,
    /\bpytest\b/i,
    /\btwine\b/i,
    /\bPyPI\b/i,
    /\bwheel\b/i,
    /\bsdist\b/i,
    /pyproject\.toml/i,
    /python-vendor/i,
    /\.whl\b/i
  ]) {
    assert.doesNotMatch(workflows, pattern);
  }

  assert.match(headless, /node -e .*JSON\.parse/);
  assert.match(headless, /npm run test:h5/);
  assert.match(headless, /npm run test:electron-native/);
  assert.match(release, /npm pack --json --pack-destination \.\.\/\.\.\/dist/);
  assert.match(release, /dist\/swimmingliu-autovpn-\$\{PKG_VERSION\}\.tgz/);
  assert.doesNotMatch(release, /find dist .*\.tar\.gz/);
});

test('headless CI packages the Linux Electron app and verifies version and icon output', () => {
  const workflow = readProjectFile('.github', 'workflows', 'headless-cli.yml');
  const packageJob = workflow.slice(workflow.indexOf('  electron-package:'));

  for (const requiredText of [
    'electron-package:',
    'name: Linux Electron package',
    'needs: headless',
    'NPM_CONFIG_FETCH_RETRIES: "5"',
    'NPM_CONFIG_FETCH_TIMEOUT: "600000"',
    'NPM_CONFIG_PREFER_OFFLINE: "true"',
    'cache-dependency-path:',
    'npm/autovpn-cli/package-lock.json',
    'scripts/ci/retry-command.sh "npm ci"',
    'scripts/ci/retry-command.sh "npm ci --prefix npm/autovpn-cli"',
    '--prefer-offline --no-audit --fund=false',
    'sudo apt-get install -y rpm fakeroot',
    'AUTOVPN_PACKAGE_PLATFORM: linux',
    'AUTOVPN_PACKAGE_ARCH: x64',
    'npm run package:electron 2>&1 | tee packaging.log',
    'default Electron icon is used',
    'dist-electron/AutoVPN-${PKG_VERSION}-amd64.deb',
    'dist-electron/AutoVPN-${PKG_VERSION}-x86_64.rpm',
    'sidebarVersion: \'v.${PKG_VERSION}\'',
    'dpkg-deb -c "dist-electron/AutoVPN-${PKG_VERSION}-amd64.deb" > deb-contents.txt',
    'vpn-subscription-automation.png',
    'actions/upload-artifact@v4',
    'autovpn-electron-linux-x64'
  ]) {
    assert.ok(workflow.includes(requiredText), `headless workflow should contain ${requiredText}`);
  }
  assert.match(packageJob, /npm ci --prefix npm\/autovpn-cli/);
});

test('release workflow runs its shared test gate on Ubuntu', () => {
  const workflow = readProjectFile('.github', 'workflows', 'release-electron.yml');
  const testJob = extractWorkflowSegment(workflow, '  test:', '  package-electron:');

  assert.match(testJob, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(testJob, /runs-on: macos-latest/);
  assert.match(workflow, /os: macos-latest/);
});

test('release package version matches the next release tag', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const packageLock = JSON.parse(readProjectFile('package-lock.json'));

  assert.equal(packageJson.version, '1.8.0');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
});

test('PR and release gates run the complete mobile Chromium/WebKit and visual matrix', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const h5Files = testFilesFromScript(packageJson.scripts['test:h5']);
  const nativeFiles = testFilesFromScript(packageJson.scripts['test:electron-native']);
  const allFiles = fs.readdirSync(path.join(projectRoot, 'electron', 'tests'))
    .filter((file) => file.endsWith('.test.mjs'))
    .sort();

  assert.deepEqual(h5Files, [
    'mobile-layout-contract.test.mjs',
    'web-server-e2e.test.mjs',
    'web-server-visual.test.mjs'
  ]);
  assert.ok(nativeFiles.includes('app-launch.test.mjs'), 'native gate must include app launch');
  assert.ok(nativeFiles.includes('renderer-e2e.test.mjs'), 'native gate must include desktop E2E');
  assert.ok(nativeFiles.includes('renderer-visual.test.mjs'), 'native gate must include desktop visual');
  assert.deepEqual([...new Set([...h5Files, ...nativeFiles])].sort(), allFiles, 'H5/native scripts must cover every Electron test exactly once');
  assert.equal(new Set([...h5Files, ...nativeFiles]).size, h5Files.length + nativeFiles.length, 'H5/native scripts must not overlap');
  assert.equal(packageJson.scripts['test:electron'], 'npm run test:h5 && npm run test:electron-native');

  for (const workflowPath of ['headless-cli.yml', 'release-electron.yml']) {
    const workflow = readProjectFile('.github', 'workflows', workflowPath);
    assertWorkflowTestGates(workflow, packageJson, allFiles);
    const h5Step = extractNamedStep(workflow, 'Run H5 mobile Chromium and WebKit gate');
    const nativeStep = extractNamedStep(workflow, 'Run Electron native and desktop gate');
    assert.match(workflow, /name: Install pinned Playwright Chromium and WebKit runtimes/);
    assert.match(workflow, /npx playwright install --with-deps chromium-headless-shell webkit/);
    assert.ok(workflow.indexOf('Run H5 mobile Chromium and WebKit gate') < workflow.indexOf('Run Electron native and desktop gate'));
    assert.match(h5Step, /run: npm run test:h5/);
    assert.match(nativeStep, /run: npm run test:electron-native/);
    assert.match(workflow, /name: Upload renderer visual diffs/);
    assert.match(workflow, /if: failure\(\)/);
    assert.match(workflow, /uses: actions\/upload-artifact@v4/);
    assert.match(workflow, /electron\/tests\/visual-artifacts\/\*\*/);
    assert.doesNotMatch(`${h5Step}\n${nativeStep}`, /excluded|exclude|--test-name-pattern/i);
  }
});

test('gate contract rejects package-script and workflow shell bypasses', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const workflow = readProjectFile('.github', 'workflows', 'headless-cli.yml');
  const allFiles = fs.readdirSync(path.join(projectRoot, 'electron', 'tests'))
    .filter((file) => file.endsWith('.test.mjs'))
    .sort();
  assertWorkflowTestGates(workflow, packageJson, allFiles);

  for (const bypass of [
    '--test-name-pattern mobile',
    '--exclude renderer-visual',
    '| grep -v visual',
    '|| true',
    '; true',
    '| cat',
    '|| :',
    '; exit 0',
    '> /tmp/autovpn-test.log',
    '--unknown-flag',
    'electron/tests/mobile-layout-contract.test.mjs'
  ]) {
    const mutated = structuredClone(packageJson);
    mutated.scripts['test:h5'] += ` ${bypass}`;
    assert.throws(() => assertWorkflowTestGates(workflow, mutated, allFiles), undefined, `should reject ${bypass}`);
  }

  const missingFile = structuredClone(packageJson);
  missingFile.scripts['test:h5'] = missingFile.scripts['test:h5']
    .replace(' electron/tests/web-server-visual.test.mjs', '');
  assert.throws(
    () => assertWorkflowTestGates(workflow, missingFile, allFiles),
    undefined,
    'should reject an H5 gate with a missing test file'
  );

  for (const replacement of [
    'run: UPDATE_VISUAL_BASELINES=1 npm run test:h5',
    'run: npm run test:h5 || true',
    'run: npm run test:h5 -- --test-name-pattern mobile',
    'if: github.event_name == \'push\'\n        run: npm run test:h5',
    'continue-on-error: true\n        run: npm run test:h5'
  ]) {
    const mutated = workflow.replace('run: npm run test:h5', replacement);
    assert.throws(() => assertWorkflowTestGates(mutated, packageJson, allFiles), undefined, `should reject ${replacement}`);
  }

  for (const [scope, mutated] of [
    ['workflow env', workflow.replace('env:\n', 'env:\n  UPDATE_VISUAL_BASELINES: "1"\n')],
    ['job env', workflow.replace('    name: Linux headless CLI\n', '    name: Linux headless CLI\n    env:\n      UPDATE_VISUAL_BASELINES: "1"\n')],
    ['step env', workflow.replace('      - name: Run H5 mobile Chromium and WebKit gate\n', '      - name: Run H5 mobile Chromium and WebKit gate\n        env:\n          UPDATE_VISUAL_BASELINES: "1"\n')]
  ]) {
    assert.throws(() => assertWorkflowTestGates(mutated, packageJson, allFiles), undefined, `should reject ${scope}`);
  }

  for (const [syntax, mutated] of [
    ['inline env map', workflow.replace('      - name: Run H5 mobile Chromium and WebKit gate\n', '      - name: Run H5 mobile Chromium and WebKit gate\n        env: { UPDATE_VISUAL_BASELINES: "1" }\n')],
    ['quoted env key', workflow.replace('      - name: Run H5 mobile Chromium and WebKit gate\n', '      - name: Run H5 mobile Chromium and WebKit gate\n        env:\n          "UPDATE_VISUAL_BASELINES": "1"\n')]
  ]) {
    assert.throws(() => assertWorkflowTestGates(mutated, packageJson, allFiles), undefined, `should reject ${syntax}`);
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
