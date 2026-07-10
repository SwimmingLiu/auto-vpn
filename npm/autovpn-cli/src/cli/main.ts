import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCommand } from './commands/index.js';
import { CliUsageError } from './errors.js';
import { normalizeProjectRootArgs } from './global-options.js';
import { JobRuntimeOptions, runNativeCommand } from './native-commands.js';
import { CliIo, defaultIo, renderHelp } from './output.js';
import { AutoVpnBackend } from '../backend/types.js';
import { selectBackend } from '../backend/select-backend.js';
import { loadJob } from '../jobs/read.js';
import { readOptionValue, resolveProjectRoot } from '../runtime/paths.js';
import { redactText } from '../runtime/redaction.js';
import { createAutoVpnServer } from '../server/http.js';
import { parseServeOptions } from '../server/options.js';
import { createServerRuntime } from '../server/runtime.js';

type ReadPackageVersion = () => string | Promise<string>;
type ReadStdin = () => string | Promise<string>;
type ShellBackend = Pick<AutoVpnBackend, 'executeCli'> & Partial<Pick<AutoVpnBackend, 'kind' | 'run' | 'retryStage' | 'resume'>>;
type CreateBackend = (options: { env: NodeJS.ProcessEnv; cwd: string }) => ShellBackend;
type CreateServer = typeof createAutoVpnServer;

export interface CliShellOptions {
  packageVersion?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  createBackend?: CreateBackend;
  readPackageVersion?: ReadPackageVersion;
  readStdin?: ReadStdin;
  cwd?: string;
  spawn?: JobRuntimeOptions['spawn'];
  now?: JobRuntimeOptions['now'];
  jobId?: JobRuntimeOptions['jobId'];
  jobToken?: JobRuntimeOptions['jobToken'];
  sleep?: JobRuntimeOptions['sleep'];
  createServer?: CreateServer;
  serveExitAfterStart?: boolean;
}

async function defaultReadPackageVersion(): Promise<string> {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  const manifest = JSON.parse(await fs.promises.readFile(packagePath, 'utf8')) as { version?: unknown };
  return String(manifest.version ?? '');
}

function defaultCreateBackend(options: { env: NodeJS.ProcessEnv; cwd: string }): ShellBackend {
  return selectBackend(options);
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
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

function hasProxyFlag(argv: string[]): boolean {
  return argv.some((value) => value === '--proxy' || value.startsWith('--proxy='));
}

function isPipelineProxyCommand(argv: string[]): boolean {
  if (!hasProxyFlag(argv)) {
    return false;
  }
  return argv[0] === 'run' || (argv[0] === 'resume' && argv[1] === 'pipeline');
}

function eventOutputFormat(argv: string[]): 'jsonl' | 'human' {
  return readOptionValue(argv, '--output') === 'human' ? 'human' : 'jsonl';
}

function positionalAfter(argv: string[], start: number): string {
  for (let index = start; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--project-root' || value === '--format' || value === '--tail' || value === '--output' || value === '--artifact-dir' || value === '--stage') {
      index += 1;
      continue;
    }
    if (value.startsWith('--')) {
      continue;
    }
    return value;
  }
  return '';
}

function resolveResumeSessionDir(job: Record<string, any>): string {
  const candidates = [
    String(job.resume_from ?? ''),
    String((job.options ?? {}).session_dir ?? ''),
    String(job.session_dir ?? '')
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'session.json'))) {
      return candidate;
    }
  }
  return '';
}

async function waitForServeShutdown(server: { close(): Promise<void> }): Promise<void> {
  let closing: Promise<void> | undefined;
  const closeOnce = () => {
    closing ??= server.close();
    return closing;
  };
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void closeOnce().finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
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
  } else if (argv[0] === 'jobs' && argv[1] === 'retry' && !hasFlag(argv, '--detach') && typeof backend.retryStage === 'function') {
    events = backend.retryStage({
      projectRoot: resolveProjectRoot(argv, cwd),
      artifactDir: path.resolve(cwd, readOptionValue(argv, '--artifact-dir') ?? ''),
      stage: readOptionValue(argv, '--stage') ?? '',
      output
    });
  } else if (argv[0] === 'jobs' && argv[1] === 'resume' && !hasFlag(argv, '--detach')) {
    const projectRoot = resolveProjectRoot(argv, cwd);
    const sourceJob = loadJob(projectRoot, positionalAfter(argv, 2));
    const sessionDir = resolveResumeSessionDir(sourceJob);
    if (!sessionDir && String(sourceJob.kind ?? '') === 'run' && typeof backend.run === 'function') {
      const sourceOptions = sourceJob.options ?? {};
      events = backend.run({
        projectRoot,
        resumeLatest: true,
        skipDeploy: Boolean(sourceOptions.skip_deploy),
        skipVerify: Boolean(sourceOptions.skip_verify),
        output
      });
    } else if (sessionDir && typeof backend.resume === 'function') {
      events = backend.resume({
        projectRoot,
        mode: 'pipeline',
        session: sessionDir,
        output
      });
    } else if (!sessionDir) {
      throw new Error('cannot resume job without session.json');
    }
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
  const cwd = options.cwd ?? process.cwd();

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
    const backend = createBackend({ env, cwd });
    if (normalizedArgv[0] === 'serve') {
      const serveOptions = parseServeOptions(normalizedArgv, { cwd, env });
      const serverFactory = options.createServer ?? createAutoVpnServer;
      const runtime = createServerRuntime({
        projectRoot: serveOptions.projectRoot,
        env,
        proxy: serveOptions.proxy
      });
      const server = await serverFactory({
        ...serveOptions,
        runtime,
        version: await resolvePackageVersion(options),
        backendKind: String(backend.kind ?? '')
      });
      io.writeStdout(`AutoVPN server listening on ${server.origin}\n`);
      if (serveOptions.auth.enabled) {
        if (serveOptions.auth.password) {
          io.writeStdout(`Open ${server.origin}/\n`);
          io.writeStdout(`Password: ${serveOptions.auth.password}\n`);
        } else {
          io.writeStdout(`Open ${server.origin}/?token=${encodeURIComponent(serveOptions.auth.token)}\n`);
        }
      } else {
        io.writeStderr('autovpn: warning: server authentication is disabled\n');
      }
      if (options.serveExitAfterStart) {
        await server.close();
        return 0;
      }
      await waitForServeShutdown(server);
      return 0;
    }
    if (isPipelineProxyCommand(normalizedArgv)) {
      throw new Error('--proxy is handled by serve and Node runtime proxy settings');
    }
    const nativeResult = await runNativeCommand(normalizedArgv, {
      cwd,
      env,
      io,
      readStdin: options.readStdin ?? defaultReadStdin,
      spawn: options.spawn,
      now: options.now,
      jobId: options.jobId,
      jobToken: options.jobToken,
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
