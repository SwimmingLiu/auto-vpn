import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function readPackageVersion(projectRoot) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
  );
  return packageJson.version;
}

export function buildReleaseNotes({
  tagName,
  version,
  repoSlug,
  createdAt
}) {
  const resolvedVersion = version ?? tagName.replace(/^v/, '');
  const downloadBaseUrl = `https://github.com/${repoSlug}/releases/download/${tagName}`;

  return `## ${tagName}

### 📦 发布内容

- AutoVPN 桌面端多平台安装包发布
- 覆盖 macOS、Linux、Windows 的 x64 / ARM64 原生安装包

## 下载地址

### Windows
#### 安装版(推荐)
- [64位(常用)](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-x64-setup.exe) | [ARM64(不常用)](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-arm64-setup.exe)

#### 便携版
- [64位](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-x64-portable.exe) | [ARM64](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-arm64-portable.exe)

### macOS
- [Apple M芯片](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-arm64.dmg) | [Intel芯片](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-x64.dmg)

### Linux
#### DEB包(Debian系) 使用 apt ./路径 安装
- [64位](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-amd64.deb) | [ARM64](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-arm64.deb)

#### RPM包(Redhat系) 使用 dnf ./路径 安装
- [64位](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-x86_64.rpm) | [ARM64](${downloadBaseUrl}/AutoVPN-${resolvedVersion}-aarch64.rpm)

### CLI
- [npm CLI tarball](${downloadBaseUrl}/swimmingliu-autovpn-${resolvedVersion}.tgz)

### FAQ
- [项目说明](https://github.com/${repoSlug}#readme)

### 问题反馈
- [提交 Issue](https://github.com/${repoSlug}/issues)

Created at ${createdAt}.
`;
}

if (process.argv[1] === __filename) {
  const projectRoot = path.resolve(__dirname, '..');
  const version = readPackageVersion(projectRoot);
  const tagName = process.argv[2] ?? process.env.RELEASE_TAG_NAME ?? `v${version}`;
  const repoSlug = process.argv[3] ?? process.env.GITHUB_REPOSITORY ?? 'SwimmingLiu/auto-vpn';
  const createdAt = process.env.RELEASE_NOTES_CREATED_AT ?? new Date().toString();

  process.stdout.write(
    buildReleaseNotes({
      tagName,
      version,
      repoSlug,
      createdAt
    })
  );
}
