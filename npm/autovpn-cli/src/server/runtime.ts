import fs from 'node:fs';
import path from 'node:path';

import { artifactLatest, artifactList } from '../artifacts/list.js';
import { previewArtifact, type FinalNodeRow } from '../artifacts/preview.js';
import { profilePayload, saveProfilePayload } from '../config/profile.js';
import {
  startDetachedRetry as defaultStartDetachedRetry,
  startDetachedRun as defaultStartDetachedRun,
  stopManagedJob as defaultStopManagedJob
} from '../jobs/commands.js';
import { followLog as defaultFollowLog } from '../jobs/logs.js';
import { latestJobId, loadJob } from '../jobs/read.js';
import { AccountStore } from '../pool/account-store.js';
import { normalizeBrand } from '../pool/brands.js';
import { parseAccountFile, normalizeExpiry } from '../pool/csv.js';
import { readRunProgress } from '../pipeline/run-store.js';
import { resolveArtifactsRoot, resolveProfilePath } from '../runtime/paths.js';

export interface ServerState {
  profile: Record<string, unknown>;
  runState: 'idle' | 'running' | 'stopping' | 'failed' | 'success';
  artifact?: Record<string, unknown>;
  retryArtifacts?: unknown[];
  activity?: unknown[];
  activityUnavailable?: number;
  deployment?: Record<string, unknown>;
  logEvents?: unknown[];
}

export interface ServerRuntime {
  loadState(): Promise<ServerState>;
  saveProfile?(profile: Record<string, unknown>): Promise<Record<string, unknown>>;
  loadAccounts?(): Promise<Record<string, unknown>>;
  importAccounts?(input: { content?: string; format?: string }): Promise<Record<string, unknown>>;
  setAccountStatus?(input: { id?: number; brand?: string; account?: string; status?: string; reason?: string }): Promise<Record<string, unknown>>;
  setAccountExpiry?(input: { id?: number; brand?: string; account?: string; expires_at?: string }): Promise<Record<string, unknown>>;
  startRun?(options: { skipDeploy?: boolean; skipVerify?: boolean; resumeLatest?: boolean }): Promise<Record<string, unknown>>;
  startRetry?(options: { artifactDir?: string; stage?: string }): Promise<Record<string, unknown>>;
  stopRun?(): Promise<Record<string, unknown>>;
  subscribe?(handler: (event: unknown) => void): () => void;
  close?(): Promise<void>;
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
  now?: () => Date;
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
  // Credential sources carry a real account password; `/api/state` must not
  // echo it back to the client. The renderer round-trips `<redacted>` through
  // `preserveRedactedSecrets` on save, so the stored value is untouched.
  for (const source of Object.values((safe.sources ?? {}) as Record<string, any>)) {
    if (source && typeof source === 'object' && String(source.password ?? '').trim()) {
      source.password = '<redacted>';
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
      for (const key of ['url', 'key', 'password']) {
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
  const preview = previewArtifact(String(latest.artifact_dir), { includeNodeRows: true });
  const progress = readRunProgress(path.join(String(latest.artifact_dir), 'run.db'));
  return {
    ...latest,
    ...preview,
    // The report can still be empty mid-stage. Its display preview must not
    // replace the authoritative totals that already exist in the run database.
    ...(progress ? { counts: { ...(preview.counts ?? {}), ...progress.counts }, source_counts: progress.source_counts, progress_snapshot: progress } : {}),
    outputFiles: (preview.files ?? []),
    // The results page and the country donut read these rows. Answering with an
    // empty array left a browser session at 0 nodes and an empty 国家分布 while
    // the artifact held the full final list.
    nodeRows: (preview.nodeRows ?? []) as FinalNodeRow[]
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

function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function terminalStateTtlMs(env: NodeJS.ProcessEnv): number {
  return parsePositiveNumber(env.AUTOVPN_SERVER_TERMINAL_STATE_TTL_SECONDS, 600) * 1000;
}

function historyRetentionMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.AUTOVPN_SERVER_HISTORY_RETENTION_DAYS ?? '').trim();
  if (raw) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed <= 0) return 0;
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 24 * 60 * 60 * 1000;
  }
  return 7 * 24 * 60 * 60 * 1000;
}

function parseTimeMs(value: unknown): number {
  const time = Date.parse(String(value ?? '').replace(/\+00:00$/, 'Z'));
  return Number.isFinite(time) ? time : 0;
}

function jobTerminalAt(job: Record<string, any>): number {
  return parseTimeMs(job.finished_at) || parseTimeMs(job.created_at) || parseTimeMs(job.updated_at);
}

function latestJob(projectRoot: string, env: NodeJS.ProcessEnv): Record<string, any> | undefined {
  try {
    return loadJob(projectRoot, latestJobId(projectRoot, env), env);
  } catch {
    return undefined;
  }
}

function latestJobEvents(job: Record<string, any> | undefined, maxEvents = 1000): unknown[] {
  const eventLog = String(job?.event_log ?? '');
  if (!eventLog || !fs.existsSync(eventLog)) return [];
  try {
    const lines = fs.readFileSync(eventLog, 'utf8').split(/\r?\n/).filter(Boolean);
    const events = lines.map((line) => parseJsonLine(line)).filter(Boolean);
    const priorSteps = new Map<string, unknown>();
    // APK/domain steps occur early. Preserve their latest states even when
    // subsequent node logs exceed the bounded text-history window.
    for (const event of events.slice(0, -maxEvents)) {
      if (!event || typeof event !== 'object' || !('type' in event)) continue;
      if (event.type === 'extract_substage' && 'source_name' in event && typeof event.source_name === 'string'
        && 'platform' in event && typeof event.platform === 'string' && 'substage' in event && typeof event.substage === 'string') {
        priorSteps.set([event.source_name, event.platform, event.substage].join(':'), event);
      }
      if (event.type === 'stage' && 'stage' in event && typeof event.stage === 'string') priorSteps.set(`stage:${event.stage}`, event);
    }
    return [...priorSteps.values(), ...events.slice(-maxEvents)];
  } catch {
    return [];
  }
}

function terminalRunStateFromLatestJob(job: Record<string, any> | undefined, nowMs: number, ttlMs: number): ServerState['runState'] | undefined {
  const status = String(job?.status ?? '');
  if (status === 'running' || status === 'stopping') return status;
  if (!['success', 'failed', 'stopped'].includes(status)) return undefined;
  const finishedAt = jobTerminalAt(job ?? {});
  if (!finishedAt || nowMs - finishedAt > ttlMs) return undefined;
  return status === 'stopped' ? 'idle' : status as ServerState['runState'];
}

function terminalRunStateFromArtifact(artifact: Record<string, unknown> | undefined, nowMs: number, ttlMs: number): ServerState['runState'] | undefined {
  const status = String(artifact?.run_status ?? '');
  if (!['success', 'failed'].includes(status)) return undefined;
  const artifactDir = String(artifact?.artifact_dir ?? '');
  let updatedAt = 0;
  try {
    updatedAt = artifactDir ? fs.statSync(artifactDir).mtimeMs : 0;
  } catch {
    updatedAt = 0;
  }
  if (!updatedAt || nowMs - updatedAt > ttlMs) return undefined;
  return status as ServerState['runState'];
}

function runStateFromJobStatus(job: Record<string, any> | undefined): ServerState['runState'] | undefined {
  const status = String(job?.status ?? '');
  if (status === 'failed') return 'failed';
  if (status === 'success') return 'success';
  if (status === 'stopped') return 'idle';
  return undefined;
}

function jobsRoot(projectRoot: string, env: NodeJS.ProcessEnv): string {
  return path.join(path.dirname(resolveProfilePath(projectRoot, env)), 'jobs');
}

function safeRmDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort; serve startup and state loading must continue.
  }
}

function pruneArtifacts(projectRoot: string, env: NodeJS.ProcessEnv, cutoffMs: number, activeArtifactDirs: Set<string>): void {
  const root = resolveArtifactsRoot(projectRoot, env);
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    const artifactDir = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(artifactDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || activeArtifactDirs.has(path.resolve(artifactDir))) continue;
    if (stat.mtimeMs < cutoffMs) {
      safeRmDir(artifactDir);
    }
  }
}

function pruneJobs(projectRoot: string, env: NodeJS.ProcessEnv, cutoffMs: number): Set<string> {
  const root = jobsRoot(projectRoot, env);
  const activeArtifactDirs = new Set<string>();
  const indexPath = path.join(root, 'index.json');
  if (!fs.existsSync(indexPath)) return activeArtifactDirs;
  let index: Record<string, any>;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Record<string, any>;
  } catch {
    return activeArtifactDirs;
  }
  const kept: Array<Record<string, unknown>> = [];
  for (const item of (index.jobs ?? []) as Array<Record<string, unknown>>) {
    const jobId = String(item.job_id ?? '');
    let job: Record<string, any> | undefined;
    try {
      job = loadJob(projectRoot, jobId, env);
    } catch {
      continue;
    }
    const status = String(job.status ?? '');
    const artifactDir = String(job.artifact_dir ?? '');
    if (artifactDir && ['running', 'stopping'].includes(status)) {
      activeArtifactDirs.add(path.resolve(artifactDir));
    }
    const keep = ['running', 'stopping'].includes(status) || (jobTerminalAt(job) || parseTimeMs(job.created_at)) >= cutoffMs;
    if (keep) {
      kept.push({
        job_id: job.job_id,
        status: job.status,
        kind: job.kind,
        created_at: job.created_at,
        job_file: job.job_file
      });
    } else {
      safeRmDir(path.dirname(String(job.job_file ?? '')));
    }
  }
  const latestId = kept.some((item) => item.job_id === index.latest_job_id)
    ? String(index.latest_job_id ?? '')
    : String(kept.at(-1)?.job_id ?? '');
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify({ schema_version: 1, latest_job_id: latestId, jobs: kept }, null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort cleanup.
  }
  return activeArtifactDirs;
}

function createHistoryPruner(options: CreateServerRuntimeOptions): () => void {
  let lastPrunedAt = 0;
  return () => {
    const env = options.env ?? process.env;
    const retention = historyRetentionMs(env);
    if (retention <= 0) return;
    const nowMs = (options.now ?? (() => new Date()))().getTime();
    if (lastPrunedAt && nowMs - lastPrunedAt < 24 * 60 * 60 * 1000) return;
    lastPrunedAt = nowMs;
    const cutoffMs = nowMs - retention;
    const activeArtifactDirs = pruneJobs(options.projectRoot, env, cutoffMs);
    pruneArtifacts(options.projectRoot, env, cutoffMs, activeArtifactDirs);
  };
}

export function createServerRuntime(options: CreateServerRuntimeOptions): ServerRuntime {
  let runState: ServerState['runState'] = 'idle';
  let activeJobId = '';
  let unsubscribeLogs: (() => void) | undefined;
  const pruneHistory = createHistoryPruner(options);
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
              // A follower can deliver old result lines after loadState. Send
              // absolute database totals so those lines cannot add twice.
              const metricEvent = typeof event === 'object' && event !== null && 'type' in event
                && ['extract_iteration', 'extract_source_completed', 'speedtest_result', 'availability_link_result'].includes(String(event.type));
              const job = metricEvent ? loadJob(options.projectRoot, jobId, options.env) : undefined;
              const artifactDir = String(job?.artifact_dir ?? '');
              const progress = artifactDir ? readRunProgress(path.join(artifactDir, 'run.db')) : undefined;
              publish(progress && typeof event === 'object'
                ? { ...event, progress_snapshot: { ...progress, artifact_dir: artifactDir } }
                : event);
            }
          }
        }
        if (!cancelled && runState === 'running') {
          const reconciledState = runStateFromJobStatus(latestJob(options.projectRoot, options.env ?? process.env));
          if (reconciledState) {
            runState = reconciledState;
            publish({ type: 'server_state', run_state: runState });
          }
        }
      } catch (error) {
        if (!cancelled) {
          runState = 'failed';
          publish({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  }

  function restoreRunState(artifact: Record<string, unknown> | undefined): void {
    if (runState !== 'idle') {
      return;
    }
    const env = options.env ?? process.env;
    const job = latestJob(options.projectRoot, env);
    if (job && ['running', 'stopping'].includes(String(job.status ?? ''))) {
      runState = String(job.status) as ServerState['runState'];
      activeJobId = String(job.job_id ?? '');
      if (activeJobId && !unsubscribeLogs) {
        followJob(activeJobId);
      }
      return;
    }
    const nowMs = (options.now ?? (() => new Date()))().getTime();
    const ttlMs = terminalStateTtlMs(env);
    runState = terminalRunStateFromLatestJob(job, nowMs, ttlMs)
      ?? terminalRunStateFromArtifact(artifact, nowMs, ttlMs)
      ?? 'idle';
    if (runState !== 'running' && runState !== 'stopping') {
      activeJobId = '';
    }
  }

  return {
    async loadState() {
      pruneHistory();
      const artifact = normalizeLatestArtifact(options.projectRoot, options.env ?? process.env);
      restoreRunState(artifact);
      const retries = artifactList(options.projectRoot, options.env ?? process.env);
      const job = latestJob(options.projectRoot, options.env ?? process.env);
      return {
        profile: sanitizeProfileForServer(profilePayload(options.projectRoot, options.env)),
        runState,
        artifact,
        retryArtifacts: Array.isArray(retries.items) ? retries.items : [],
        activity: Array.isArray(retries.activity) ? retries.activity : [],
        activityUnavailable: Number(retries.activityUnavailable ?? 0),
        deployment: (artifact?.deployment ?? {}) as Record<string, unknown>,
        logEvents: latestJobEvents(job)
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
    async loadAccounts() {
      const store = new AccountStore({ env: options.env, now: options.now });
      try {
        return { ok: true, stats: store.stats(), accounts: store.list({ status: 'all', includeDeleted: true }) };
      } finally {
        store.close();
      }
    },
    async importAccounts(input = {}) {
      const content = String(input.content ?? '');
      const format = input.format === 'csv' || input.format === 'legacy' ? input.format : 'auto';
      const parsed = parseAccountFile(content, format);
      if (parsed.records.length === 0) {
        return { ok: false, imported: 0, issues: parsed.issues };
      }
      const store = new AccountStore({ env: options.env, now: options.now });
      try {
        const outcome = store.importRecords(parsed.records);
        return { ok: true, parsed: parsed.records.length, ...outcome, issues: parsed.issues, stats: store.stats() };
      } finally {
        store.close();
      }
    },
    async setAccountStatus(input = {}) {
      const id = Number(input.id);
      const brand = normalizeBrand(input.brand);
      const account = String(input.account ?? '').trim();
      const byId = Number.isInteger(id) && id > 0;
      if (!byId && (!brand || !account)) return { ok: false, error: 'id_or_brand_and_account_required' };
      const store = new AccountStore({ env: options.env, now: options.now });
      try {
        const status = String(input.status ?? '');
        const reason = String(input.reason ?? 'disabled by operator');
        const ok = status === 'active'
          ? (byId ? store.enableById(id) : store.enable(brand!, account))
          : status === 'disabled'
            ? (byId ? store.disableById(id, reason) : store.disable(brand!, account, reason))
            : false;
        return ok ? { ok, ...(byId ? { id } : { brand }), status } : { ok: false, error: 'account_not_found_or_status_invalid' };
      } finally {
        store.close();
      }
    },
    async setAccountExpiry(input = {}) {
      const id = Number(input.id);
      const brand = normalizeBrand(input.brand);
      const account = String(input.account ?? '').trim();
      const byId = Number.isInteger(id) && id > 0;
      if (!byId && (!brand || !account)) return { ok: false, error: 'id_or_brand_and_account_required' };
      // An absent `expires_at` is a bad request, not "clear the date": the old
      // CLI wrote '' on a missing flag and erased known expiries. Clearing is
      // spelled as an explicit empty string.
      if (input.expires_at === undefined) return { ok: false, error: 'expires_at_required' };
      const expiresAt = String(input.expires_at);
      const store = new AccountStore({ env: options.env, now: options.now });
      try {
        const ok = byId ? store.setExpiryById(id, expiresAt) : store.setExpiry(brand!, account, expiresAt);
        if (ok === null) return { ok: false, error: 'invalid_date', ...(byId ? { id } : { brand }) };
        if (!ok) return { ok: false, error: 'account_not_found' };
        return { ok: true, ...(byId ? { id } : { brand }), expires_at: normalizeExpiry(expiresAt) };
      } finally {
        store.close();
      }
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
    },
    async close() {
      unsubscribeLogs?.();
      if (!activeJobId) {
        const artifact = normalizeLatestArtifact(options.projectRoot, options.env ?? process.env);
        restoreRunState(artifact);
      }
      if ((runState === 'running' || runState === 'stopping') && activeJobId) {
        await this.stopRun?.();
      }
    }
  };
}
