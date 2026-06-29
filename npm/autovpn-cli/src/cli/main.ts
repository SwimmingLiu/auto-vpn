import { validateCommand } from './commands/index.js';
import { CliUsageError } from './errors.js';
import { normalizeProjectRootArgs } from './global-options.js';
import { JobRuntimeOptions, runNativeCommand } from './native-commands.js';
import { CliIo, defaultIo, renderHelp } from './output.js';
import { AutoVpnBackend } from '../backend/types.js';
import { selectBackend } from '../backend/select-backend.js';
import { readOptionValue, resolveProjectRoot } from '../runtime/paths.js';

type RunForwarder = (argv: string[]) => Promise<number>;
type ReadPackageVersion = () => string | Promise<string>;
type ShellBackend = Pick<AutoVpnBackend, 'executeCli'> & Partial<Pick<AutoVpnBackend, 'run' | 'kind'>>;
type CreateBackend = (options: { env: NodeJS.ProcessEnv; cwd: string; runForwarder: RunForwarder }) => ShellBackend;

export interface CliShellOptions {
  packageVersion?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  runForwarder?: RunForwarder;
  createBackend?: CreateBackend;
  readPackageVersion?: ReadPackageVersion;
  cwd?: string;
  spawn?: JobRuntimeOptions['spawn'];
  now?: JobRuntimeOptions['now'];
  jobId?: JobRuntimeOptions['jobId'];
  sleep?: JobRuntimeOptions['sleep'];
}

async function defaultReadPackageVersion(): Promise<string> {
  // @ts-expect-error The Phase 1 runner is plain ESM JavaScript.
  const runner = await import('../../lib/runner.mjs');
  return String(runner.readPackageVersion());
}

function defaultCreateBackend(options: { env: NodeJS.ProcessEnv; cwd: string; runForwarder: RunForwarder }): ShellBackend {
  return selectBackend(options);
}

async function defaultRunForwarder(argv: string[]): Promise<number> {
  // @ts-expect-error The Phase 1 runner is plain ESM JavaScript.
  const runner = await import('../../lib/runner.mjs');
  return Number(await runner.runForwarder(argv));
}

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

async function resolvePackageVersion(options: CliShellOptions): Promise<string> {
  if (options.packageVersion) {
    return options.packageVersion;
  }
  if (options.readPackageVersion) {
    return String(await options.readPackageVersion());
  }
  return defaultReadPackageVersion();
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function eventOutputFormat(argv: string[]): 'jsonl' | 'human' {
  return readOptionValue(argv, '--output') === 'human' ? 'human' : 'jsonl';
}

async function runForegroundPipeline(argv: string[], backend: ShellBackend, io: CliIo, cwd: string): Promise<number | undefined> {
  if (argv[0] !== 'run' || hasFlag(argv, '--detach') || backend.kind !== 'node' || typeof backend.run !== 'function') {
    return undefined;
  }
  const output = eventOutputFormat(argv);
  for await (const event of backend.run({
    projectRoot: resolveProjectRoot(argv, cwd),
    skipDeploy: hasFlag(argv, '--skip-deploy'),
    skipVerify: hasFlag(argv, '--skip-verify'),
    resumeLatest: hasFlag(argv, '--resume-latest'),
    output
  })) {
    if (output === 'human') {
      if (event.type === 'log' && typeof event.message === 'string') {
        io.writeStdout(`${event.message}\n`);
      } else if (event.type === 'stage') {
        io.writeStdout(`[${String(event.stage ?? '')}] ${String(event.status ?? '')}\n`);
      } else if (event.type === 'summary') {
        io.writeStdout(`summary: ${String(event.run_status ?? '')} ${String(event.artifact_dir ?? '')}\n`);
      }
      continue;
    }
    io.writeStdout(`${JSON.stringify(event)}\n`);
  }
  return 0;
}

export async function runCliShell(argv: string[], options: CliShellOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo();
  const runForwarder = options.runForwarder ?? defaultRunForwarder;
  const cwd = options.cwd ?? process.cwd();

  if (env.AUTOVPN_CLI_SHELL === 'python') {
    return runForwarder(argv);
  }

  if (isEnabled(env.AUTOVPN_WRAPPER_PROBE) && argv.length === 1 && argv[0] === '--version') {
    return 42;
  }

  if (argv[0] === '--help' || argv[0] === '-h') {
    io.writeStdout(renderHelp());
    return 0;
  }

  if (argv[0] === '--version') {
    io.writeStdout(`autovpn ${await resolvePackageVersion(options)}\n`);
    return 0;
  }

  try {
    const normalizedArgv = normalizeProjectRootArgs(argv, cwd);
    validateCommand(normalizedArgv);
    const createBackend = options.createBackend ?? defaultCreateBackend;
    const backend = createBackend({ env, cwd, runForwarder });
    const nativeResult = await runNativeCommand(normalizedArgv, {
      cwd,
      env,
      io,
      pythonFallback: (fallbackArgv) => backend.executeCli(fallbackArgv),
      spawn: options.spawn,
      now: options.now,
      jobId: options.jobId,
      sleep: options.sleep
    });
    if (nativeResult !== undefined) {
      return nativeResult;
    }
    const foregroundResult = await runForegroundPipeline(normalizedArgv, backend, io, cwd);
    if (foregroundResult !== undefined) {
      return foregroundResult;
    }
    return await backend.executeCli(normalizedArgv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.writeStderr(`autovpn: ${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.writeStderr(`autovpn npm wrapper error: ${message}\n`);
    return 1;
  }
}
