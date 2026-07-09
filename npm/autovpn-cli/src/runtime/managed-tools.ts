import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolveUserRuntimeRoot } from './paths.js';

export type ManagedNpmToolSource = 'managed' | 'project';

export interface ManagedNpmToolResolution {
  command: string;
  args: string[];
  source: ManagedNpmToolSource;
  packageName: string;
  version: string;
  requestedVersion?: string;
}

export type ManagedToolCommandResult = {
  returncode: number;
  stdout: string;
  stderr: string;
};

export type ManagedToolRunCommand = (
  command: string[],
  options: { cwd: string; env: Record<string, string> }
) => Promise<ManagedToolCommandResult>;

export interface ResolveManagedNpmToolOptions {
  packageName: string;
  binaryName: string;
  version: string;
  toolsRoot?: string;
  projectRoot?: string;
  installMissing?: boolean;
  allowProjectFallback?: boolean;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  runCommand?: ManagedToolRunCommand;
}

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

export interface ManagedToolSpawnCommand {
  executable: string;
  args: string[];
}

const DEFAULT_MANAGED_NPM_REGISTRY = 'https://registry.npmmirror.com';

export class ManagedToolError extends Error {
  readonly code: string;

  constructor(message: string, code = 'MANAGED_TOOL_ERROR') {
    super(message);
    this.name = 'ManagedToolError';
    this.code = code;
  }
}

export async function resolveManagedNpmTool(options: ResolveManagedNpmToolOptions): Promise<ManagedNpmToolResolution> {
  const packageName = validatePackageName(options.packageName);
  const binaryName = validateSinglePathPart(options.binaryName, 'binaryName');
  const version = validateSinglePathPart(options.version, 'version');
  const toolsRoot = path.resolve(options.toolsRoot ?? path.join(resolveUserRuntimeRoot(), 'tools'));
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const timeoutMs = validateTimeoutMs(options.timeoutMs ?? 120000);
  const platform = options.platform ?? process.platform;
  const runCommand =
    options.runCommand ??
    ((command, commandOptions) => runCommandWithSpawn(command, { ...commandOptions, timeoutMs }));
  const managed = managedToolPaths(toolsRoot, packageName, version, binaryName);
  const allowProjectFallback = options.allowProjectFallback ?? true;
  const installMissing = options.installMissing ?? true;

  const managedBinary = await firstExecutable(resolveManagedNpmToolBinaryCandidates(managed.binDir, binaryName, platform));
  if (managedBinary) {
    const verifiedVersion = await verifyToolVersion(managedBinary, managed.installDir, runCommand, 'managed');
    return {
      command: managedBinary,
      args: [],
      source: 'managed',
      packageName,
      version: verifiedVersion,
      requestedVersion: version
    };
  }

  if (allowProjectFallback) {
    const projectBinDir = path.join(projectRoot, 'node_modules', '.bin');
    const projectBinary = await firstExecutable(resolveManagedNpmToolBinaryCandidates(projectBinDir, binaryName, platform));
    if (projectBinary) {
      const verifiedVersion = await verifyToolVersion(projectBinary, projectRoot, runCommand, 'project');
      return {
        command: projectBinary,
        args: [],
        source: 'project',
        packageName,
        version: verifiedVersion,
        requestedVersion: version
      };
    }
  }

  if (!installMissing) {
    throw new ManagedToolError(`Managed npm tool ${packageName}@${version} is not installed`, 'MANAGED_TOOL_MISSING');
  }

  await installManagedTool(packageName, version, managed.installDir, runCommand);

  const installedBinary = await firstExecutable(resolveManagedNpmToolBinaryCandidates(managed.binDir, binaryName, platform));
  if (!installedBinary) {
    throw new ManagedToolError(
      `npm install completed but ${binaryName} was not found at the managed tool path`,
      'MANAGED_TOOL_BINARY_MISSING'
    );
  }

  const verifiedVersion = await verifyToolVersion(installedBinary, managed.installDir, runCommand, 'managed');
  return {
    command: installedBinary,
    args: [],
    source: 'managed',
    packageName,
    version: verifiedVersion,
    requestedVersion: version
  };
}

export function resolveManagedNpmToolBinaryCandidates(
  binDir: string,
  binaryName: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const safeBinaryName = validateSinglePathPart(binaryName, 'binaryName');
  const primary = path.join(binDir, safeBinaryName);
  if (platform === 'win32' && !safeBinaryName.toLowerCase().endsWith('.cmd')) {
    return [primary, `${primary}.cmd`];
  }
  return [primary];
}

export function normalizeManagedToolCommandForSpawn(
  command: string[],
  platform: NodeJS.Platform = process.platform
): ManagedToolSpawnCommand {
  const [executable, ...args] = command;
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    return {
      executable: 'cmd.exe',
      args: ['/d', '/s', '/c', [executable, ...args].map(quoteWindowsCmdArgument).join(' ')]
    };
  }
  return { executable, args };
}

function managedToolPaths(toolsRoot: string, packageName: string, version: string, binaryName: string) {
  const installDir = path.join(toolsRoot, 'npm', packageName, version);
  return {
    installDir,
    binDir: path.join(installDir, 'node_modules', '.bin')
  };
}

async function installManagedTool(
  packageName: string,
  version: string,
  installDir: string,
  runCommand: ManagedToolRunCommand
): Promise<void> {
  await mkdir(installDir, { recursive: true });
  let result: ManagedToolCommandResult;
  try {
    result = await runCommand(['npm', '--prefix', installDir, 'install', '--no-save', '--no-audit', '--no-fund', `${packageName}@${version}`], {
      cwd: installDir,
      env: {
        NPM_CONFIG_YES: 'true',
        NPM_CONFIG_REGISTRY: resolveManagedNpmRegistry()
      }
    });
  } catch (error) {
    throw new ManagedToolError(
      `npm install failed for ${packageName}@${version}: ${safeErrorMessage(error)}`,
      'MANAGED_TOOL_INSTALL_FAILED'
    );
  }
  if (result.returncode !== 0) {
    throw new ManagedToolError(`npm install failed for ${packageName}@${version}: ${safeCommandMessage(result)}`, 'MANAGED_TOOL_INSTALL_FAILED');
  }
}

function resolveManagedNpmRegistry(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.NPM_CONFIG_REGISTRY || env.npm_config_registry || DEFAULT_MANAGED_NPM_REGISTRY);
}

async function verifyToolVersion(
  binaryPath: string,
  cwd: string,
  runCommand: ManagedToolRunCommand,
  source: ManagedNpmToolSource
): Promise<string> {
  let result: ManagedToolCommandResult;
  try {
    result = await runCommand([binaryPath, '--version'], { cwd, env: {} });
  } catch (error) {
    throw new ManagedToolError(
      `Managed npm tool ${source} verification failed: ${safeErrorMessage(error)}`,
      'MANAGED_TOOL_VERSION_FAILED'
    );
  }
  if (result.returncode !== 0) {
    throw new ManagedToolError(
      `Managed npm tool ${source} verification failed: ${safeCommandMessage(result)}`,
      'MANAGED_TOOL_VERSION_FAILED'
    );
  }
  return firstOutputLine(result.stdout || result.stderr) || 'unknown';
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExecutable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function runCommandWithSpawn(
  command: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
  spawnImpl: SpawnLike = defaultSpawn
): Promise<ManagedToolCommandResult> {
  const { executable, args } = normalizeManagedToolCommandForSpawn(command);
  const child = spawnImpl(executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killTimedOutChild(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        returncode: 1,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}command timed out after ${options.timeoutMs}ms`
      });
    }, options.timeoutMs);
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ returncode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function quoteWindowsCmdArgument(value: string): string {
  const escaped = value.replace(/(["^&|<>()%!])/g, '^$1');
  return `"${escaped}"`;
}

function firstOutputLine(value: string): string {
  return value.trim().split(/\r?\n/)[0]?.trim() ?? '';
}

function killTimedOutChild(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  child.kill('SIGKILL');
}

function safeCommandMessage(result: ManagedToolCommandResult): string {
  const output = [result.stderr, result.stdout].filter((value) => value.trim()).join('\n').trim();
  const message = output || `exit code ${result.returncode}`;
  return truncate(message.replace(/\s+/g, ' '), 640);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return truncate(error.message.replace(/\s+/g, ' '), 640);
  }
  return truncate(String(error).replace(/\s+/g, ' '), 640);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function validatePackageName(value: string): string {
  const packageName = requireNonEmpty(value, 'packageName');
  if (path.isAbsolute(packageName) || packageName.includes('\\')) {
    throw new ManagedToolError('packageName contains unsafe path characters', 'MANAGED_TOOL_INVALID_OPTIONS');
  }
  const parts = packageName.split('/');
  const scoped = packageName.startsWith('@');
  if ((scoped && parts.length !== 2) || (!scoped && parts.length !== 1)) {
    throw new ManagedToolError('packageName contains unsafe path segments', 'MANAGED_TOOL_INVALID_OPTIONS');
  }
  for (const part of parts) {
    rejectUnsafePathPart(part, 'packageName');
  }
  return packageName;
}

function validateSinglePathPart(value: string, name: string): string {
  const part = requireNonEmpty(value, name);
  if (path.isAbsolute(part) || part.includes('/') || part.includes('\\')) {
    throw new ManagedToolError(`${name} contains unsafe path characters`, 'MANAGED_TOOL_INVALID_OPTIONS');
  }
  rejectUnsafePathPart(part, name);
  return part;
}

function rejectUnsafePathPart(part: string, name: string): void {
  if (!part || part === '.' || part === '..') {
    throw new ManagedToolError(`${name} contains unsafe path segments`, 'MANAGED_TOOL_INVALID_OPTIONS');
  }
}

function validateTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ManagedToolError('timeoutMs must be a positive number', 'MANAGED_TOOL_INVALID_OPTIONS');
  }
  return value;
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new ManagedToolError(`${name} is required`, 'MANAGED_TOOL_INVALID_OPTIONS');
  }
  return trimmed;
}
