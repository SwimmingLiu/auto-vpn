import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReleaseNotes } from '../../scripts/generate-release-notes.mjs';

test('release notes follow the clash-verge style download layout without blockmaps', () => {
  const notes = buildReleaseNotes({
    tagName: 'v1.1.1',
    repoSlug: 'SwimmingLiu/auto-vpn',
    createdAt: 'Mon Jun 09 16:00:00 CST 2026'
  });

  for (const requiredText of [
    '## v1.1.1',
    '### 📦 发布内容',
    '## 下载地址',
    '### Windows',
    '#### 安装版(推荐)',
    '#### 便携版',
    '### macOS',
    '### Linux',
    '#### DEB包(Debian系) 使用 apt ./路径 安装',
    '#### RPM包(Redhat系) 使用 dnf ./路径 安装',
    '### FAQ',
    '### 问题反馈',
    'AutoVPN-1.1.1-x64-setup.exe',
    'AutoVPN-1.1.1-arm64-setup.exe',
    'AutoVPN-1.1.1-x64-portable.exe',
    'AutoVPN-1.1.1-arm64-portable.exe',
    'AutoVPN-1.1.1-arm64.dmg',
    'AutoVPN-1.1.1-x64.dmg',
    'AutoVPN-1.1.1-amd64.deb',
    'AutoVPN-1.1.1-arm64.deb',
    'AutoVPN-1.1.1-x86_64.rpm',
    'AutoVPN-1.1.1-aarch64.rpm',
    'swimmingliu-autovpn-1.1.1.tgz',
    'Created at Mon Jun 09 16:00:00 CST 2026.'
  ]) {
    assert.ok(notes.includes(requiredText), `release notes should contain ${requiredText}`);
  }

  assert.doesNotMatch(notes, /blockmap/i);
  assert.doesNotMatch(notes, /AppImage/);
  assert.doesNotMatch(notes, /\.whl\b|\.tar\.gz\b/i);
});
