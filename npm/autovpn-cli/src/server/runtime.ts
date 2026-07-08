import { artifactLatest, artifactList } from '../artifacts/list.js';
import { previewArtifact } from '../artifacts/preview.js';
import { profilePayload, saveProfilePayload } from '../config/profile.js';
import {
  startDetachedRetry as defaultStartDetachedRetry,
  startDetachedRun as defaultStartDetachedRun,
  stopManagedJob as defaultStopManagedJob
} from '../jobs/commands.js';
import { followLog as defaultFollowLog } from '../jobs/logs.js';

export interface ServerState {
  profile: Record<string, unknown>;
  runState: 'idle' | 'running' | 'stopping' | 'failed' | 'success';
  artifact?: Record<string, unknown>;
  retryArtifacts?: unknown[];
  deployment?: Record<string, unknown>;
}

export interface ServerRuntime {
  loadState(): Promise<ServerState>;
  saveProfile?(profile: Record<string, unknown>): Promise<Record<string, unknown>>;
  startRun?(options: { skipDeploy?: boolean; skipVerify?: boolean; resumeLatest?: boolean }): Promise<Record<string, unknown>>;
  startRetry?(options: { artifactDir?: string; stage?: string }): Promise<Record<string, unknown>>;
  stopRun?(): Promise<Record<string, unknown>>;
  subscribe?(handler: (event: unknown) => void): () => void;
}

type StartDetachedRun = typeof defaultStartDetachedRun;
type StartDetachedRetry = typeof defaultStartDetachedRetry;
type StopManagedJob = typeof defaultStopManagedJob;
type FollowLog = typeof defaultFollowLog;

export interface CreateServerRuntimeOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  proxy?: {
    enabled?: boolean;
    url?: string;
  };
  startDetachedRun?: StartDetachedRun;
  startDetachedRetry?: StartDetachedRetry;
  stopManagedJob?: StopManagedJob;
  followLog?: FollowLog;
}

const DEPLOY_SECRET_KEYS = new Set([
  'cloudflare_api_token',
  'cloudflare_global_key',
  'pages_secret_admin'
]);

function redactedLabel(key: string): string {
  return key === 'pages_secret_admin' ? '<Pages Secret ADMIN>' : '<Cloudflare Token>';
}

function redactIfSet(key: string, value: unknown): unknown {
  return String(value ?? '').trim() ? redactedLabel(key) : '';
}

export function sanitizeProfileForServer(profile: Record<string, any>): Record<string, any> {
  const safe = structuredClone(profile ?? {});
  for (const [key, value] of Object.entries((safe.deploy ?? {}) as Record<string, unknown>)) {
    if (DEPLOY_SECRET_KEYS.has(key)) {
      safe.deploy[key] = redactIfSet(key, value);
    }
  }
  return safe;
}

function preserveRedactedSecrets(incoming: Record<string, any>, current: Record<string, any>): Record<string, any> {
  const merged = structuredClone(incoming ?? {});
  const currentSources = (current.sources ?? {}) as Record<string, any>;
  for (const [name, source] of Object.entries((merged.sources ?? {}) as Record<string, any>)) {
    const currentSource = currentSources[name] ?? {};
    if (source && typeof source === 'object') {
      for (const key of ['url', 'key']) {
        if (source[key] === '<redacted>') {
          source[key] = currentSource[key] ?? '';
        }
      }
    }
  }
  const deploy = (merged.deploy ?? {}) as Record<string, any>;
  const currentDeploy = (current.deploy ?? {}) as Record<string, any>;
  for (const key of DEPLOY_SECRET_KEYS) {
    if (deploy[key] === '<redacted>' || deploy[key] === redactedLabel(key)) {
      deploy[key] = currentDeploy[key] ?? '';
    }
  }
  return merged;
}

function normalizeLatestArtifact(projectRoot: string, env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const latest = artifactLatest(projectRoot, env);
  if (!latest.ok || !latest.artifact_dir) {
    return undefined;
  }
  const preview = previewArtifact(String(latest.artifact_dir));
  return {
    ...latest,
    ...preview,
    outputFiles: (preview.files ?? []),
    nodeRows: []
  };
}

function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return { type: 'log', message: trimmed };
  }
}

function eventRunState(event: Record<string, any>): ServerState['runState'] | undefined {
  if (event.type === 'run_failed') {
    return 'failed';
  }
  if (event.type === 'summary') {
    const status = String(event.run_status ?? '');
    if (status === 'failed') {
      return 'failed';
    }
    if (status === 'success') {
      return 'success';
    }
    if (status === 'stopped') {
      return 'idle';
    }
  }
  return undefined;
}

function runEnv(options: CreateServerRuntimeOptions): NodeJS.ProcessEnv | undefined {
  if (!options.proxy?.enabled) {
    return options.env;
  }
  const proxyUrl = String(options.proxy.url ?? '').trim() || 'http://127.0.0.1:7897';
  return {
    ...(options.env ?? process.env),
    VPN_AUTOMATION_USE_UPSTREAM_PROXY: '1',
    VPN_AUTOMATION_UPSTREAM_PROXY: proxyUrl
  };
}

export function createServerRuntime(options: CreateServerRuntimeOptions): ServerRuntime {
  let runState: ServerState['runState'] = 'idle';
  let activeJobId = '';
  let unsubscribeLogs: (() => void) | undefined;
  const subscribers = new Set<(event: unknown) => void>();
  const startDetachedRun = options.startDetachedRun ?? defaultStartDetachedRun;
  const startDetachedRetry = options.startDetachedRetry ?? defaultStartDetachedRetry;
  const stopManagedJob = options.stopManagedJob ?? defaultStopManagedJob;
  const followLog = options.followLog ?? defaultFollowLog;

  function publish(event: unknown): void {
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }

  function followJob(jobId: string): void {
    let cancelled = false;
    unsubscribeLogs?.();
    unsubscribeLogs = () => {
      cancelled = true;
    };
    queueMicrotask(async () => {
      try {
        for await (const chunk of followLog(options.projectRoot, jobId, ['logs', '--format', 'jsonl', '--follow'], { env: options.env })) {
          if (cancelled) {
            return;
          }
          for (const line of String(chunk).split(/\r?\n/)) {
            const event = parseJsonLine(line);
            if (event) {
              const nextRunState = eventRunState(event as Record<string, any>);
              if (nextRunState) {
                runState = nextRunState;
              }
              publish(event);
            }
          }
        }
        if (!cancelled && runState === 'running') {
          runState = 'success';
          publish({ type: 'server_state', run_state: runState });
        }
      } catch (error) {
        if (!cancelled) {
          runState = 'failed';
          publish({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  }

  return {
    async loadState() {
      const artifact = normalizeLatestArtifact(options.projectRoot, options.env ?? process.env);
      const retries = artifactList(options.projectRoot, options.env ?? process.env);
      return {
        profile: sanitizeProfileForServer(profilePayload(options.projectRoot, options.env)),
        runState,
        artifact,
        retryArtifacts: Array.isArray(retries.items) ? retries.items : [],
        deployment: (artifact?.deployment ?? {}) as Record<string, unknown>
      };
    },
    async saveProfile(profile) {
      const current = profilePayload(options.projectRoot, options.env);
      const merged = preserveRedactedSecrets(profile, current);
      return {
        ok: true,
        profile: sanitizeProfileForServer(saveProfilePayload(options.projectRoot, merged, options.env) as Record<string, any>)
      };
    },
    async startRun(runOptions = {}) {
      if (runState === 'running' || runState === 'stopping') {
        return { ok: false, error: 'run_already_active' };
      }
      runState = 'running';
      let job: Awaited<ReturnType<StartDetachedRun>>;
      try {
        job = await startDetachedRun({
          projectRoot: options.projectRoot,
          skipDeploy: Boolean(runOptions.skipDeploy),
          skipVerify: Boolean(runOptions.skipVerify),
          resumeLatest: Boolean(runOptions.resumeLatest),
          outputFormat: 'jsonl'
        }, {
          env: runEnv(options),
          cwd: options.projectRoot
        });
      } catch (error) {
        runState = 'failed';
        activeJobId = '';
        publish({ type: 'server_state', run_state: runState });
        throw error;
      }
      activeJobId = String(job.job_id ?? '');
      followJob(activeJobId);
      return { ok: true, runId: activeJobId, job_id: activeJobId, status: job.status ?? 'running' };
    },
    async startRetry(retryOptions = {}) {
      if (runState === 'running' || runState === 'stopping') {
        return { ok: false, error: 'run_already_active' };
      }
      const artifactDir = String(retryOptions.artifactDir ?? '').trim();
      const stage = String(retryOptions.stage ?? '').trim();
      if (!artifactDir || !stage) {
        return { ok: false, error: 'artifact_dir_and_stage_required' };
      }
      runState = 'running';
      const job = await startDetachedRetry({
        projectRoot: options.projectRoot,
        artifactDir,
        stage,
        outputFormat: 'jsonl'
      }, {
        env: runEnv(options),
        cwd: options.projectRoot
      });
      activeJobId = String(job.job_id ?? '');
      followJob(activeJobId);
      return { ok: true, runId: activeJobId, job_id: activeJobId, status: job.status ?? 'running' };
    },
    async stopRun() {
      if (runState !== 'running' || !activeJobId) {
        return { ok: true, requested: false, run_state: runState };
      }
      runState = 'stopping';
      publish({ type: 'server_state', run_state: runState });
      const jobId = activeJobId;
      try {
        const stopped = await stopManagedJob(options.projectRoot, jobId, { env: options.env });
        unsubscribeLogs?.();
        runState = 'idle';
        activeJobId = '';
        publish({ type: 'server_state', run_state: 'idle' });
        return { ok: true, requested: true, job_id: stopped.job_id ?? jobId, status: stopped.status ?? 'stopped', stopped: true };
      } catch (error) {
        unsubscribeLogs?.();
        runState = 'failed';
        publish({ type: 'server_state', run_state: 'failed' });
        return { ok: false, requested: true, run_state: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    }
  };
}
