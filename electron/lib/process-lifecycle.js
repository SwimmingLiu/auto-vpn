export function resolveSignalTarget(child, platform = process.platform) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    return null;
  }
  return platform === 'win32' ? child.pid : -child.pid;
}

export function signalProcessTree(
  child,
  signal,
  {
    platform = process.platform,
    killProcess = process.kill
  } = {}
) {
  const target = resolveSignalTarget(child, platform);
  if (target === null) {
    return false;
  }

  try {
    killProcess(target, signal);
    return true;
  } catch (error) {
    if (target < 0 && error?.code === 'ESRCH' && typeof child.kill === 'function') {
      return child.kill(signal);
    }
    if (error?.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}
