import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseVmessLinkForPreview, previewArtifactDirectory } from '../lib/artifact-preview.js';
import { buildBackendInvocation, parseBackendEventLine, resolveBackendPython } from '../lib/backend.js';
import { findProjectRoot, resolveProjectRoot } from '../paths.js';

test('qrcode package is available for real subscription QR images', async () => {
  const QRCode = await import('qrcode');
  const dataUrl = await QRCode.default.toDataURL('https://example.invalid/subscription');

  assert.match(dataUrl, /^data:image\/png;base64,/);
});

test('buildBackendInvocation returns python module command', () => {
  const invocation = buildBackendInvocation('/repo', 'run');
  assert.deepEqual(invocation.commands, ['python3.12', 'python3']);
  assert.deepEqual(invocation.args, ['-m', 'vpn_automation.backend', 'run', '--project-root', '/repo']);
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
    'VPN Subscription Automation.app',
    'Contents',
    'MacOS',
    'VPN Subscription Automation'
  );
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, '', 'utf-8');

  assert.equal(findProjectRoot(execPath), projectRoot);
});

test('resolveProjectRoot returns explicit root unchanged', () => {
  assert.equal(resolveProjectRoot('/repo'), '/repo');
});

test('resolveBackendPython prefers a project virtualenv when present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-python-root-'));
  const venvPython = path.join(root, '.venv', 'bin', 'python');

  fs.mkdirSync(path.dirname(venvPython), { recursive: true });
  fs.writeFileSync(venvPython, '', 'utf-8');

  assert.deepEqual(resolveBackendPython(root), [venvPython, 'python3.12', 'python3']);
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
