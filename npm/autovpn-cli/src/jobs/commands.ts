import fs from 'node:fs';
import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { publicJobPayload } from './read.js';
import { createJobStore, JobRecord, JobStoreOptions } from './store.js';
import { StopProcessOptions, processMatchesJob as defaultProcessMatchesJob, terminateProcessGroup } from './process.js';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

interface ResolvedWorkerCli {
  command: string;
  args: string[];
}

export interface JobCommandOptions extends JobStoreOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  resolvePythonCli?: () => ResolvedPythonCli | Promise<ResolvedPythonCli>;
  processMatchesJob?: (pid: number, command: string[]) => boolean;
}

export interface DetachedRunCommand {
  projectRoot: string;
  resumeLatest?: boolean;
  skipDeploy?: boolean;
  skipVerify?: boolean;
  outputFormat?: 'jsonl' | 'human';
  sourceJobId?: string;
}

export interface DetachedResumeCommand {
  projectRoot: string;
  sourceJobId: string;
  sessionDir: string;
  outputFormat?: 'jsonl' | 'human';
}

export interface DetachedRetryCommand {
  projectRoot: string;
  artifactDir: string;
  stage: string;
  outputFormat?: 'jsonl' | 'human';
}

async function defaultResolvePythonCli(env: NodeJS.ProcessEnv): Promise<ResolvedPythonCli> {
  // @ts-expect-error Phase 1 runner remains plain ESM JavaScript.
  const runner = await import('../../lib/runner.mjs');
  return runner.resolveOrInstallPythonCli({ env });
}

function defaultResolveNodeCli(): ResolvedWorkerCli {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return { command: process.execPath, args: [path.join(packageRoot, 'bin', 'autovpn.mjs')] };
}

function wantsNodeWorker(env: NodeJS.ProcessEnv, command: DetachedRunCommand): boolean {
  return String(env.AUTOVPN_BACKEND ?? '').trim().toLowerCase() === 'node' && !command.resumeLatest;
}

async function resolveDetachedRunWorker(command: DetachedRunCommand, env: NodeJS.ProcessEnv, options: JobCommandOptions): Promise<ResolvedWorkerCli> {
  if (wantsNodeWorker(env, command)) {
    return defaultResolveNodeCli();
  }
  return options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(env);
}

function pushFlag(argv: string[], enabled: boolean | undefined, flag: string): void {
  if (enabled) argv.push(flag);
}

function spawnDetached(command: string, args: string[], job: JobRecord, options: JobCommandOptions): ChildProcess {
  const stdoutFd = fs.openSync(String(job.stdout_log), 'a');
  const stderrFd = fs.openSync(String(job.stderr_log), 'a');
  try {
    const child = (options.spawn ?? defaultSpawn)(command, args, {
      cwd: options.cwd ?? job.project_root,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', stdoutFd, stderrFd]
    });
    child.unref?.();
    return child;
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

export async function startDetachedRun(command: DetachedRunCommand, options: JobCommandOptions = {}): Promise<JobRecord> {
  const outputFormat = command.outputFormat ?? 'jsonl';
  const jobStore = createJobStore(command.projectRoot, options);
  const runArgs = ['run', '--project-root', command.projectRoot, '--output', outputFormat];
  const resolved = await resolveDetachedRunWorker(command, options.env ?? process.env, options);
  const job = jobStore.createRunningJob({
    kind: 'run',
    command: [],
    pid: 0,
    options: {
      source_job_id: command.sourceJobId ?? '',
      resume_latest: Boolean(command.resumeLatest),
      skip_deploy: Boolean(command.skipDeploy),
      skip_verify: Boolean(command.skipVerify),
      output_format: outputFormat
    }
  });
  runArgs.push('--event-log', String(job.event_log), '--human-log', String(job.human_log));
  pushFlag(runArgs, command.resumeLatest, '--resume-latest');
  pushFlag(runArgs, command.skipDeploy, '--skip-deploy');
  pushFlag(runArgs, command.skipVerify, '--skip-verify');
  job.command = [resolved.command, ...resolved.args, ...runArgs];
  const child = spawnDetached(resolved.command, [...resolved.args, ...runArgs], job, options);
  job.pid = Number(child.pid ?? 0);
  job.pgid = Number(child.pid ?? 0);
  return jobStore.writeJob(job);
}

export async function startDetachedResume(command: DetachedResumeCommand, options: JobCommandOptions = {}): Promise<JobRecord> {
  const outputFormat = command.outputFormat ?? 'jsonl';
  const jobStore = createJobStore(command.projectRoot, options);
  const resolved = options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(options.env ?? process.env);
  const job = jobStore.createRunningJob({
    kind: 'resume',
    command: [],
    pid: 0,
    options: { source_job_id: command.sourceJobId, session_dir: command.sessionDir, output_format: outputFormat },
    resumeFrom: command.sessionDir
  });
  const pythonArgs = [
    'resume',
    'pipeline',
    '--project-root',
    command.projectRoot,
    '--session',
    command.sessionDir,
    '--output',
    outputFormat,
    '--event-log',
    String(job.event_log),
    '--human-log',
    String(job.human_log)
  ];
  job.command = [resolved.command, ...resolved.args, ...pythonArgs];
  const child = spawnDetached(resolved.command, [...resolved.args, ...pythonArgs], job, options);
  job.pid = Number(child.pid ?? 0);
  job.pgid = Number(child.pid ?? 0);
  return jobStore.writeJob(job);
}

export async function startDetachedRetry(command: DetachedRetryCommand, options: JobCommandOptions = {}): Promise<JobRecord> {
  const outputFormat = command.outputFormat ?? 'jsonl';
  const jobStore = createJobStore(command.projectRoot, options);
  const resolved = options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(options.env ?? process.env);
  const retry = { source_artifact_dir: command.artifactDir, stage: command.stage };
  const job = jobStore.createRunningJob({
    kind: 'retry',
    command: [],
    pid: 0,
    options: { artifact_dir: command.artifactDir, stage: command.stage, output_format: outputFormat },
    retry
  });
  const pythonArgs = [
    'retry-stage',
    '--project-root',
    command.projectRoot,
    '--artifact-dir',
    command.artifactDir,
    '--stage',
    command.stage,
    '--output',
    outputFormat,
    '--event-log',
    String(job.event_log),
    '--human-log',
    String(job.human_log)
  ];
  job.command = [resolved.command, ...resolved.args, ...pythonArgs];
  const child = spawnDetached(resolved.command, [...resolved.args, ...pythonArgs], job, options);
  job.pid = Number(child.pid ?? 0);
  job.pgid = Number(child.pid ?? 0);
  return jobStore.writeJob(job);
}

export async function stopManagedJob(projectRoot: string, jobId: string, options: JobStoreOptions & StopProcessOptions = {}): Promise<JobRecord> {
  const store = createJobStore(projectRoot, options);
  const job = store.loadJob(jobId);
  job.status = 'stopping';
  job.stop_requested_at = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  store.writeJob(job);
  const pid = Number(job.pgid || job.pid || 0);
  const matcher = (options as JobCommandOptions).processMatchesJob ?? defaultProcessMatchesJob;
  if (pid > 0 && !matcher(pid, Array.isArray(job.command) ? job.command.map(String) : [])) {
    throw new Error(`refusing to stop pid ${pid}: command does not match AutoVPN job`);
  }
  await terminateProcessGroup(pid, options);
  job.status = 'stopped';
  job.finished_at = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  job.exit_code = 1;
  job.signal = 'SIGTERM';
  return store.writeJob(job);
}

export function publicStartedPayload(job: JobRecord): Record<string, unknown> {
  return { ok: true, ...publicJobPayload(job) };
}
