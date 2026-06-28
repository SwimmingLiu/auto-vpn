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

export function processMatchesJob(pid: number, command: string[]): boolean {
  const cmdlinePath = path.join('/proc', String(pid), 'cmdline');
  if (!fs.existsSync(cmdlinePath)) {
    return true;
  }
  try {
    const cmdline = fs.readFileSync(cmdlinePath).toString('utf8').replaceAll('\0', ' ');
    const markers = ['vpn_automation.backend'];
    if (command.length > 0) {
      markers.push(path.basename(String(command[0])));
    }
    return markers.some((marker) => marker.length > 0 && cmdline.includes(marker));
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
  if (signalProcess) {
    signalProcess(target, 'SIGTERM');
  } else {
    defaultSignalProcess(target, 'SIGTERM', options);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await sleep(100);
  }
  if (isAlive(pid)) {
    if (signalProcess) {
      signalProcess(target, 'SIGKILL');
    } else {
      defaultSignalProcess(target, 'SIGKILL', options);
    }
  }
}
