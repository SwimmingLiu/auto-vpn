import fs from 'node:fs';
import path from 'node:path';
import { spawnSync as defaultSpawnSync } from 'node:child_process';

export interface StopProcessOptions {
  timeoutMs?: number;
  isAlive?: (pid: number) => boolean;
  signalProcess?: (target: number, signal: NodeJS.Signals) => void;
  spawnSync?: typeof defaultSpawnSync;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

function resolvedArg(value: string): string {
  if (!path.isAbsolute(value)) {
    return value;
  }
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

export function cmdlineMatchesJob(cmdline: Buffer, command: string[]): boolean {
  const actual = cmdline.toString('utf8').split('\0').filter((value) => value.length > 0);
  const expected = command.map(String);
  if (actual.length !== expected.length || expected.length < 5) {
    return false;
  }
  if (path.basename(expected[1]) !== 'autovpn.mjs' || path.basename(actual[1]) !== 'autovpn.mjs') {
    return false;
  }
  const projectRootIndex = expected.findIndex((value) => value === '--project-root');
  if (projectRootIndex < 3 || !expected[projectRootIndex + 1]) {
    return false;
  }
  return expected.every((value, index) => {
    if (index <= 1 || index === projectRootIndex + 1) {
      return resolvedArg(actual[index]) === resolvedArg(value);
    }
    return actual[index] === value;
  });
}

export function processMatchesJob(pid: number, command: string[]): boolean {
  const cmdlinePath = path.join('/proc', String(pid), 'cmdline');
  if (!fs.existsSync(cmdlinePath)) {
    // Without an argv-bearing process API, fail closed instead of risking a
    // recycled PID on macOS or Windows. Callers can inject a platform matcher.
    return false;
  }
  try {
    return cmdlineMatchesJob(fs.readFileSync(cmdlinePath), command);
  } catch {
    return false;
  }
}

function defaultIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultSignalProcess(target: number, signal: NodeJS.Signals, options: StopProcessOptions): void {
  if ((options.platform ?? process.platform) === 'win32') {
    const tree = signal === 'SIGKILL' ? ['/pid', String(target), '/t', '/f'] : ['/pid', String(target), '/t'];
    (options.spawnSync ?? defaultSpawnSync)('taskkill', tree, { stdio: 'ignore' });
    return;
  }
  process.kill(target, signal);
}

function isNoSuchProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function signalTarget(pid: number, platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? pid : -pid;
}

export async function terminateProcessGroup(pid: number, options: StopProcessOptions = {}): Promise<void> {
  if (pid <= 0) return;
  const platform = options.platform ?? process.platform;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const signalProcess = options.signalProcess;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 4000;
  const target = signalTarget(pid, platform);

  if (!isAlive(pid)) return;
  try {
    if (signalProcess) {
      signalProcess(target, 'SIGTERM');
    } else {
      defaultSignalProcess(target, 'SIGTERM', options);
    }
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return;
    }
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await sleep(100);
  }
  if (isAlive(pid)) {
    try {
      if (signalProcess) {
        signalProcess(target, 'SIGKILL');
      } else {
        defaultSignalProcess(target, 'SIGKILL', options);
      }
    } catch (error) {
      if (!isNoSuchProcess(error)) {
        throw error;
      }
    }
  }
}
