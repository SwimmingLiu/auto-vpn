import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { resolveProfilePath, readOptionValue } from '../runtime/paths.js';
import { redactText } from '../runtime/redaction.js';

function jobsRoot(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(resolveProfilePath(projectRoot, env)), 'jobs');
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function processAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lastJsonEvents(filePath: string): Array<Record<string, any>> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) {
      return [];
    }
    try {
      return [JSON.parse(line) as Record<string, any>];
    } catch {
      return [];
    }
  });
}

function reconcileFromPipelineReport(job: Record<string, any>): Record<string, any> | undefined {
  const artifactDir = String(job.artifact_dir ?? '');
  if (!artifactDir) {
    return undefined;
  }
  const reportPath = path.join(artifactDir, 'pipeline_report.json');
  if (!fs.existsSync(reportPath)) {
    return undefined;
  }
  try {
    const report = readJson(reportPath);
    const runStatus = String(report.run_status ?? '');
    if (!['success', 'failed', 'stopped'].includes(runStatus)) {
      return undefined;
    }
    const stageStatus = (report.stage_status ?? {}) as Record<string, unknown>;
    if (Object.values(stageStatus).some((status) => String(status) === 'running')) {
      return undefined;
    }
    return {
      status: runStatus,
      finished_at: job.finished_at || nowIso(),
      exit_code: runStatus === 'success' ? 0 : 1,
      last_error: redactText(String(report.error ?? job.last_error ?? ''))
    };
  } catch {
    return undefined;
  }
}

function reconcileFromRunDb(job: Record<string, any>): Record<string, any> | undefined {
  const artifactDir = String(job.artifact_dir ?? '');
  if (!artifactDir) {
    return undefined;
  }
  const runDbPath = path.join(artifactDir, 'run.db');
  if (!fs.existsSync(runDbPath)) {
    return undefined;
  }
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string) => any };
    const db = new sqlite.DatabaseSync(runDbPath);
    try {
      const row = db.prepare('SELECT status FROM runs ORDER BY run_id DESC LIMIT 1').get() as { status?: string } | undefined;
      const runStatus = String(row?.status ?? '');
      if (!['success', 'failed', 'stopped'].includes(runStatus)) {
        return undefined;
      }
      return {
        status: runStatus,
        finished_at: job.finished_at || nowIso(),
        exit_code: runStatus === 'success' ? 0 : 1
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function writeJob(job: Record<string, any>): void {
  const jobFile = String(job.job_file ?? '');
  if (!jobFile) {
    return;
  }
  job.updated_at = nowIso();
  fs.writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
}

function reconcileJob(job: Record<string, any>): Record<string, any> {
  const events = lastJsonEvents(String(job.event_log ?? ''));
  for (const event of events) {
    job.last_event_at = nowIso();
    if (event.type === 'run_started' && event.artifact_dir) {
      job.artifact_dir = String(event.artifact_dir);
    }
    if (event.type === 'summary') {
      job.artifact_dir = String(event.artifact_dir || job.artifact_dir || '');
      const runStatus = String(event.run_status || '');
      if (['success', 'failed', 'stopped'].includes(runStatus)) {
        job.status = runStatus;
        job.finished_at = job.finished_at || nowIso();
        job.exit_code = runStatus === 'success' ? 0 : 1;
      }
      if (event.error) {
        job.last_error = String(event.error);
      }
    }
    if (event.type === 'run_failed') {
      job.status = 'failed';
      job.last_error = redactText(String(event.error || 'run failed'));
      job.finished_at = job.finished_at || nowIso();
      job.exit_code = 1;
    }
  }

  if (['running', 'stopping'].includes(String(job.status ?? ''))) {
    const reportStatus = reconcileFromPipelineReport(job);
    if (reportStatus) {
      Object.assign(job, reportStatus);
    } else {
      const runDbStatus = reconcileFromRunDb(job);
      if (runDbStatus) {
        Object.assign(job, runDbStatus);
      }
    }
  }

  if (['running', 'stopping'].includes(String(job.status ?? '')) && !processAlive(Number(job.pid ?? 0))) {
    if (job.status === 'stopping') {
      job.status = 'stopped';
    } else if (!events.length) {
      job.status = 'failed';
      job.last_error = 'process exited without summary';
    } else {
      job.status = 'failed';
      job.last_error = job.last_error || 'process exited without terminal status';
    }
    job.finished_at = job.finished_at || nowIso();
    if (job.exit_code === null || job.exit_code === undefined) {
      job.exit_code = 1;
    }
  }

  writeJob(job);
  return job;
}

function loadIndex(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, any> {
  const indexPath = path.join(jobsRoot(projectRoot, env), 'index.json');
  if (!fs.existsSync(indexPath)) {
    return { schema_version: 1, latest_job_id: '', jobs: [] };
  }
  return readJson(indexPath);
}

export function latestJobId(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const jobId = String(loadIndex(projectRoot, env).latest_job_id ?? '');
  if (!jobId) {
    throw new Error('no jobs found');
  }
  return jobId;
}

export function activeJobIds(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const index = loadIndex(projectRoot, env);
  const active: string[] = [];
  for (const item of (index.jobs ?? []) as Array<Record<string, unknown>>) {
    try {
      const job = loadJob(projectRoot, String(item.job_id ?? ''), env);
      if (['running', 'stopping'].includes(String(job.status ?? '')) && processAlive(Number(job.pid ?? 0))) {
        active.push(String(job.job_id));
      }
    } catch {
      // Ignore stale index rows that no longer have job metadata.
    }
  }
  return active;
}

export function singleActiveJobId(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const active = activeJobIds(projectRoot, env);
  if (active.length > 1) {
    throw new Error(`multiple active jobs: ${active.join(', ')}`);
  }
  if (!active.length) {
    throw new Error('no active jobs');
  }
  return active[0];
}

export function loadJob(projectRoot: string, jobId: string, env: NodeJS.ProcessEnv = process.env): Record<string, any> {
  const jobPath = path.join(jobsRoot(projectRoot, env), jobId, 'job.json');
  if (!fs.existsSync(jobPath)) {
    throw new Error(`job not found: ${jobId}`);
  }
  return reconcileJob(readJson(jobPath));
}

export function publicJobPayload(job: Record<string, any>): Record<string, unknown> {
  const keys = [
    'job_id',
    'kind',
    'status',
    'pid',
    'pgid',
    'created_at',
    'started_at',
    'finished_at',
    'exit_code',
    'signal',
    'project_root',
    'event_log',
    'human_log',
    'stdout_log',
    'stderr_log',
    'artifact_dir',
    'session_dir',
    'options',
    'retry',
    'stop_requested_at',
    'last_event_at',
    'last_error',
    'job_file'
  ];
  const payload = Object.fromEntries(keys.map((key) => [key, job[key]]));
  if (payload.last_error) {
    payload.last_error = redactText(String(payload.last_error));
  }
  return payload;
}

export function listJobs(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const index = loadIndex(projectRoot, env);
  const jobs = ((index.jobs ?? []) as Array<Record<string, unknown>>)
    .map((item) => {
      try {
        const job = loadJob(projectRoot, String(item.job_id ?? ''), env);
        return {
          job_id: job.job_id,
          status: job.status,
          kind: job.kind,
          created_at: job.created_at,
          job_file: job.job_file
        };
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  return { ok: true, jobs, latest_job_id: index.latest_job_id ?? '' };
}

export function tailLog(projectRoot: string, jobId: string, argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const job = loadJob(projectRoot, jobId, env);
  const logFormat = readOptionValue(argv, '--format') ?? 'human';
  const tail = Number.parseInt(readOptionValue(argv, '--tail') ?? '200', 10);
  const logPath = String(logFormat === 'jsonl' ? job.event_log : job.human_log);
  if (!fs.existsSync(logPath)) {
    return '';
  }
  let lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines = lines.slice(0, -1);
  }
  const selected = tail > 0 ? lines.slice(-tail) : lines;
  return selected.length ? `${selected.join('\n')}\n` : '';
}
