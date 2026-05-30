import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveRepoAnchor(projectRoot) {
  const normalized = path.resolve(projectRoot);
  const marker = `${path.sep}.worktrees${path.sep}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) {
    return normalized;
  }
  return normalized.slice(0, markerIndex);
}

export function resolveLiveProfilePath(projectRoot) {
  return path.join(resolveRepoAnchor(projectRoot), 'state', 'profile.toml');
}

export function resolveRuntimePaths(projectRoot) {
  const runtimeDir = path.join(projectRoot, 'electron', 'runtime');
  return {
    runtimeDir,
    defaultSeedPath: path.join(runtimeDir, 'default-profile.toml'),
    bundledSeedPath: path.join(runtimeDir, 'bundled-profile.toml'),
    liveProfilePath: resolveLiveProfilePath(projectRoot)
  };
}

export function resolveShareWorkerPaths(projectRoot) {
  const repoAnchor = resolveRepoAnchor(projectRoot);
  const workspaceRoot = path.dirname(repoAnchor);
  const sourceCandidates = [
    path.join(projectRoot, 'templates', 'share-worker', 'vpn.js'),
    path.join(workspaceRoot, 'cloudflarevpn', 'edgetunnel', 'vpn.js')
  ];
  const runtimeDir = path.join(projectRoot, 'electron', 'runtime', 'share-worker');
  return {
    sourcePath: sourceCandidates[0],
    sourceCandidates,
    runtimeDir,
    runtimePath: path.join(runtimeDir, 'vpn.js')
  };
}

export function resolveIconPaths(projectRoot) {
  const outputDir = path.join(projectRoot, 'electron', 'build', 'assets');
  return {
    sourceSvg: path.join(projectRoot, 'electron', 'renderer', 'assets', 'vpn-auto-logo-v2-minimal.svg'),
    outputDir,
    outputIcns: path.join(outputDir, 'app-icon.icns'),
    iconsetDir: path.join(outputDir, 'app-icon.iconset')
  };
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function ensureCleanDir(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
}

function renderSvgToPng(sourceSvg, outputPng) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-auto-icon-'));
  try {
    runOrThrow('qlmanage', ['-t', '-s', '1024', '-o', tempDir, sourceSvg]);
    const renderedPng = path.join(tempDir, `${path.basename(sourceSvg)}.png`);
    fs.copyFileSync(renderedPng, outputPng);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildIconset(basePng, iconsetDir) {
  const iconSpecs = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];

  for (const [filename, size] of iconSpecs) {
    runOrThrow('sips', ['-z', String(size), String(size), basePng, '--out', path.join(iconsetDir, filename)]);
  }
}

export function prepareMacIcon(projectRoot) {
  const { sourceSvg, outputDir, outputIcns, iconsetDir } = resolveIconPaths(projectRoot);
  fs.mkdirSync(outputDir, { recursive: true });
  ensureCleanDir(iconsetDir);

  const basePng = path.join(outputDir, 'app-icon-1024.png');
  renderSvgToPng(sourceSvg, basePng);
  buildIconset(basePng, iconsetDir);
  runOrThrow('iconutil', ['-c', 'icns', iconsetDir, '-o', outputIcns]);

  return { outputIcns, iconsetDir, basePng };
}

export function stageShareWorkerRuntime(projectRoot) {
  const { sourceCandidates, runtimeDir, runtimePath } = resolveShareWorkerPaths(projectRoot);
  const sourcePath = sourceCandidates.find((candidate) => fs.existsSync(candidate));
  if (!sourcePath) {
    throw new Error(`share worker source not found; tried: ${sourceCandidates.join(', ')}`);
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(sourcePath, runtimePath);
  return runtimePath;
}

export function runPackaging(projectRoot) {
  const { runtimeDir, defaultSeedPath, bundledSeedPath, liveProfilePath } = resolveRuntimePaths(projectRoot);
  fs.mkdirSync(runtimeDir, { recursive: true });

  if (fs.existsSync(liveProfilePath)) {
    fs.copyFileSync(liveProfilePath, bundledSeedPath);
  } else if (fs.existsSync(defaultSeedPath)) {
    fs.copyFileSync(defaultSeedPath, bundledSeedPath);
  }

  stageShareWorkerRuntime(projectRoot);
  prepareMacIcon(projectRoot);

  return spawnSync('npx', ['electron-builder', '--mac', 'dmg'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
}

if (process.argv[1] === __filename) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const result = runPackaging(projectRoot);
  process.exit(result.status ?? 1);
}
