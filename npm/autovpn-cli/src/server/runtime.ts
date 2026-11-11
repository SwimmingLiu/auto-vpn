import fs from 'node:fs';
import path from 'node:path';

import { artifactLatest, artifactList, artifactWorkedAt } from '../artifacts/list.js';
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
  refreshAccountExpiry?(input: { brand?: string; limit?: number; concurrency?: number }): Promise<Record<string, unknown>>;
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

/**
 * Fold stage and substep transitions down to their latest state.
 *
 * The terminal guard is what keeps a finished run from reading as 运行中: the
 * tail of a long log is mostly `extract_iteration`, so a fold that only looked
 * at older lines dropped the final `success` of extract/dedupe/speedtest/
 * availability. Folding the whole stream means the last transition always
 * wins unless it would demote a terminal state back to `running`.
 */
function foldStageEvents(events: Array<Record<string, any>>): unknown[] {
  const folded = new Map<string, Record<string, any>>();
  for (const event of events) {
    if (event.type === 'extract_substage' && typeof event.source_name === 'string'
      && typeof event.platform === 'string' && typeof event.substage === 'string') {
      folded.set(['substage', event.source_name, event.platform, event.substage].join(':'), event);
    }
    if (event.type === 'stage' && typeof event.stage === 'string') {
      folded.set(`stage:${event.stage}`, event);
    }
  }
  return [...folded.values()];
}

/**
 * Replay history for a page load: folded states first, then the recent tail.
 *
 * Stage and substep transitions are dropped from the tail because their folded
 * copy already carries the final state; keeping both would replay `running`
 * after `success` and undo the fold.
 */
function foldEventHistory(events: Array<Record<string, any>>, maxEvents = 1000): unknown[] {
  const folded = foldStageEvents(events);
  const tail = events
    .slice(-maxEvents)
    .filter((event) => event.type !== 'stage' && event.type !== 'extract_substage');
  return [...folded, ...tail];
}

function latestJobEvents(job: Record<string, any> | undefined, maxEvents = 1000): unknown[] {
  const eventLog = String(job?.event_log ?? '');
  if (!eventLog || !fs.existsSync(eventLog)) return [];
  try {
    const lines = fs.readFileSync(eventLog, 'utf8').split(/\r?\n/).filter(Boolean);
    const events = lines.map((line) => parseJsonLine(line)).filter(Boolean) as Array<Record<string, any>>;
    return foldEventHistory(events, maxEvents);
  } catch {
    return [];
  }
}

/**
 * Stage/substep states and log lines for the latest artifact.
 *
 * A cron run has no job directory, so its only record is the mirror the CLI
 * writes beside the artifact. Its log is the authoritative one when present:
 * it covers every run path (foreground, detached, nightly) with one file.
 */
function artifactEventLog(artifactDir: string): { events: unknown[]; active: boolean } {
  const filePath = path.join(artifactDir, 'events.jsonl');
  if (!artifactDir || !fs.existsSync(filePath)) {
    return { events: [], active: false };
  }
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    const events = lines.map((line) => parseJsonLine(line)).filter(Boolean) as Array<Record<string, any>>;
    // Only the LAST run in the file decides whether it is still going. A resume
    // appends to the same artifact log, so an earlier run's terminal line would
    // otherwise mark the live resume finished and the page would never follow it.
    let finished = false;
    for (const event of events) {
      if (event.type === 'run_started' || event.type === 'resume_latest_state' || event.type === 'resume_pipeline_state') {
        finished = false;
      } else if (event.type === 'summary' || event.type === 'run_failed' || event.type === 'finished') {
        finished = true;
      }
    }
    let fresh = false;
    try {
      fresh = Date.now() - fs.statSync(filePath).mtimeMs < 2 * 60 * 1000;
    } catch {
      fresh = false;
    }
    return { events: foldEventHistory(events), active: !finished && fresh };
  } catch {
    return { events: [], active: false };
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
  // The run's own files, not the directory: a read-only progress query creates
  // WAL sidecars and touches the directory, which would keep a terminal state
  // alive indefinitely on a host whose page is simply left open.
  const updatedAt = artifactDir ? artifactWorkedAt(artifactDir) : 0;
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

/**
 * Delete run records whose day is older than the retention window.
 *
 * T+1 is the default: the vendor's nightly run books its results after
 * midnight, so a same-day prune would delete the run the operator is about to
 * open. The window is calendar-day based rather than mtime based, so a file
 * touched by a copy or a backup does not survive forever.
 *
 * `AUTOVPN_SERVER_HISTORY_RETENTION_DAYS` keeps its meaning (0 disables), and
 * `AUTOVPN_SERVER_LOG_RETENTION_DAYS` overrides it for the log files alone.
 */
function retentionCutoffMs(env: NodeJS.ProcessEnv, days: number, now: Date): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return start.getTime() - days * 24 * 60 * 60 * 1000;
}

function logRetentionMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.AUTOVPN_SERVER_LOG_RETENTION_DAYS ?? '').trim();
  if (!raw) return historyRetentionMs(env);
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed * 24 * 60 * 60 * 1000;
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

/**
 * Age out daily-run logs and results on the same schedule.
 *
 * `scripts/server/daily-run.sh` appends one log and one result file per tick
 * and never deletes either, so a host that runs nightly accumulates a year of
 * them. The serve process owns both directories and prunes them here rather
 * than adding a second cron entry that can drift.
 */
function pruneDailyRunRecords(env: NodeJS.ProcessEnv, cutoffMs: number): void {
  const runtimeRoot = path.dirname(resolveProfilePath('', env));
  // Only the records this job writes. `logs/` also holds the serve unit's own
  // stdout file, which systemd keeps open: unlinking it would leave the daemon
  // writing to a deleted inode and silently lose every later log line.
  const owned = [/^daily-run-.*\.log$/, /^\d{8}-\d{6}\.json$/];
  for (const dirName of ['logs', 'daily-run-results']) {
    const dir = path.join(runtimeRoot, dirName);
    if (!fs.existsSync(dir)) continue;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!owned.some((pattern) => pattern.test(name))) continue;
      const file = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Best effort: an open log handle on another platform is not fatal.
      }
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
    const now = (options.now ?? (() => new Date()))();
    const nowMs = now.getTime();
    // At most once a day, at the first state load after a day has passed. The
    // cutoff is the start of the day N days back, so everything older than
    // today (T+1) goes and a run that finished late yesterday stays.
    if (lastPrunedAt && nowMs - lastPrunedAt < 24 * 60 * 60 * 1000) return;
    lastPrunedAt = nowMs;
    const retentionDays = historyRetentionMs(env) / (24 * 60 * 60 * 1000);
    if (retentionDays > 0) {
      const cutoffMs = retentionCutoffMs(env, retentionDays, now);
      const activeArtifactDirs = pruneJobs(options.projectRoot, env, cutoffMs);
      pruneArtifacts(options.projectRoot, env, cutoffMs, activeArtifactDirs);
    }
    // Logs carry their own window, so a host can keep a month of run records
    // and only a day of stdout without a second cleanup entry to drift.
    const logDays = logRetentionMs(env) / (24 * 60 * 60 * 1000);
    if (logDays > 0) {
      pruneDailyRunRecords(env, retentionCutoffMs(env, logDays, now));
    }
  };
}

export function createServerRuntime(options: CreateServerRuntimeOptions): ServerRuntime {
  let runState: ServerState['runState'] = 'idle';
  let activeJobId = '';
  let unsubscribeLogs: (() => void) | undefined;
  let unsubscribeArtifactLogs: (() => void) | undefined;
  let followedArtifactDir = '';
  let expiryRefreshInFlight = false;
  const pruneHistory = createHistoryPruner(options);
  const subscribers = new Set<(event: unknown) => void>();
  const startDetachedRun = options.startDetachedRun ?? defaultStartDetachedRun;
  const startDetachedRetry = options.startDetachedRetry ?? defaultStartDetachedRetry;
  const stopManagedJob = options.stopManagedJob ?? defaultStopManagedJob;
  const followLog = options.followLog ?? defaultFollowLog;

  const publish = (event: unknown): void => {
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  };

  /**
   * Follow a plain event log that no job directory owns.
   *
   * A nightly cron run writes `<artifact>/events.jsonl` (the CLI mirrors its
   * stream there), but nothing tells the server to tail it: without this the
   * page stays on whatever the last detached job left and the logs never move.
   * Polling a file is enough here — the writer appends a line at a time and the
   * page needs sub-second freshness, not inotify precision.
   */
  function followArtifactEvents(artifactDir: string): void {
    if (followedArtifactDir === artifactDir && unsubscribeArtifactLogs) {
      return;
    }
    unsubscribeArtifactLogs?.();
    followedArtifactDir = artifactDir;
    const filePath = path.join(artifactDir, 'events.jsonl');
    let cancelled = false;
    let offset = 0;
    let pending = '';
    const timer = setInterval(() => {
      if (cancelled) return;
      let chunk = '';
      try {
        const stat = fs.statSync(filePath);
        if (stat.size <= offset) {
          if (stat.size < offset) offset = 0;
          return;
        }
        const length = stat.size - offset;
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(filePath, 'r');
        try {
          fs.readSync(fd, buffer, 0, length, offset);
        } finally {
          fs.closeSync(fd);
        }
        offset = stat.size;
        chunk = pending + buffer.toString('utf8');
      } catch {
        return;
      }
      const lines = chunk.split(/\r?\n/);
      pending = lines.pop() ?? '';
      let terminal = false;
      for (const line of lines) {
        const event = parseJsonLine(line);
        if (!event) continue;
        const nextRunState = eventRunState(event as Record<string, any>);
        if (nextRunState) {
          runState = nextRunState;
          terminal = true;
        }
        // Same contract as the job follower: a result line replayed after a
        // page load must carry absolute database totals, or the renderer adds
        // it on top of the snapshot it already hydrated and doubles the count.
        const record = event as Record<string, any>;
        const metricEvent = ['extract_iteration', 'extract_source_completed', 'speedtest_result', 'availability_link_result'].includes(String(record.type));
        const progress = metricEvent ? readRunProgress(path.join(artifactDir, 'run.db')) : undefined;
        publish(progress ? { ...record, progress_snapshot: { ...progress, artifact_dir: artifactDir } } : event);
        if (nextRunState) publish({ type: 'server_state', run_state: runState });
      }
      // The run is over: stop polling instead of stat-ing a finished file every
      // 800ms for the life of the server. A later run follows its own artifact.
      if (terminal) {
        unsubscribeArtifactLogs?.();
        unsubscribeArtifactLogs = undefined;
        followedArtifactDir = '';
      }
    }, 800);
    timer.unref?.();
    unsubscribeArtifactLogs = () => {
      cancelled = true;
      clearInterval(timer);
    };
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
    const env = options.env ?? process.env;
    // A terminal state is a report about the *previous* run, not a latch. A new
    // artifact whose log is still growing is a new run, and it must be followed
    // even though the last one ended in success — otherwise the page stays
    // frozen on yesterday's outcome until the server restarts.
    const artifactDir = String(artifact?.artifact_dir ?? '');
    const liveArtifact = artifactDir && artifactEventLog(artifactDir).active ? artifactDir : '';
    if (runState !== 'idle' && !liveArtifact) {
      return;
    }
    if (liveArtifact && runState !== 'running' && runState !== 'stopping') {
      unsubscribeLogs?.();
      activeJobId = '';
      runState = 'running';
      followArtifactEvents(liveArtifact);
      return;
    }
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
      // A scheduled run has no job to follow, but its artifact log may still
      // be growing. Restoring that follow is what makes the page live again
      // after the server restarts mid-run.
      const artifactDir = String(artifact?.artifact_dir ?? '');
      if (artifactDir && artifactEventLog(artifactDir).active) {
        runState = 'running';
        followArtifactEvents(artifactDir);
      }
    }
  }

  return {
    async loadState() {
      pruneHistory();
      const artifact = normalizeLatestArtifact(options.projectRoot, options.env ?? process.env);
      restoreRunState(artifact);
      const retries = artifactList(options.projectRoot, options.env ?? process.env);
      const job = latestJob(options.projectRoot, options.env ?? process.env);
      // The artifact's own mirror wins when it exists: a scheduled run has no
      // job, and replaying an older job's log put four finished stages back to
      // 运行中 on the results page. A stale artifact log is still the right
      // history — it is this artifact's, not another run's — so only its
      // `active` flag (which drives live following) is time-bounded.
      const artifactLog = artifactEventLog(String(artifact?.artifact_dir ?? ''));
      return {
        profile: sanitizeProfileForServer(profilePayload(options.projectRoot, options.env)),
        runState,
        artifact,
        retryArtifacts: Array.isArray(retries.items) ? retries.items : [],
        activity: Array.isArray(retries.activity) ? retries.activity : [],
        activityUnavailable: Number(retries.activityUnavailable ?? 0),
        deployment: (artifact?.deployment ?? {}) as Record<string, unknown>,
        logEvents: artifactLog.events.length ? artifactLog.events : latestJobEvents(job)
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
    /**
     * Learn every pooled account's membership date, then retire the lapsed and
     * non-member rows.
     *
     * The worker is imported lazily: it pulls in the whole credential pipeline,
     * and `serve` must start on an install whose dist predates it.
     */
    async refreshAccountExpiry(input = {}) {
      let worker: ((options: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
      try {
        const module = await import('../pipeline/credential-source.js') as unknown as Record<string, unknown>;
        worker = typeof module.refreshAccountExpiry === 'function'
          ? module.refreshAccountExpiry as (options: Record<string, unknown>) => Promise<Record<string, unknown>>
          : undefined;
      } catch {
        worker = undefined;
      }
      if (!worker) return { ok: false, error: 'refresh_expiry_unavailable' };
      // One sweep at a time: it logs in to every active row, and two overlapping
      // sweeps would double the vendor load and race on the same rows.
      if (expiryRefreshInFlight) return { ok: false, error: 'refresh_expiry_in_progress' };
      expiryRefreshInFlight = true;
      const store = new AccountStore({ env: options.env, now: options.now });
      try {
        const outcome = await worker({
          brand: String(input.brand ?? '').trim() || undefined,
          limit: Math.max(0, Math.trunc(Number(input.limit ?? 0)) || 0),
          concurrency: Math.max(1, Math.trunc(Number(input.concurrency ?? 3)) || 3),
          env: options.env,
          store,
          now: options.now
        });
        return { ok: true, ...outcome, stats: store.stats() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        expiryRefreshInFlight = false;
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
      unsubscribeArtifactLogs?.();
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
      unsubscribeArtifactLogs?.();
      followJob(activeJobId);
      return { ok: true, runId: activeJobId, job_id: activeJobId, status: job.status ?? 'running' };
    },
    async stopRun() {
      if (runState !== 'running' || !activeJobId) {
        // A scheduled run has no managed job to signal; stop following its log
        // so the page does not keep reporting a run the operator ended.
        unsubscribeArtifactLogs?.();
        unsubscribeArtifactLogs = undefined;
        followedArtifactDir = '';
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
      unsubscribeArtifactLogs?.();
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
