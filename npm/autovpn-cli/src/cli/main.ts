import { validateCommand } from './commands/index.js';
import { CliUsageError } from './errors.js';
import { normalizeProjectRootArgs } from './global-options.js';
import { CliIo, defaultIo, renderHelp } from './output.js';

type RunForwarder = (argv: string[]) => Promise<number>;
type ReadPackageVersion = () => string | Promise<string>;

export interface CliShellOptions {
  packageVersion?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  runForwarder?: RunForwarder;
  readPackageVersion?: ReadPackageVersion;
  cwd?: string;
}

async function defaultReadPackageVersion(): Promise<string> {
  // @ts-expect-error The Phase 1 runner is plain ESM JavaScript.
  const runner = await import('../../lib/runner.mjs');
  return String(runner.readPackageVersion());
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

export async function runCliShell(argv: string[], options: CliShellOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo();
  const runForwarder = options.runForwarder ?? defaultRunForwarder;

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
    const normalizedArgv = normalizeProjectRootArgs(argv, options.cwd ?? process.cwd());
    validateCommand(normalizedArgv);
    return await runForwarder(normalizedArgv);
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
