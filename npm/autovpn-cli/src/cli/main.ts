import { validateCommand } from './commands/index.js';
import { CliUsageError } from './errors.js';
import { normalizeProjectRootArgs } from './global-options.js';
import { JobRuntimeOptions, runNativeCommand } from './native-commands.js';
import { CliIo, defaultIo, renderHelp } from './output.js';
import { AutoVpnBackend, RunForwarder } from '../backend/types.js';
import { selectBackend } from '../backend/select-backend.js';
import { readOptionValue, resolveProjectRoot } from '../runtime/paths.js';
import { redactText } from '../runtime/redaction.js';

type ReadPackageVersion = () => string | Promise<string>;
type ShellBackend = Pick<AutoVpnBackend, 'executeCli'> & Partial<Pick<AutoVpnBackend, 'kind' | 'run' | 'retryStage' | 'resume'>>;
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

async function defaultRunForwarder(argv: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<number> {
  // @ts-expect-error The Phase 1 runner is plain ESM JavaScript.
  const runner = await import('../../lib/runner.mjs');
  return Number(await runner.runForwarder(argv, options));
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
  if (backend.kind !== 'node') {
    return undefined;
  }
  const output = eventOutputFormat(argv);
  let events: AsyncIterable<unknown> | undefined;
  if (argv[0] === 'run' && !hasFlag(argv, '--detach') && typeof backend.run === 'function') {
    events = backend.run({
      projectRoot: resolveProjectRoot(argv, cwd),
      skipDeploy: hasFlag(argv, '--skip-deploy'),
      skipVerify: hasFlag(argv, '--skip-verify'),
      resumeLatest: hasFlag(argv, '--resume-latest'),
      output,
      eventLog: readOptionValue(argv, '--event-log'),
      humanLog: readOptionValue(argv, '--human-log')
    });
  } else if (argv[0] === 'retry-stage' && typeof backend.retryStage === 'function') {
    events = backend.retryStage({
      projectRoot: resolveProjectRoot(argv, cwd),
      artifactDir: readOptionValue(argv, '--artifact-dir') ?? '',
      stage: readOptionValue(argv, '--stage') ?? '',
      output,
      eventLog: readOptionValue(argv, '--event-log'),
      humanLog: readOptionValue(argv, '--human-log')
    });
  } else if (argv[0] === 'resume' && typeof backend.resume === 'function') {
    events = backend.resume({
      projectRoot: resolveProjectRoot(argv, cwd),
      mode: argv[1] === 'speedtest' ? 'speedtest' : 'pipeline',
      session: readOptionValue(argv, '--session') ?? '',
      output,
      eventLog: readOptionValue(argv, '--event-log'),
      humanLog: readOptionValue(argv, '--human-log')
    });
  }
  if (!events) {
    return undefined;
  }
  for await (const event of events) {
    const backendEvent = event as Record<string, unknown>;
    if (output === 'human') {
      if (backendEvent.type === 'log' && typeof backendEvent.message === 'string') {
        io.writeStdout(`${backendEvent.message}\n`);
      } else if (backendEvent.type === 'stage') {
        io.writeStdout(`[${String(backendEvent.stage ?? '')}] ${String(backendEvent.status ?? '')}\n`);
      } else if (backendEvent.type === 'summary') {
        io.writeStdout(`summary: ${String(backendEvent.run_status ?? '')} ${String(backendEvent.artifact_dir ?? '')}\n`);
      }
      continue;
    }
    io.writeStdout(`${JSON.stringify(backendEvent)}\n`);
  }
  return 0;
}

export async function runCliShell(argv: string[], options: CliShellOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo();
  const runForwarder = options.runForwarder ?? defaultRunForwarder;
  const cwd = options.cwd ?? process.cwd();

  if (env.AUTOVPN_CLI_SHELL === 'python') {
    return runForwarder(argv, { env, cwd });
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
    const message = redactText(error instanceof Error ? error.message : String(error));
    io.writeStderr(`autovpn npm wrapper error: ${message}\n`);
    return 1;
  }
}
