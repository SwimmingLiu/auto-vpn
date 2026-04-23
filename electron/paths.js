import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

function isProjectRoot(candidate) {
  return (
    fs.existsSync(path.join(candidate, 'pyproject.toml')) &&
    fs.existsSync(path.join(candidate, 'src', 'vpn_automation'))
  );
}

export function findProjectRoot(startPath) {
  let current = path.resolve(startPath);
  if (!fs.existsSync(current)) {
    current = path.dirname(current);
  } else if (fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }

  while (true) {
    if (isProjectRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

export function resolveProjectRoot(explicitRoot = '') {
  if (explicitRoot) {
    return explicitRoot;
  }
  if (process.env.VPN_AUTOMATION_PROJECT_ROOT) {
    return process.env.VPN_AUTOMATION_PROJECT_ROOT;
  }
  const fromExecPath = findProjectRoot(process.execPath);
  if (isProjectRoot(fromExecPath)) {
    return fromExecPath;
  }
  return findProjectRoot(currentDir);
}

export function resolveStateProfilePath(projectRoot, options = {}) {
  const { isPackaged = false, userDataPath = '' } = options;
  if (isPackaged && userDataPath) {
    return path.join(userDataPath, 'state', 'profile.toml');
  }

  const localRoot = path.resolve(projectRoot);
  const localPath = path.join(localRoot, 'state', 'profile.toml');
  const parts = localRoot.split(path.sep);
  const worktreeIndex = parts.indexOf('.worktrees');

  if (worktreeIndex === -1) {
    return localPath;
  }

  const repoRoot = parts.slice(0, worktreeIndex).join(path.sep) || path.sep;
  const anchorPath = path.join(repoRoot, 'state', 'profile.toml');
  return anchorPath;
}

export function resolveBundledProfilePath(projectRoot) {
  const localRoot = path.resolve(projectRoot);
  return path.join(localRoot, 'electron', 'runtime', 'bundled-profile.toml');
}
