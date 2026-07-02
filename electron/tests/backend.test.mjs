import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mergeLatestArtifactPreview, parseVmessLinkForPreview, previewArtifactDirectory } from '../lib/artifact-preview.js';
import {
  buildBackendEnv,
  buildBackendInvocation,
  buildPythonCandidates,
  parseBackendEventLine,
  resolveBackendPython,
  resolveBundledChromiumPath,
  resolvePlaywrightBrowsersPath,
  resolvePythonVendorPath
} from '../lib/backend.js';
import { migrateLegacyPackagedProfile } from '../lib/profile-migration.js';
import {
  findProjectRoot,
  resolveRuntimeArtifactsPath,
  resolveBundledProfilePath,
  resolveLegacyPackagedProfilePath,
  resolveProjectRoot,
  resolveStateProfilePath
} from '../paths.js';

test('qrcode package is available for real subscription QR images', async () => {
  const QRCode = await import('qrcode');
  const dataUrl = await QRCode.default.toDataURL('https://example.invalid/subscription');

  assert.match(dataUrl, /^data:image\/png;base64,/);
});

test('buildBackendInvocation returns python module command', () => {
  const invocation = buildBackendInvocation('/repo', 'run');
  assert.deepEqual(invocation.commands, resolveBackendPython('/repo'));
  assert.deepEqual(invocation.args, ['-m', 'vpn_automation.backend', 'run', '--project-root', '/repo']);
});

test('buildBackendInvocation appends extra args for retry-stage style commands', () => {
  const invocation = buildBackendInvocation('/repo', 'retry-stage', [
    '--artifact-dir',
    '/repo/artifacts/20260427-081718',
    '--stage',
    'deploy'
  ]);

  assert.deepEqual(invocation.commands, resolveBackendPython('/repo'));
  assert.deepEqual(invocation.args, [
    '-m',
    'vpn_automation.backend',
    'retry-stage',
    '--project-root',
    '/repo',
    '--artifact-dir',
    '/repo/artifacts/20260427-081718',
    '--stage',
    'deploy'
  ]);
});

test('buildPythonCandidates prefers project venv and Python 3.12 before Python 3.14 fallbacks', () => {
  const candidates = buildPythonCandidates('/repo');

  assert.equal(candidates[0], '/repo/.venv/bin/python');
  assert.equal(candidates[1], '/repo/.venv/bin/python3');
  assert.ok(candidates.indexOf('/opt/homebrew/bin/python3.12') < candidates.indexOf('/opt/homebrew/bin/python3.14'));
  assert.ok(candidates.indexOf('/usr/local/bin/python3.12') < candidates.indexOf('/usr/local/bin/python3.14'));
  assert.ok(candidates.indexOf('/opt/homebrew/bin/python3.12') < candidates.indexOf('python3'));
});

test('buildBackendEnv exposes bundled python vendor packages to packaged app backend', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-python-vendor-'));
  const projectRoot = path.join(root, 'app');
  const vendorPath = path.join(projectRoot, 'electron', 'runtime', 'python-vendor');
  fs.mkdirSync(vendorPath, { recursive: true });

  const env = buildBackendEnv(projectRoot, '/profile.toml', '/bundled.toml');

  assert.equal(resolvePythonVendorPath(projectRoot), vendorPath);
  assert.equal(env.PYTHONPATH, [path.join(projectRoot, 'src'), vendorPath].join(path.delimiter));
  assert.equal(env.VPN_AUTOMATION_PROFILE_PATH, '/profile.toml');
  assert.equal(env.VPN_AUTOMATION_BUNDLED_PROFILE_PATH, '/bundled.toml');
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
    'AutoVPN.app',
    'Contents',
    'MacOS',
    'AutoVPN'
  );
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, '', 'utf-8');

  assert.equal(findProjectRoot(execPath), projectRoot);
});

test('resolveProjectRoot returns explicit root unchanged', () => {
  assert.equal(resolveProjectRoot('/repo'), '/repo');
});

test('resolveStateProfilePath defaults to the user runtime profile outside the project tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-state-root-'));
  const repoRoot = path.join(root, 'vpn-subscription-automation');
  const worktreeRoot = path.join(repoRoot, '.worktrees', 'cleanup');
  const runtimeRoot = path.join(root, 'home', '.auto-vpn');

  fs.mkdirSync(worktreeRoot, { recursive: true });

  assert.equal(
    resolveStateProfilePath(worktreeRoot, { runtimeRootPath: runtimeRoot }),
    path.join(runtimeRoot, 'profile.toml')
  );
});

test('resolveStateProfilePath honors the runtime root env override', () => {
  const previous = process.env.VPN_AUTOMATION_RUNTIME_ROOT;
  process.env.VPN_AUTOMATION_RUNTIME_ROOT = '/Users/demo/.custom-auto-vpn';
  try {
    assert.equal(resolveStateProfilePath('/repo'), '/Users/demo/.custom-auto-vpn/profile.toml');
  } finally {
    if (previous === undefined) {
      delete process.env.VPN_AUTOMATION_RUNTIME_ROOT;
    } else {
      process.env.VPN_AUTOMATION_RUNTIME_ROOT = previous;
    }
  }
});

test('resolveStateProfilePath expands home-relative runtime root env override', () => {
  const previous = process.env.VPN_AUTOMATION_RUNTIME_ROOT;
  process.env.VPN_AUTOMATION_RUNTIME_ROOT = '~/.custom-auto-vpn';
  try {
    assert.equal(resolveStateProfilePath('/repo'), path.join(os.homedir(), '.custom-auto-vpn', 'profile.toml'));
  } finally {
    if (previous === undefined) {
      delete process.env.VPN_AUTOMATION_RUNTIME_ROOT;
    } else {
      process.env.VPN_AUTOMATION_RUNTIME_ROOT = previous;
    }
  }
});

test('resolveStateProfilePath uses the same user runtime root when packaged', () => {
  assert.equal(
    resolveStateProfilePath('/repo', {
      isPackaged: true,
      userDataPath: '/Users/demo/Library/Application Support/VPN',
      runtimeRootPath: '/Users/demo/.auto-vpn'
    }),
    '/Users/demo/.auto-vpn/profile.toml'
  );
});

test('resolveLegacyPackagedProfilePath points at the pre-unified Electron userData profile', () => {
  assert.equal(
    resolveLegacyPackagedProfilePath({
      isPackaged: true,
      userDataPath: '/Users/demo/Library/Application Support/vpn-subscription-automation'
    }),
    '/Users/demo/Library/Application Support/vpn-subscription-automation/state/profile.toml'
  );
  assert.equal(resolveLegacyPackagedProfilePath({ isPackaged: false, userDataPath: '/Users/demo/App' }), '');
});

test('migrateLegacyPackagedProfile copies old userData profile only when unified profile is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-profile-migration-'));
  const runtimeProfilePath = path.join(root, 'home', '.auto-vpn', 'profile.toml');
  const legacyProfilePath = path.join(root, 'Application Support', 'vpn-subscription-automation', 'state', 'profile.toml');
  fs.mkdirSync(path.dirname(legacyProfilePath), { recursive: true });
  fs.writeFileSync(legacyProfilePath, 'old-profile', 'utf-8');

  assert.deepEqual(migrateLegacyPackagedProfile(runtimeProfilePath, legacyProfilePath), {
    migrated: true,
    reason: 'copied_legacy_profile'
  });
  assert.equal(fs.readFileSync(runtimeProfilePath, 'utf-8'), 'old-profile');

  fs.writeFileSync(runtimeProfilePath, 'current-profile', 'utf-8');
  fs.writeFileSync(legacyProfilePath, 'stale-profile', 'utf-8');
  assert.deepEqual(migrateLegacyPackagedProfile(runtimeProfilePath, legacyProfilePath), {
    migrated: false,
    reason: 'runtime_profile_exists'
  });
  assert.equal(fs.readFileSync(runtimeProfilePath, 'utf-8'), 'current-profile');
});

test('resolveRuntimeArtifactsPath defaults to the user runtime artifacts directory', () => {
  assert.equal(
    resolveRuntimeArtifactsPath('/repo', { runtimeRootPath: '/Users/demo/.auto-vpn' }),
    '/Users/demo/.auto-vpn/artifacts'
  );
});

test('buildBackendEnv exposes packaged runtime artifacts path to Python backend', () => {
  const env = buildBackendEnv('/repo', '/profile.toml', '/bundled.toml', '/runtime/artifacts');

  assert.equal(env.VPN_AUTOMATION_ARTIFACTS_ROOT, '/runtime/artifacts');
});

test('buildBackendEnv points Playwright at bundled Chromium headless shell when packaged browser exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-playwright-browser-'));
  const projectRoot = path.join(root, 'app');
  const chromiumPath = path.join(
    projectRoot,
    'electron',
    'runtime',
    'playwright-browsers',
    'chromium_headless_shell-1217',
    'chrome-headless-shell-mac-arm64',
    'chrome-headless-shell'
  );
  fs.mkdirSync(path.dirname(chromiumPath), { recursive: true });
  fs.writeFileSync(chromiumPath, '', 'utf-8');

  const env = buildBackendEnv(projectRoot, '/profile.toml', '/bundled.toml', '/runtime/artifacts');

  assert.equal(resolvePlaywrightBrowsersPath(projectRoot), path.join(projectRoot, 'electron', 'runtime', 'playwright-browsers'));
  assert.equal(resolveBundledChromiumPath(projectRoot), chromiumPath);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, resolvePlaywrightBrowsersPath(projectRoot));
  assert.equal(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromiumPath);
});

test('resolveBundledProfilePath points at the packaged runtime seed file', () => {
  assert.equal(resolveBundledProfilePath('/repo'), '/repo/electron/runtime/bundled-profile.toml');
});

test('resolveBackendPython prefers a project virtualenv when present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-python-root-'));
  const venvPython = path.join(root, '.venv', 'bin', 'python');

  fs.mkdirSync(path.dirname(venvPython), { recursive: true });
  fs.writeFileSync(venvPython, '', 'utf-8');

  const candidates = resolveBackendPython(root);
  assert.equal(candidates[0], venvPython);
  assert.ok(candidates.includes('python3.12'));
  assert.ok(candidates.includes('python3'));
});

test('parseVmessLinkForPreview decodes node fields for results page', () => {
  const payload = {
    v: '2',
    ps: '🇺🇸 US demo-node',
    add: '1.2.3.4',
    port: '443',
    id: '00000000-0000-0000-0000-000000000000',
    aid: '0',
    net: 'ws',
    type: 'none',
    host: 'example.invalid',
    path: '/edge',
    tls: 'tls'
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const link = `vmess://${encoded}`;

  assert.deepEqual(parseVmessLinkForPreview(link), {
    name: '🇺🇸 US demo-node',
    address: '1.2.3.4',
    protocol: 'vmess',
    path: '/edge',
    link,
    regionCode: 'US'
  });
});

test('previewArtifactDirectory prefers final emoji nodes and decodes vmess rows', () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-artifact-preview-'));
  const speedPayload = Buffer.from(JSON.stringify({
    ps: '🇸🇬 SG speed-node',
    add: '5.5.5.5',
    path: '/speed'
  }), 'utf8').toString('base64url');
  const finalPayload = Buffer.from(JSON.stringify({
    ps: '🇯🇵 JP final-node',
    add: '6.6.6.6',
    path: '/final'
  }), 'utf8').toString('base64url');

  fs.writeFileSync(path.join(artifactDir, 'vpn_node_speedtest.txt'), `vmess://${speedPayload}`, 'utf-8');
  fs.writeFileSync(path.join(artifactDir, 'vpn_node_emoji.txt'), `vmess://${finalPayload}`, 'utf-8');

  const preview = previewArtifactDirectory(artifactDir);

  assert.equal(preview.ok, true);
  assert.equal(preview.nodeSource, 'vpn_node_emoji.txt');
  assert.deepEqual(preview.nodeRows, [
    {
      name: '🇯🇵 JP final-node',
      address: '6.6.6.6',
      protocol: 'vmess',
      path: '/final',
      link: `vmess://${finalPayload}`,
      regionCode: 'JP'
    }
  ]);
  assert.equal(preview.finalNodeCount, 1);
  assert.deepEqual(preview.regionCards, [
    { regionCode: 'JP', count: 1 }
  ]);
});

test('previewArtifactDirectory groups nodes by region and falls back to OTHER', () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-artifact-preview-regions-'));
  const firstUsPayload = Buffer.from(JSON.stringify({
    ps: '🇺🇸 US first-node',
    add: '1.1.1.1',
    path: '/us-1'
  }), 'utf8').toString('base64url');
  const secondUsPayload = Buffer.from(JSON.stringify({
    ps: 'US second-node',
    add: '1.1.1.2',
    path: '/us-2'
  }), 'utf8').toString('base64url');
  const otherPayload = Buffer.from(JSON.stringify({
    ps: 'demo node without region',
    add: '9.9.9.9',
    path: '/other'
  }), 'utf8').toString('base64url');

  fs.writeFileSync(
    path.join(artifactDir, 'vpn_node_emoji.txt'),
    [`vmess://${firstUsPayload}`, `vmess://${secondUsPayload}`, `vmess://${otherPayload}`].join('\n'),
    'utf-8'
  );

  const preview = previewArtifactDirectory(artifactDir);

  assert.equal(preview.finalNodeCount, 3);
  assert.deepEqual(
    preview.nodeRows.map((row) => row.regionCode),
    ['US', 'US', 'OTHER']
  );
  assert.deepEqual(preview.regionCards, [
    { regionCode: 'OTHER', count: 1 },
    { regionCode: 'US', count: 2 }
  ]);
});

test('mergeLatestArtifactPreview combines backend report metadata and preview rows', () => {
  const report = {
    ok: true,
    artifact_dir: '/tmp/artifacts/20260426-120000',
    counts: { availability_links: 2 },
    source_counts: { leiting: { raw_links: 3 } },
    retry_context: {
      source_artifact_dir: '/tmp/artifacts/20260425-000000',
      source_artifact_name: '20260425-000000',
      start_stage: 'deploy'
    }
  };
  const preview = {
    ok: true,
    outputFiles: [{ name: 'vpn_node_emoji.txt', size: '2 KB' }],
    nodeRows: [{ name: 'JP node' }]
  };

  assert.deepEqual(mergeLatestArtifactPreview(report, preview), {
    ok: true,
    artifact_dir: '/tmp/artifacts/20260426-120000',
    counts: { availability_links: 2 },
    source_counts: { leiting: { raw_links: 3 } },
    retry_context: {
      source_artifact_dir: '/tmp/artifacts/20260425-000000',
      source_artifact_name: '20260425-000000',
      start_stage: 'deploy'
    },
    outputFiles: [{ name: 'vpn_node_emoji.txt', size: '2 KB' }],
    nodeRows: [{ name: 'JP node' }],
    regionCards: [],
    finalNodeCount: 0,
    nodeSource: ''
  });
});
