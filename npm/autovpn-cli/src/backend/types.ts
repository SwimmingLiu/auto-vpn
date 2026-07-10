import { AutoVpnEvent } from '../events/schema.js';

export interface RunOptions {
  projectRoot: string;
  skipDeploy?: boolean;
  skipVerify?: boolean;
  resumeLatest?: boolean;
  output?: 'jsonl' | 'human';
  eventLog?: string;
  humanLog?: string;
}

export interface RetryOptions {
  projectRoot: string;
  artifactDir: string;
  stage: string;
  output?: 'jsonl' | 'human';
  eventLog?: string;
  humanLog?: string;
}

export interface ResumeOptions {
  projectRoot: string;
  mode: 'pipeline' | 'speedtest';
  session: string;
  output?: 'jsonl' | 'human';
  eventLog?: string;
  humanLog?: string;
}

export interface DetachedRunOptions extends RunOptions {
}

export interface JobSummary {
  job_id?: string;
  kind?: string;
  status?: string;
  [key: string]: unknown;
}

export interface LogOptions {
  projectRoot: string;
  jobId?: string;
  format?: 'human' | 'jsonl';
  tail?: number;
  follow?: boolean;
}

export interface AutoVpnBackend {
  kind: 'node';
  run(options: RunOptions): AsyncIterable<AutoVpnEvent>;
  retryStage(options: RetryOptions): AsyncIterable<AutoVpnEvent>;
  resume(options: ResumeOptions): AsyncIterable<AutoVpnEvent>;
  startDetached(options: DetachedRunOptions): Promise<JobSummary>;
  stopJob(jobId: string, options?: { projectRoot?: string; timeout?: number }): Promise<JobSummary>;
  readJob(jobId: string, options?: { projectRoot?: string }): Promise<JobSummary>;
  readLogs(options: LogOptions): AsyncIterable<string>;
  executeCli(argv: string[]): Promise<number>;
}
