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

export interface ProcessMatchOptions {
  platform?: NodeJS.Platform;
  spawnSync?: typeof defaultSpawnSync;
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

function jobIdentity(command: string[]): { entry: string; projectRoot: string; token: string; executable: string } | undefined {
  const expected = command.map(String);
  const tokenIndex = expected.indexOf('--internal-job-token');
  const projectRootIndex = expected.indexOf('--project-root');
  const token = expected[tokenIndex + 1] ?? '';
  if (
    expected.length < 7
    || path.basename(expected[1] ?? '') !== 'autovpn.mjs'
    || projectRootIndex < 3
    || !expected[projectRootIndex + 1]
    || tokenIndex < 3
    || !/^[a-f0-9]{64}$/i.test(token)
  ) {
    return undefined;
  }
  return {
    executable: resolvedArg(expected[0]),
    entry: resolvedArg(expected[1]),
    projectRoot: resolvedArg(expected[projectRootIndex + 1]),
    token: token.toLowerCase()
  };
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandTextMatchesJob(commandLine: string, command: string[]): boolean {
  const identity = jobIdentity(command);
  if (!identity || !commandLine.trim()) {
    return false;
  }
  const tokenPattern = new RegExp(`(?:^|[\\s"'])${escaped(identity.token)}(?:$|[\\s"'])`, 'i');
  const normalized = commandLine.replaceAll('\\', '/');
  const projectRootIndex = command.indexOf('--project-root');
  const containsPath = (value: string) => [value, resolvedArg(value)]
    .map((candidate) => candidate.replaceAll('\\', '/'))
    .some((candidate) => normalized.includes(candidate));
  return tokenPattern.test(commandLine)
    && containsPath(command[1])
    && containsPath(command[projectRootIndex + 1])
    && containsPath(command[0]);
}

export function cmdlineMatchesJob(cmdline: Buffer, command: string[]): boolean {
  const actual = cmdline.toString('utf8').split('\0').filter((value) => value.length > 0);
  const expected = command.map(String);
  const identity = jobIdentity(expected);
  if (!identity || actual.length !== expected.length) {
    return false;
  }
  if (path.basename(expected[1]) !== 'autovpn.mjs' || path.basename(actual[1]) !== 'autovpn.mjs') {
    return false;
  }
  const projectRootIndex = expected.indexOf('--project-root');
  return expected.every((value, index) => {
    if (index <= 1 || index === projectRootIndex + 1) {
      return resolvedArg(actual[index]) === resolvedArg(value);
    }
    return actual[index] === value;
  });
}

export function processMatchesJob(pid: number, command: string[], options: ProcessMatchOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (!jobIdentity(command)) {
    return false;
  }
  const cmdlinePath = path.join('/proc', String(pid), 'cmdline');
  if (platform === 'linux') {
    if (!fs.existsSync(cmdlinePath)) {
      return false;
    }
    try {
      return cmdlineMatchesJob(fs.readFileSync(cmdlinePath), command);
    } catch {
      return false;
    }
  }
  const spawnSync = options.spawnSync ?? defaultSpawnSync;
  const lookup = platform === 'win32'
    ? spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
    ], { encoding: 'utf8', windowsHide: true })
    : spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (lookup.status !== 0 || typeof lookup.stdout !== 'string') {
    return false;
  }
  return commandTextMatchesJob(lookup.stdout, command);
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
