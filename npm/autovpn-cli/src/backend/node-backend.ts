import { AutoVpnEvent } from '../events/schema.js';
import { runNodePipeline } from '../pipeline/orchestrator.js';
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

interface EventQueueState {
  events: AutoVpnEvent[];
  wake: Array<() => void>;
  done: boolean;
  error?: unknown;
}

function unsupported(method: string): Error {
  return new Error(`Node backend ${method} is not available yet; use AUTOVPN_BACKEND=python`);
}

function usesPythonStageFallback(env: NodeJS.ProcessEnv, stage: string): boolean {
  const stageValue = String(env[`AUTOVPN_STAGE_BACKEND_${stage.toUpperCase()}`] ?? '').trim().toLowerCase();
  const pipelineValue = String(env.AUTOVPN_PIPELINE_BACKEND ?? '').trim().toLowerCase();
  return stageValue === 'python' || pipelineValue === 'python';
}

function pushEvent(queue: EventQueueState, event: AutoVpnEvent): void {
  queue.events.push(event);
  const wake = queue.wake.shift();
  wake?.();
}

function finishQueue(queue: EventQueueState, error?: unknown): void {
  queue.done = true;
  queue.error = error;
  for (const wake of queue.wake.splice(0)) {
    wake();
  }
}

function waitForEvent(queue: EventQueueState): Promise<void> {
  return new Promise((resolve) => {
    queue.wake.push(resolve);
  });
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
    if (!options.skipDeploy && !usesPythonStageFallback(this.env, 'deploy')) {
      throw new Error('Node backend deploy is not available yet; use AUTOVPN_BACKEND=python or --skip-deploy --skip-verify');
    }
    if (!options.skipVerify && !options.skipDeploy && !usesPythonStageFallback(this.env, 'verify')) {
      throw new Error('Node backend verify is not available yet; use AUTOVPN_BACKEND=python or --skip-verify');
    }
    if (options.resumeLatest) {
      throw new Error('Node backend resume-latest is not available yet; use AUTOVPN_BACKEND=python');
    }
    const queue: EventQueueState = { events: [], wake: [], done: false };
    void runNodePipeline(options, {
        env: this.env,
        emit: (event) => pushEvent(queue, event)
      })
      .then(() => finishQueue(queue))
      .catch((error) => finishQueue(queue, error));

    while (!queue.done || queue.events.length > 0) {
      if (queue.events.length === 0) {
        await waitForEvent(queue);
        continue;
      }
      yield queue.events.shift() as AutoVpnEvent;
    }
    if (queue.error) {
      throw queue.error;
    }
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
