import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
  return path.join(resolveRepoAnchor(projectRoot), 'state', 'profiles', 'default.json');
}

export function resolveRuntimePaths(projectRoot) {
  const runtimeDir = path.join(projectRoot, 'electron', 'runtime');
  return {
    runtimeDir,
    defaultSeedPath: path.join(runtimeDir, 'default-profile.json'),
    bundledSeedPath: path.join(runtimeDir, 'bundled-profile.json'),
    liveProfilePath: resolveLiveProfilePath(projectRoot)
  };
}

export function runPackaging(projectRoot) {
  const { runtimeDir, defaultSeedPath, bundledSeedPath, liveProfilePath } = resolveRuntimePaths(projectRoot);
  fs.mkdirSync(runtimeDir, { recursive: true });

  if (fs.existsSync(liveProfilePath)) {
    fs.copyFileSync(liveProfilePath, bundledSeedPath);
  } else if (fs.existsSync(defaultSeedPath)) {
    fs.copyFileSync(defaultSeedPath, bundledSeedPath);
  }

  return spawnSync('npx', ['electron-builder', '--mac', 'dir'], {
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
