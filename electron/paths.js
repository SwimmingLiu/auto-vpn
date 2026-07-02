import fs from 'node:fs';
import os from 'node:os';
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

function expandHomePath(value) {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function resolveUserRuntimeRoot(options = {}) {
  const { runtimeRootPath = '' } = options;
  if (runtimeRootPath) {
    return path.resolve(expandHomePath(runtimeRootPath));
  }
  if (process.env.VPN_AUTOMATION_RUNTIME_ROOT) {
    return path.resolve(expandHomePath(process.env.VPN_AUTOMATION_RUNTIME_ROOT));
  }
  return path.join(os.homedir(), '.auto-vpn');
}

export function resolveStateProfilePath(projectRoot, options = {}) {
  return path.join(resolveUserRuntimeRoot(options), 'profile.toml');
}

export function resolveLegacyPackagedProfilePath(options = {}) {
  const { isPackaged = false, userDataPath = '' } = options;
  if (!isPackaged || !userDataPath) {
    return '';
  }
  return path.join(userDataPath, 'state', 'profile.toml');
}

export function resolveRuntimeArtifactsPath(projectRoot, options = {}) {
  return path.join(resolveUserRuntimeRoot(options), 'artifacts');
}

export function resolveBundledProfilePath(projectRoot) {
  const localRoot = path.resolve(projectRoot);
  return path.join(localRoot, 'electron', 'runtime', 'bundled-profile.toml');
}
