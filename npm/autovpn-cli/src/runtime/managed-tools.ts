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
  runCommand?: ManagedToolRunCommand;
}

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

export class ManagedToolError extends Error {
  readonly code: string;

  constructor(message: string, code = 'MANAGED_TOOL_ERROR') {
    super(message);
    this.name = 'ManagedToolError';
    this.code = code;
  }
}

export async function resolveManagedNpmTool(options: ResolveManagedNpmToolOptions): Promise<ManagedNpmToolResolution> {
  const packageName = requireNonEmpty(options.packageName, 'packageName');
  const binaryName = requireNonEmpty(options.binaryName, 'binaryName');
  const version = requireNonEmpty(options.version, 'version');
  const toolsRoot = path.resolve(options.toolsRoot ?? path.join(resolveUserRuntimeRoot(), 'tools'));
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const runCommand = options.runCommand ?? runCommandWithSpawn;
  const managed = managedToolPaths(toolsRoot, packageName, version, binaryName);

  if (await isExecutable(managed.binaryPath)) {
    await verifyToolVersion(managed.binaryPath, managed.installDir, runCommand, 'managed');
    return {
      command: managed.binaryPath,
      args: [],
      source: 'managed',
      packageName,
      version
    };
  }

  if (options.allowProjectFallback) {
    const projectBinary = path.join(projectRoot, 'node_modules', '.bin', binaryName);
    if (await isExecutable(projectBinary)) {
      await verifyToolVersion(projectBinary, projectRoot, runCommand, 'project');
      return {
        command: projectBinary,
        args: [],
        source: 'project',
        packageName,
        version
      };
    }
  }

  if (!options.installMissing) {
    throw new ManagedToolError(`Managed npm tool ${packageName}@${version} is not installed`, 'MANAGED_TOOL_MISSING');
  }

  await installManagedTool(packageName, version, managed.installDir, runCommand);

  if (!(await isExecutable(managed.binaryPath))) {
    throw new ManagedToolError(
      `npm install completed but ${binaryName} was not found at the managed tool path`,
      'MANAGED_TOOL_BINARY_MISSING'
    );
  }

  await verifyToolVersion(managed.binaryPath, managed.installDir, runCommand, 'managed');
  return {
    command: managed.binaryPath,
    args: [],
    source: 'managed',
    packageName,
    version
  };
}

function managedToolPaths(toolsRoot: string, packageName: string, version: string, binaryName: string) {
  const installDir = path.join(toolsRoot, 'npm', packageName, version);
  return {
    installDir,
    binaryPath: path.join(installDir, 'node_modules', '.bin', binaryName)
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
    result = await runCommand(['npm', 'install', '--no-save', '--no-audit', '--no-fund', `${packageName}@${version}`], {
      cwd: installDir,
      env: { NPM_CONFIG_YES: 'true' }
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

async function verifyToolVersion(
  binaryPath: string,
  cwd: string,
  runCommand: ManagedToolRunCommand,
  source: ManagedNpmToolSource
): Promise<void> {
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
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommandWithSpawn(
  command: string[],
  options: { cwd: string; env: Record<string, string> },
  spawnImpl: SpawnLike = defaultSpawn
): Promise<ManagedToolCommandResult> {
  const [executable, ...args] = command;
  const child = spawnImpl(executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
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
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ returncode: exitCode ?? 1, stdout, stderr });
    });
  });
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

function requireNonEmpty(value: string, name: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new ManagedToolError(`${name} is required`, 'MANAGED_TOOL_INVALID_OPTIONS');
  }
  return trimmed;
}
