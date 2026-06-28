import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { resolveProfilePath } from '../runtime/paths.js';

export interface JobStoreOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  jobId?: () => string;
}

export interface CreateRunningJobInput {
  kind: string;
  command: string[];
  pid: number;
  options: Record<string, unknown>;
  retry?: Record<string, unknown>;
  resumeFrom?: string;
}

export type JobRecord = Record<string, any>;

function defaultNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function defaultJobId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
  return `${stamp}-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
}

function writeJson(filePath: string, payload: Record<string, any>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export class JobStore {
  readonly projectRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => string;
  private readonly jobId: () => string;

  constructor(projectRoot: string, options: JobStoreOptions = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.env = options.env ?? process.env;
    this.now = options.now ?? defaultNow;
    this.jobId = options.jobId ?? defaultJobId;
  }

  jobsRoot(): string {
    return path.join(path.dirname(resolveProfilePath(this.projectRoot, this.env)), 'jobs');
  }

  indexPath(): string {
    return path.join(this.jobsRoot(), 'index.json');
  }

  loadIndex(): Record<string, any> {
    if (!fs.existsSync(this.indexPath())) {
      return { schema_version: 1, latest_job_id: '', jobs: [] };
    }
    return readJson(this.indexPath());
  }

  createRunningJob(input: CreateRunningJobInput): JobRecord {
    const jobId = this.jobId();
    const jobDir = path.join(this.jobsRoot(), jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const createdAt = this.now();
    const job: JobRecord = {
      schema_version: 1,
      job_id: jobId,
      kind: input.kind,
      status: 'running',
      pid: input.pid,
      pgid: input.pid,
      created_at: createdAt,
      started_at: createdAt,
      finished_at: '',
      updated_at: createdAt,
      exit_code: null,
      signal: '',
      project_root: this.projectRoot,
      command: input.command,
      event_log: path.join(jobDir, 'events.jsonl'),
      human_log: path.join(jobDir, 'human.log'),
      stdout_log: path.join(jobDir, 'stdout.log'),
      stderr_log: path.join(jobDir, 'stderr.log'),
      artifact_dir: '',
      session_dir: jobDir,
      resume_from: input.resumeFrom ?? '',
      retry: input.retry ?? { source_artifact_dir: '', stage: '' },
      options: input.options,
      stop_requested_at: '',
      last_event_at: '',
      last_error: '',
      job_file: path.join(jobDir, 'job.json')
    };
    for (const key of ['event_log', 'human_log', 'stdout_log', 'stderr_log']) {
      fs.closeSync(fs.openSync(String(job[key]), 'a'));
    }
    return this.writeJob(job);
  }

  loadJob(jobId: string): JobRecord {
    const jobPath = path.join(this.jobsRoot(), jobId, 'job.json');
    if (!fs.existsSync(jobPath)) {
      throw new Error(`job not found: ${jobId}`);
    }
    return readJson(jobPath);
  }

  writeJob(job: JobRecord): JobRecord {
    job.updated_at = this.now();
    writeJson(String(job.job_file), job);
    this.updateIndex(job);
    return job;
  }

  updateIndex(job: JobRecord): void {
    const index = this.loadIndex();
    const jobs = (index.jobs ?? []).filter((item: Record<string, unknown>) => item.job_id !== job.job_id);
    jobs.push({
      job_id: job.job_id,
      status: job.status,
      kind: job.kind,
      created_at: job.created_at,
      job_file: job.job_file
    });
    writeJson(this.indexPath(), {
      schema_version: 1,
      latest_job_id: job.job_id,
      jobs
    });
  }
}

export function createJobStore(projectRoot: string, options: JobStoreOptions = {}): JobStore {
  return new JobStore(projectRoot, options);
}
