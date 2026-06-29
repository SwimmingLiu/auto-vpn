import { AutoVpnEvent } from '../events/schema.js';
import {
  AutoVpnBackend,
  DetachedRunOptions,
  JobSummary,
  LogOptions,
  ResumeOptions,
  RetryOptions,
  RunOptions
} from './types.js';

export interface NodeBackendOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function unsupported(method: string): Error {
  return new Error(`Node backend ${method} is not available yet; use AUTOVPN_BACKEND=python`);
}

export class NodeBackend implements AutoVpnBackend {
  readonly kind = 'node' as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;

  constructor(options: NodeBackendOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
  }

  async *run(options: RunOptions): AsyncIterable<AutoVpnEvent> {
    if (!options.skipDeploy || !options.skipVerify) {
      throw new Error('Node backend deploy is not available yet; use AUTOVPN_BACKEND=python or --skip-deploy --skip-verify');
    }
    if (options.resumeLatest) {
      throw new Error('Node backend resume-latest is not available yet; use AUTOVPN_BACKEND=python');
    }
    void this.env;
    void this.cwd;
    throw new Error('Node backend non-deploy orchestrator is not implemented yet');
  }

  async *retryStage(_options: RetryOptions): AsyncIterable<AutoVpnEvent> {
    throw unsupported('retry-stage');
  }

  async *resume(_options: ResumeOptions): AsyncIterable<AutoVpnEvent> {
    throw unsupported('resume');
  }

  async startDetached(_options: DetachedRunOptions): Promise<JobSummary> {
    throw unsupported('startDetached');
  }

  async stopJob(_jobId: string): Promise<JobSummary> {
    throw unsupported('stopJob');
  }

  async readJob(_jobId: string): Promise<JobSummary> {
    throw unsupported('readJob');
  }

  async *readLogs(_options: LogOptions): AsyncIterable<string> {
    throw unsupported('readLogs');
  }

  async executeCli(_argv: string[]): Promise<number> {
    throw unsupported('executeCli');
  }
}
