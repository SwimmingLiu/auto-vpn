import fs from 'node:fs';
import path from 'node:path';

export function resolveBackendPython(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.venv', 'bin', 'python'),
    path.join(projectRoot, '.venv', 'bin', 'python3'),
    'python3.12',
    'python3'
  ];

  return candidates.filter((candidate, index) => {
    if (candidate.startsWith('/')) {
      return fs.existsSync(candidate);
    }
    return candidates.indexOf(candidate) === index;
  });
}

export function buildBackendInvocation(projectRoot, command) {
  return {
    commands: resolveBackendPython(projectRoot),
    args: ['-m', 'vpn_automation.backend', command, '--project-root', projectRoot]
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
