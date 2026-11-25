/**
 * Minify and obfuscate a Worker bundle before it is uploaded.
 *
 * Two things are being protected here, and they pull in opposite directions:
 *
 *   - The uploaded `_worker.js` is executable code served for every request the
 *     Worker handles. Control-flow flattening and dead-code injection raise its
 *     per-request CPU cost, so the file is minified first: minification drops
 *     the decoy comment corpus and the original formatting, which is roughly
 *     96% of the template's bytes and costs nothing at runtime, leaving the
 *     obfuscator's budget for the code that actually runs.
 *   - The same file is what an attacker gets if the bundle leaks. Every
 *     identifier is renamed, every literal is moved into an RC4 string array,
 *     object keys are transformed and the control flow is flattened, so the
 *     recovered text has no names, no literals and no statement structure.
 *
 * The historical settings are kept deliberately: they match the flags the
 * Python pipeline generated (`build_obfuscate_command`) and the upstream
 * edgetunnel workflow, so a bundle built today is obfuscated the same way a
 * bundle built before the Node migration was. `obfuscateBundle` is fail-closed:
 * a missing obfuscator or a failed run throws, and the caller must not fall
 * back to uploading the plain source.
 */
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveManagedNpmTool, type ResolveManagedNpmToolOptions, type ManagedNpmToolResolution } from '../runtime/managed-tools.js';

export const OBFUSCATOR_PACKAGE = 'javascript-obfuscator';
export const OBFUSCATOR_VERSION = '5.4.3';
/** Must match the `esbuild` dev dependency; used only when no local copy exists. */
export const ESBUILD_VERSION = '0.28.2';

/**
 * The exact flags the Python pipeline used (`node_tools.py`,
 * `build_obfuscate_command`) and that the edgetunnel `obfuscator_vpn.yml`
 * workflow passes. Order is kept so a diff against the old command is readable.
 */
export const WORKER_OBFUSCATOR_FLAGS: readonly string[] = [
  '--compact', 'true',
  '--control-flow-flattening', 'true',
  '--control-flow-flattening-threshold', '1',
  '--dead-code-injection', 'true',
  '--dead-code-injection-threshold', '1',
  '--identifier-names-generator', 'hexadecimal',
  '--rename-globals', 'true',
  '--string-array', 'true',
  '--string-array-encoding', 'rc4',
  '--string-array-threshold', '1',
  '--transform-object-keys', 'true',
  '--unicode-escape-sequence', 'true'
];

/** esbuild's own flags. `--minify` drops comments, so the decoy corpus and the
 * source comments never reach the obfuscator or the uploaded bundle. */
export const MINIFY_FLAGS: readonly string[] = [
  '--minify',
  '--format=esm',
  '--target=es2022'
];

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;
type RunCommandLike = (
  command: string[],
  options: { cwd: string; env: Record<string, string> }
) => Promise<{ returncode: number; stdout: string; stderr: string }>;

export interface BundleObfuscatorDeps {
  resolveTool?: (options: ResolveManagedNpmToolOptions) => Promise<ManagedNpmToolResolution>;
  runCommand?: RunCommandLike;
  spawn?: SpawnLike;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BundleObfuscationResult {
  source: string;
  minifiedBytes: number;
  obfuscatedBytes: number;
  obfuscatorVersion: string;
}

function runCommandWithSpawn(
  command: string[],
  options: { cwd: string; env: Record<string, string> },
  spawnImpl: SpawnLike = defaultSpawn
): Promise<{ returncode: number; stdout: string; stderr: string }> {
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

export function buildMinifyCommand(esbuildExecutable: string, inputPath: string, outputPath: string): string[] {
  return [esbuildExecutable, inputPath, ...MINIFY_FLAGS, `--outfile=${outputPath}`];
}

export function buildObfuscateCommand(obfuscatorExecutable: string, inputPath: string, outputPath: string): string[] {
  return [obfuscatorExecutable, inputPath, '--output', outputPath, ...WORKER_OBFUSCATOR_FLAGS];
}

/**
 * Resolve esbuild.
 *
 * A checkout has it twice over (the repository root for the UI build, and this
 * package's own dev dependency), so the local copies are tried first and cost
 * nothing. A packaged app installs its CLI with `--omit=dev`, which leaves no
 * local esbuild at all, so the managed-tool path is the fallback: install once
 * into the user runtime root, then reuse it. An explicit `WORKER_ESBUILD_BIN`
 * wins over both.
 *
 * A missing binary is an error. Falling through to the unobfuscated source
 * would upload readable code, which is the thing this file exists to prevent.
 */
async function resolveEsbuildExecutable(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  resolveTool: (options: ResolveManagedNpmToolOptions) => Promise<ManagedNpmToolResolution>
): Promise<string> {
  const override = String(env.WORKER_ESBUILD_BIN ?? '').trim();
  if (override) return override;
  const binary = process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild';
  const candidates = [
    path.join(projectRoot, 'npm', 'autovpn-cli', 'node_modules', '.bin', binary),
    path.join(projectRoot, 'node_modules', '.bin', binary),
    path.join(projectRoot, 'node_modules', 'esbuild', 'bin', 'esbuild')
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  try {
    const managed = await resolveTool({
      packageName: 'esbuild',
      binaryName: 'esbuild',
      version: ESBUILD_VERSION,
      projectRoot,
      installMissing: true
    });
    return managed.command;
  } catch (error) {
    throw new Error(
      `esbuild was not found under ${projectRoot} and could not be installed: the Worker bundle must be minified ` +
        `before it is obfuscated (${error instanceof Error ? error.message : String(error)}). ` +
        'Install the CLI dependencies (`npm --prefix npm/autovpn-cli ci`) or set WORKER_ESBUILD_BIN.'
    );
  }
}

/**
 * Minify, then obfuscate, a Worker source file.
 *
 * Throws on any failure. The caller writes the returned source to the bundle
 * directory; it must not catch this and fall back to the input.
 */
export async function obfuscateBundle(
  source: string,
  options: { projectRoot: string; deps?: BundleObfuscatorDeps } = { projectRoot: process.cwd() }
): Promise<BundleObfuscationResult> {
  const deps = options.deps ?? {};
  const env = deps.env ?? process.env;
  const runCommand = deps.runCommand ?? ((command, commandOptions) => runCommandWithSpawn(command, commandOptions, deps.spawn));
  const resolveTool = deps.resolveTool ?? resolveManagedNpmTool;
  const esbuildExecutable = await resolveEsbuildExecutable(options.projectRoot, env, resolveTool);
  const obfuscator = await resolveTool({
    packageName: OBFUSCATOR_PACKAGE,
    binaryName: OBFUSCATOR_PACKAGE,
    version: OBFUSCATOR_VERSION,
    projectRoot: options.projectRoot,
    // Same policy as wrangler: reuse the managed install, else the project's
    // own, else install once. A deploy must not depend on a prior manual step.
    installMissing: true
  });

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'worker-bundle-'));
  try {
    const inputPath = path.join(workDir, 'input.js');
    const minifiedPath = path.join(workDir, 'minified.js');
    const outputPath = path.join(workDir, 'output.js');
    await writeFile(inputPath, source, 'utf8');

    const minified = await runCommand(buildMinifyCommand(esbuildExecutable, inputPath, minifiedPath), {
      cwd: workDir,
      env: env as Record<string, string>
    });
    if (minified.returncode !== 0) {
      throw new Error(`worker minify failed (${minified.returncode}): ${minified.stderr || minified.stdout}`);
    }

    const obfuscated = await runCommand(buildObfuscateCommand(obfuscator.command, minifiedPath, outputPath), {
      cwd: workDir,
      env: env as Record<string, string>
    });
    if (obfuscated.returncode !== 0) {
      throw new Error(`worker obfuscate failed (${obfuscated.returncode}): ${obfuscated.stderr || obfuscated.stdout}`);
    }

    const [minifiedSource, obfuscatedSource] = await Promise.all([
      readFile(minifiedPath, 'utf8'),
      readFile(outputPath, 'utf8')
    ]);
    if (!obfuscatedSource.trim()) {
      throw new Error('worker obfuscate produced an empty bundle');
    }
    return {
      source: obfuscatedSource,
      minifiedBytes: Buffer.byteLength(minifiedSource, 'utf8'),
      obfuscatedBytes: Buffer.byteLength(obfuscatedSource, 'utf8'),
      obfuscatorVersion: obfuscator.version
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
