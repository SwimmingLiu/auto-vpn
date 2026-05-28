import fs from 'node:fs';
import path from 'node:path';

export function buildPythonCandidates(projectRoot) {
  return [
    path.join(projectRoot, '.venv', 'bin', 'python'),
    path.join(projectRoot, '.venv', 'bin', 'python3'),
    '/opt/homebrew/bin/python3.14',
    '/opt/homebrew/bin/python3.12',
    '/usr/local/bin/python3.14',
    '/usr/local/bin/python3.12',
    'python3.12',
    'python3'
  ];
}

export function resolveBackendPython(projectRoot) {
  const candidates = buildPythonCandidates(projectRoot);

  return candidates.filter((candidate, index) => {
    if (candidate.startsWith('/')) {
      return fs.existsSync(candidate);
    }
    return candidates.indexOf(candidate) === index;
  });
}

export function resolvePythonVendorPath(projectRoot) {
  return path.join(projectRoot, 'electron', 'runtime', 'python-vendor');
}

export function buildBackendEnv(projectRoot, runtimeProfilePath = '', bundledProfilePath = '') {
  const pythonPaths = [path.join(projectRoot, 'src')];
  const vendorPath = resolvePythonVendorPath(projectRoot);
  if (fs.existsSync(vendorPath)) {
    pythonPaths.push(vendorPath);
  }

  return {
    ...process.env,
    PYTHONPATH: pythonPaths.join(path.delimiter),
    VPN_AUTOMATION_PROFILE_PATH: runtimeProfilePath,
    VPN_AUTOMATION_BUNDLED_PROFILE_PATH: bundledProfilePath
  };
}

export function buildBackendInvocation(projectRoot, command, extraArgs = []) {
  return {
    commands: resolveBackendPython(projectRoot),
    args: ['-m', 'vpn_automation.backend', command, '--project-root', projectRoot, ...extraArgs]
  };
}

export function parseBackendEventLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      type: 'log',
      message: trimmed
    };
  }
}
