import { spawnSync } from 'node:child_process';

function runWindowsTaskkill(args) {
  return spawnSync('taskkill', args, { stdio: 'ignore' });
}

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
    killProcess = process.kill,
    runTaskkill = runWindowsTaskkill
  } = {}
) {
  const target = resolveSignalTarget(child, platform);
  if (target === null) {
    return false;
  }

  if (platform === 'win32') {
    const args = ['/PID', String(target), '/T'];
    if (signal === 'SIGKILL') {
      args.push('/F');
    }
    const result = runTaskkill(args);
    if (result?.error) {
      throw result.error;
    }
    return result?.status === 0;
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
