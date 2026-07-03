import { AutoVpnBackend } from '../backend/types.js';
import { profilePayload } from '../config/profile.js';

export interface ServerState {
  profile: Record<string, unknown>;
  runState: 'idle' | 'running' | 'stopping' | 'failed' | 'success';
  artifact?: Record<string, unknown>;
  retryArtifacts?: unknown[];
  deployment?: Record<string, unknown>;
}

export interface ServerRuntime {
  loadState(): Promise<ServerState>;
  startRun?(options: { skipDeploy?: boolean; skipVerify?: boolean; resumeLatest?: boolean }): Promise<Record<string, unknown>>;
  stopRun?(): Promise<Record<string, unknown>>;
  subscribe?(handler: (event: unknown) => void): () => void;
}

export interface CreateServerRuntimeOptions {
  projectRoot: string;
  backend: Pick<AutoVpnBackend, 'run' | 'kind'>;
  env?: NodeJS.ProcessEnv;
}

export function createServerRuntime(options: CreateServerRuntimeOptions): ServerRuntime {
  let runState: ServerState['runState'] = 'idle';
  const subscribers = new Set<(event: unknown) => void>();

  function publish(event: unknown): void {
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }

  return {
    async loadState() {
      return {
        profile: profilePayload(options.projectRoot, options.env),
        runState
      };
    },
    async startRun(runOptions = {}) {
      if (runState === 'running') {
        return { ok: false, error: 'run_already_active' };
      }
      runState = 'running';
      const runId = `run-${Date.now()}`;
      queueMicrotask(async () => {
        try {
          for await (const event of options.backend.run({
            projectRoot: options.projectRoot,
            skipDeploy: Boolean(runOptions.skipDeploy),
            skipVerify: Boolean(runOptions.skipVerify),
            resumeLatest: Boolean(runOptions.resumeLatest),
            output: 'jsonl'
          })) {
            publish(event);
          }
          runState = 'success';
          publish({ type: 'server_state', run_state: runState });
        } catch (error) {
          runState = 'failed';
          publish({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
      return { ok: true, runId };
    },
    async stopRun() {
      if (runState !== 'running') {
        return { ok: true, requested: false };
      }
      runState = 'stopping';
      publish({ type: 'server_state', run_state: runState });
      return { ok: true, requested: true };
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    }
  };
}
