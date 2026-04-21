import fs from 'node:fs';
import path from 'node:path';

export function resolveBackendPython(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.venv', 'bin', 'python'),
    path.join(projectRoot, '.venv', 'bin', 'python3'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'python3.12';
}

export function buildBackendInvocation(projectRoot, command) {
  return {
    command: resolveBackendPython(projectRoot),
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
