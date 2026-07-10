import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as backend from '../lib/backend.js';
import { mergeLatestArtifactPreview, parseVmessLinkForPreview, previewArtifactDirectory } from '../lib/artifact-preview.js';
import {
  buildBackendEnv,
  buildBackendInvocation,
  parseBackendEventLine,
  resolveBundledChromiumPath,
  resolvePlaywrightBrowsersPath,
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

test('buildBackendInvocation runs the npm Node CLI with jsonl output in development', () => {
  const invocation = buildBackendInvocation('/repo', 'run', [], {
    nodeExecutable: '/usr/local/bin/node'
  });

  assert.equal(backend.resolveNodeCliEntry?.('/repo'), '/repo/npm/autovpn-cli/bin/autovpn.mjs');
  assert.equal(invocation.command, '/usr/local/bin/node');
  assert.deepEqual(invocation.args, [
    '/repo/npm/autovpn-cli/bin/autovpn.mjs',
    'run',
    '--project-root',
    '/repo',
    '--output',
    'jsonl'
  ]);
});

test('buildBackendInvocation uses the packaged Electron executable as Node', () => {
  const invocation = buildBackendInvocation('/Applications/AutoVPN.app/Contents/Resources/app.asar', 'run', [], {
    isPackaged: true,
    electronExecutable: '/Applications/AutoVPN.app/Contents/MacOS/AutoVPN'
  });

  assert.equal(invocation.command, '/Applications/AutoVPN.app/Contents/MacOS/AutoVPN');
  assert.equal(invocation.runAsNode, true);
});

test('buildBackendInvocation maps legacy internal commands to public CLI commands', () => {
  const cases = [
    ['profile', ['profile', 'show']],
    ['profile-save', ['profile', 'save']],
    ['artifact-latest', ['artifacts', 'latest']],
    ['artifact-list', ['artifacts', 'list']]
  ];

  for (const [command, expected] of cases) {
    const invocation = buildBackendInvocation('/repo', command, [], { nodeExecutable: 'node' });
    assert.deepEqual(invocation.args.slice(1, 1 + expected.length), expected);
    assert.equal(invocation.args.includes('--output'), false);
  }
});

test('buildBackendInvocation appends extra args and jsonl output for retry-stage', () => {
  const invocation = buildBackendInvocation('/repo', 'retry-stage', [
    '--artifact-dir',
    '/repo/artifacts/20260427-081718',
    '--stage',
    'deploy'
  ], { nodeExecutable: 'node' });

  assert.deepEqual(invocation.args, [
    '/repo/npm/autovpn-cli/bin/autovpn.mjs',
    'retry-stage',
    '--project-root',
    '/repo',
    '--artifact-dir',
    '/repo/artifacts/20260427-081718',
    '--stage',
    'deploy',
    '--output',
    'jsonl'
  ]);
});

test('buildBackendEnv sets Electron run-as-node only for packaged invocations', () => {
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = 'inherited';
  const developmentEnv = buildBackendEnv('/repo', '/profile.toml', '/bundled.toml');
  const packagedEnv = buildBackendEnv('/repo', '/profile.toml', '/bundled.toml', '', { runAsNode: true });

  assert.equal(developmentEnv.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(packagedEnv.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(developmentEnv.VPN_AUTOMATION_PROFILE_PATH, '/profile.toml');
  assert.equal(developmentEnv.VPN_AUTOMATION_BUNDLED_PROFILE_PATH, '/bundled.toml');

  if (previous === undefined) {
    delete process.env.ELECTRON_RUN_AS_NODE;
  } else {
    process.env.ELECTRON_RUN_AS_NODE = previous;
  }
});

test('parseBackendEventLine decodes backend json line', () => {
  const event = parseBackendEventLine('{"type":"log","message":"hello"}');
  assert.equal(event.type, 'log');
  assert.equal(event.message, 'hello');
});

test('createNdjsonDecoder buffers fragments and parses multiple events per chunk', () => {
  assert.equal(typeof backend.createNdjsonDecoder, 'function');
  const events = [];
  const decoder = backend.createNdjsonDecoder((event) => events.push(event));

  decoder.push('{"type":"stage"');
  decoder.push(',"stage":"extract","status":"running"}\n');
  decoder.push('{"type":"log","message":"first"}\n{"type":"log","message":"second"}\n');
  decoder.flush();

  assert.deepEqual(events, [
    { type: 'stage', stage: 'extract', status: 'running' },
    { type: 'log', message: 'first' },
    { type: 'log', message: 'second' }
  ]);
});

test('createNdjsonDecoder flushes a final unterminated event on close', () => {
  assert.equal(typeof backend.createNdjsonDecoder, 'function');
  const events = [];
  const decoder = backend.createNdjsonDecoder((event) => events.push(event));

  decoder.push('{"type":"log","message":"tail"}');
  assert.deepEqual(events, []);
  decoder.flush();

  assert.deepEqual(events, [{ type: 'log', message: 'tail' }]);
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
