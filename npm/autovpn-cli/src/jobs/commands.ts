import fs from 'node:fs';
import path from 'node:path';
import { RunStore, readRunStatus } from '../pipeline/run-store.js';
import { randomBytes } from 'node:crypto';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { publicJobPayload } from './read.js';
import { createJobStore, JobRecord, JobStoreOptions } from './store.js';
import { StopProcessOptions, processMatchesJob as defaultProcessMatchesJob, terminateProcessGroup } from './process.js';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

interface ResolvedWorkerCli {
  command: string;
  args: string[];
}

export interface JobCommandOptions extends JobStoreOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  processMatchesJob?: (pid: number, command: string[]) => boolean;
  jobToken?: () => string;
}

export interface DetachedRunCommand {
  projectRoot: string;
  resumeLatest?: boolean;
  skipDeploy?: boolean;
  skipVerify?: boolean;
  useProxy?: boolean;
  proxyUrl?: string;
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

function defaultResolveNodeCli(): ResolvedWorkerCli {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return { command: process.execPath, args: [path.join(packageRoot, 'bin', 'autovpn.mjs')] };
}

async function resolveDetachedWorker(_env: NodeJS.ProcessEnv, _options: JobCommandOptions): Promise<ResolvedWorkerCli> {
  return defaultResolveNodeCli();
}

function pushFlag(argv: string[], enabled: boolean | undefined, flag: string): void {
  if (enabled) argv.push(flag);
}

function createJobToken(options: JobCommandOptions): string {
  const token = options.jobToken?.() ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error('internal job token must be 64 hexadecimal characters');
  }
  return token.toLowerCase();
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

function markArtifactStopped(job: JobRecord): string | undefined {
  const artifactDir = String(job.artifact_dir ?? '');
  if (!artifactDir) {
    return undefined;
  }
  const reportPath = path.join(artifactDir, 'pipeline_report.json');
  const dbPath = path.join(artifactDir, 'run.db');
  let authoritativeStatus: string | undefined;
  if (fs.existsSync(dbPath)) {
    let runStore: RunStore | undefined;
    try {
      runStore = RunStore.open(dbPath);
      if (!runStore.stopForResume('Stopped by user')) authoritativeStatus = readRunStatus(dbPath);
    } catch {
      // The compatibility report remains the fallback when SQLite is corrupt or locked.
    } finally {
      try { runStore?.close(); } catch { /* best effort */ }
    }
  }
  if (authoritativeStatus) {
    if (fs.existsSync(reportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
        report.run_status = authoritativeStatus;
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      } catch { /* SQLite remains authoritative */ }
    }
    return authoritativeStatus;
  }
  if (!fs.existsSync(reportPath)) return 'stopped';
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, any>;
    const stageStatus = { ...((report.stage_status ?? {}) as Record<string, unknown>) };
    for (const [stage, status] of Object.entries(stageStatus)) {
      if (status === 'running') {
        stageStatus[stage] = 'stopped';
      }
    }
    report.stage_status = stageStatus;
    report.run_status = 'stopped';
    report.error = report.error || 'Stopped by user';
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort cleanup so stopping a job never fails because its report is corrupt.
  }
  return 'stopped';
}

export async function startDetachedRun(command: DetachedRunCommand, options: JobCommandOptions = {}): Promise<JobRecord> {
  const outputFormat = command.outputFormat ?? 'jsonl';
  const jobStore = createJobStore(command.projectRoot, options);
  const runArgs = ['run', '--project-root', command.projectRoot, '--output', outputFormat];
  const resolved = await resolveDetachedWorker(options.env ?? process.env, options);
  const job = jobStore.createRunningJob({
    kind: 'run',
    command: [],
    pid: 0,
    options: {
      source_job_id: command.sourceJobId ?? '',
      resume_latest: Boolean(command.resumeLatest),
      skip_deploy: Boolean(command.skipDeploy),
      skip_verify: Boolean(command.skipVerify),
      use_proxy: Boolean(command.useProxy),
      proxy_url: command.proxyUrl ?? '',
      output_format: outputFormat
    }
  });
  runArgs.push('--internal-job-token', createJobToken(options));
  runArgs.push('--event-log', String(job.event_log), '--human-log', String(job.human_log));
  pushFlag(runArgs, command.resumeLatest, '--resume-latest');
  pushFlag(runArgs, command.skipDeploy, '--skip-deploy');
  pushFlag(runArgs, command.skipVerify, '--skip-verify');
  if (command.useProxy) {
    runArgs.push('--proxy');
    if (command.proxyUrl) {
      runArgs.push(command.proxyUrl);
    }
  }
  job.command = [resolved.command, ...resolved.args, ...runArgs];
  const child = spawnDetached(resolved.command, [...resolved.args, ...runArgs], job, options);
  job.pid = Number(child.pid ?? 0);
  job.pgid = Number(child.pid ?? 0);
  return jobStore.writeJob(job);
}

export async function startDetachedResume(command: DetachedResumeCommand, options: JobCommandOptions = {}): Promise<JobRecord> {
  const outputFormat = command.outputFormat ?? 'jsonl';
  const jobStore = createJobStore(command.projectRoot, options);
  const resolved = await resolveDetachedWorker(options.env ?? process.env, options);
  const job = jobStore.createRunningJob({
    kind: 'resume',
    command: [],
    pid: 0,
    options: { source_job_id: command.sourceJobId, session_dir: command.sessionDir, output_format: outputFormat },
    resumeFrom: command.sessionDir
  });
  const resumeArgs = [
    'resume',
    'pipeline',
    '--project-root',
    command.projectRoot,
    '--session',
    command.sessionDir,
    '--output',
    outputFormat,
    '--internal-job-token',
    createJobToken(options),
    '--event-log',
    String(job.event_log),
    '--human-log',
    String(job.human_log)
  ];
  job.command = [resolved.command, ...resolved.args, ...resumeArgs];
  const child = spawnDetached(resolved.command, [...resolved.args, ...resumeArgs], job, options);
  job.pid = Number(child.pid ?? 0);
  job.pgid = Number(child.pid ?? 0);
  return jobStore.writeJob(job);
}

export async function startDetachedRetry(command: DetachedRetryCommand, options: JobCommandOptions = {}): Promise<JobRecord> {
  const outputFormat = command.outputFormat ?? 'jsonl';
  const jobStore = createJobStore(command.projectRoot, options);
  const resolved = await resolveDetachedWorker(options.env ?? process.env, options);
  const retry = { source_artifact_dir: command.artifactDir, stage: command.stage };
  const job = jobStore.createRunningJob({
    kind: 'retry',
    command: [],
    pid: 0,
    options: { artifact_dir: command.artifactDir, stage: command.stage, output_format: outputFormat },
    retry
  });
  const retryArgs = [
    'retry-stage',
    '--project-root',
    command.projectRoot,
    '--artifact-dir',
    command.artifactDir,
    '--stage',
    command.stage,
    '--output',
    outputFormat,
    '--internal-job-token',
    createJobToken(options),
    '--event-log',
    String(job.event_log),
    '--human-log',
    String(job.human_log)
  ];
  job.command = [resolved.command, ...resolved.args, ...retryArgs];
  const child = spawnDetached(resolved.command, [...resolved.args, ...retryArgs], job, options);
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
  const artifactStatus = markArtifactStopped(job);
  job.status = artifactStatus === 'success' || artifactStatus === 'failed' ? artifactStatus : 'stopped';
  job.finished_at = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  job.exit_code = job.status === 'success' ? 0 : 1;
  job.signal = 'SIGTERM';
  return store.writeJob(job);
}

export function publicStartedPayload(job: JobRecord): Record<string, unknown> {
  return { ok: true, ...publicJobPayload(job) };
}
