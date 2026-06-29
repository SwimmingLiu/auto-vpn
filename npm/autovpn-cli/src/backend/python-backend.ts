import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { parseEventLine, AutoVpnEvent } from '../events/schema.js';
import { mergeProjectEnv } from '../runtime/env.js';
import {
  AutoVpnBackend,
  DetachedRunOptions,
  JobSummary,
  LogOptions,
  ResumeOptions,
  RetryOptions,
  RunForwarder,
  RunOptions
} from './types.js';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess | EventEmitter & {
  stdout?: EventEmitter;
  stderr?: EventEmitter;
};

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

export interface PythonBackendOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runForwarder?: RunForwarder;
  resolvePythonCli?: () => ResolvedPythonCli;
  spawn?: SpawnLike;
}

function pushOption(argv: string[], name: string, value: string | number | undefined): void {
  if (value !== undefined && value !== '') {
    argv.push(name, String(value));
  }
}

function runArgs(options: RunOptions): string[] {
  const argv = ['run', '--project-root', options.projectRoot, '--output', options.output ?? 'jsonl'];
  if (options.resumeLatest) argv.push('--resume-latest');
  if (options.skipDeploy) argv.push('--skip-deploy');
  if (options.skipVerify) argv.push('--skip-verify');
  pushOption(argv, '--event-log', options.eventLog);
  pushOption(argv, '--human-log', options.humanLog);
  return argv;
}

function retryArgs(options: RetryOptions): string[] {
  const argv = [
    'retry-stage',
    '--project-root',
    options.projectRoot,
    '--artifact-dir',
    options.artifactDir,
    '--stage',
    options.stage,
    '--output',
    options.output ?? 'jsonl'
  ];
  pushOption(argv, '--event-log', options.eventLog);
  pushOption(argv, '--human-log', options.humanLog);
  return argv;
}

function resumeArgs(options: ResumeOptions): string[] {
  const argv = [
    'resume',
    options.mode,
    '--project-root',
    options.projectRoot,
    '--session',
    options.session,
    '--output',
    options.output ?? 'jsonl'
  ];
  pushOption(argv, '--event-log', options.eventLog);
  pushOption(argv, '--human-log', options.humanLog);
  return argv;
}

async function* splitLines(stream: EventEmitter): AsyncIterable<string> {
  const queue: string[] = [];
  let ended = false;
  let pendingResolve: (() => void) | undefined;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += String(chunk);
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    queue.push(...parts.filter((line) => line.trim()));
    pendingResolve?.();
    pendingResolve = undefined;
  });
  stream.on('end', () => {
    if (buffer.trim()) queue.push(buffer);
    ended = true;
    pendingResolve?.();
    pendingResolve = undefined;
  });
  while (!ended || queue.length) {
    if (!queue.length) {
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
      continue;
    }
    yield queue.shift() as string;
  }
}

function waitForClose(child: EventEmitter): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code: number | null, signal: string | null) => {
      resolve({ code, signal });
    });
  });
}

function errorSummary(stderr: string): string {
  const summary = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
  return summary ? `: ${summary}` : '';
}

function parseJsonPayload(stdout: string): JobSummary {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim());
  if (!line) {
    throw new Error('Python backend returned empty JSON payload');
  }
  const payload = JSON.parse(line) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Python backend JSON payload must be an object');
  }
  return payload as JobSummary;
}

function projectRootFromArgv(argv: string[]): string | undefined {
  const index = argv.indexOf('--project-root');
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  return undefined;
}

export class PythonBackend implements AutoVpnBackend {
  readonly kind = 'python' as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly runForwarder?: RunForwarder;
  private readonly resolvePythonCli?: () => ResolvedPythonCli;
  private readonly spawn: SpawnLike;

  constructor(options: PythonBackendOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.runForwarder = options.runForwarder;
    this.resolvePythonCli = options.resolvePythonCli;
    this.spawn = options.spawn ?? defaultSpawn;
  }

  async executeCli(argv: string[]): Promise<number> {
    if (this.runForwarder) {
      return this.runForwarder(argv);
    }
    // @ts-expect-error Phase 1 runner remains plain ESM JavaScript.
    const runner = await import('../../lib/runner.mjs');
    return Number(await runner.runForwarder(argv, { env: this.env, cwd: this.cwd }));
  }

  run(options: RunOptions): AsyncIterable<AutoVpnEvent> {
    return this.streamEvents(runArgs(options));
  }

  retryStage(options: RetryOptions): AsyncIterable<AutoVpnEvent> {
    return this.streamEvents(retryArgs(options));
  }

  resume(options: ResumeOptions): AsyncIterable<AutoVpnEvent> {
    return this.streamEvents(resumeArgs(options));
  }

  async startDetached(options: DetachedRunOptions): Promise<JobSummary> {
    const argv = runArgs(options);
    argv.push('--detach');
    argv.push('--json');
    return this.captureJson(argv);
  }

  async stopJob(jobId: string, options: { projectRoot?: string; timeout?: number } = {}): Promise<JobSummary> {
    const argv = jobId === 'latest'
      ? ['stop']
      : ['jobs', 'stop', jobId];
    pushOption(argv, '--project-root', options.projectRoot);
    pushOption(argv, '--timeout', options.timeout);
    return this.captureJson(argv);
  }

  async readJob(jobId: string, options: { projectRoot?: string } = {}): Promise<JobSummary> {
    const argv = jobId === 'latest'
      ? ['status', '--json']
      : ['jobs', 'status', jobId, '--json'];
    pushOption(argv, '--project-root', options.projectRoot);
    return this.captureJson(argv);
  }

  async *readLogs(options: LogOptions): AsyncIterable<string> {
    const argv = options.jobId
      ? ['jobs', 'logs', options.jobId, '--project-root', options.projectRoot]
      : ['logs', '--project-root', options.projectRoot];
    if (options.format) argv.push('--format', options.format);
    pushOption(argv, '--tail', options.tail);
    if (options.follow) argv.push('--follow');
    yield* this.streamLines(argv);
  }

  private async *streamEvents(argv: string[]): AsyncIterable<AutoVpnEvent> {
    for await (const line of this.streamLines(argv)) {
      yield parseEventLine(line);
    }
  }

  private async *streamLines(argv: string[]): AsyncIterable<string> {
    const projectRoot = projectRootFromArgv(argv);
    const env = projectRoot ? mergeProjectEnv(projectRoot, this.env) : this.env;
    const resolved = this.resolvePythonCli ? this.resolvePythonCli() : await this.defaultResolvePythonCli(env);
    const child = this.spawn(resolved.command, [...resolved.args, ...argv], {
      cwd: this.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const closePromise = waitForClose(child);
    const stdout = child.stdout;
    if (!stdout) {
      throw new Error('Python backend did not expose stdout for event streaming');
    }
    for await (const line of splitLines(stdout)) {
      yield line;
    }
    const { code, signal } = await closePromise;
    if (code !== 0) {
      throw new Error(`Python backend exited with ${signal ? `signal ${signal}` : `code ${code}`}${errorSummary(stderr)}`);
    }
  }

  private async captureJson(argv: string[]): Promise<JobSummary> {
    const projectRoot = projectRootFromArgv(argv);
    const env = projectRoot ? mergeProjectEnv(projectRoot, this.env) : this.env;
    const resolved = this.resolvePythonCli ? this.resolvePythonCli() : await this.defaultResolvePythonCli(env);
    const child = this.spawn(resolved.command, [...resolved.args, ...argv], {
      cwd: this.cwd,
      env,
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
    const { code, signal } = await waitForClose(child);
    if (code !== 0) {
      throw new Error(`Python backend exited with ${signal ? `signal ${signal}` : `code ${code}`}${errorSummary(stderr)}`);
    }
    return parseJsonPayload(stdout);
  }

  private async defaultResolvePythonCli(env: NodeJS.ProcessEnv = this.env): Promise<ResolvedPythonCli> {
    // @ts-expect-error Phase 1 runner remains plain ESM JavaScript.
    const runner = await import('../../lib/runner.mjs');
    return runner.resolveOrInstallPythonCli({ env });
  }
}
