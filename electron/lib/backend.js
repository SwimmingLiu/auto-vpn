export function buildBackendInvocation(projectRoot, command) {
  return {
    command: 'python3',
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
