import fs from 'node:fs';
import path from 'node:path';
import { AutoVpnEvent } from '../events/schema.js';
import { artifactWorkedAt } from '../artifacts/list.js';
import { resumeNodePipeline, retryNodePipelineStage, runNodePipeline } from '../pipeline/orchestrator.js';
import { AccountStore } from '../pool/account-store.js';
import { describeSharedPoolUrl, pullSharedPool, pushSharedPool, resolveSharedPoolUrl } from '../pool/pg-pool.js';
import { resolveArtifactsRoot } from '../runtime/paths.js';
import { redactText } from '../runtime/redaction.js';
import { readLatestStageStatuses, readRunStatus } from '../pipeline/run-store.js';
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
  return new Error(`Node backend ${method} is not available in this execution path`);
}

function latestIncompleteRunArtifact(projectRoot: string, env: NodeJS.ProcessEnv): string | undefined {
  const artifactsRoot = resolveArtifactsRoot(projectRoot, env);
  if (!fs.existsSync(artifactsRoot)) {
    return undefined;
  }
  const candidates = fs.readdirSync(artifactsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const artifactDir = path.join(artifactsRoot, entry.name);
      const dbPath = path.join(artifactDir, 'run.db');
      return { artifactDir, dbPath };
    })
    .filter((candidate) => fs.existsSync(candidate.dbPath))
    // The run's own files date it; the directory mtime moves whenever a
    // read-only progress query creates WAL sidecars beside `run.db`.
    .sort((left, right) => artifactWorkedAt(right.artifactDir) - artifactWorkedAt(left.artifactDir));

  for (const candidate of candidates) {
    const runStatus = readRunStatus(candidate.dbPath);
    if (!runStatus || ['success', 'failed', 'stopped', 'cancelled'].includes(runStatus)) {
      continue;
    }
    const stageStatus = readLatestStageStatuses(candidate.dbPath);
    if (stageStatus.verify === 'success') continue;
    return candidate.artifactDir;
  }
  return undefined;
}

function writeResumeLatestSession(artifactDir: string, options: RunOptions): string {
  const sessionDir = path.join(artifactDir, '.node-resume-latest');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
    artifact_dir: artifactDir,
    event_log: options.eventLog ?? path.join(sessionDir, 'events.jsonl'),
    human_log: options.humanLog ?? path.join(sessionDir, 'human.log')
  }), 'utf8');
  return sessionDir;
}

function pushEvent(queue: EventQueueState, event: AutoVpnEvent): void {
  queue.events.push(event);
  const wake = queue.wake.shift();
  wake?.();
}

/**
 * Mirror one run's events into its own artifact directory.
 *
 * A run started by cron or by a plain `autovpn run` has no job directory, so
 * its event stream existed only on stdout and the served UI had nothing to
 * follow: the logs page showed the last detached job's stale lines and never
 * refreshed. Writing `<artifact>/events.jsonl` next to the artifact makes the
 * run self-describing, so the server can tail it, a page reload can replay it,
 * and log retention can prune it with the rest of the run's records.
 *
 * The file is opened lazily on `run_started`, the first event that names the
 * artifact directory. When the caller already asked for that exact path via
 * `--event-log`, the orchestrator is writing it and the mirror stays out of the
 * way rather than appending every line twice.
 */
function createArtifactEventMirror(explicitEventLog?: string, knownArtifactDir?: string): { write(event: AutoVpnEvent): void } {
  let file = '';
  let disabled = false;
  const open = (artifactDir: string): void => {
    file = path.join(artifactDir, 'events.jsonl');
    if (explicitEventLog && path.resolve(explicitEventLog) === path.resolve(file)) {
      disabled = true;
    }
  };
  if (knownArtifactDir) open(knownArtifactDir);
  return {
    write(event: AutoVpnEvent): void {
      if (disabled) return;
      if (!file) {
        const artifactDir = String((event as Record<string, unknown>).artifact_dir ?? '');
        // A resumed run emits no `run_started`; its artifact is known up front.
        if (!artifactDir || (event.type !== 'run_started' && event.type !== 'resume_latest_state')) return;
        open(artifactDir);
        if (disabled) return;
      }
      try {
        // The stream carries request URLs and vendor messages, so the mirror
        // gets the same owner-only mode the job logs use.
        fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // The mirror is an observability aid; a full disk must not fail a run.
      }
    }
  };
}

/** The artifact a resume session belongs to, or '' when it cannot be read. */
function resumeArtifactDir(session: string): string {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(session, 'session.json'), 'utf8')) as Record<string, unknown>;
    return String(payload.artifact_dir ?? '');
  } catch {
    return '';
  }
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

  /**
   * Move the pool between the shared database and this host's working copy.
   *
   * A run leases one credential per login from the local sqlite file, so the
   * shared table only has to be read once at the start and written once at the
   * end. The pull is fatal when the database is configured and unreachable: a
   * night that silently rotated a stale copy is the failure mode the shared
   * pool exists to remove. The push is not fatal — the measurement is already
   * done — but it is reported, because a lost push is a retirement the other
   * hosts will not see.
   */
  private async syncSharedPool(
    queue: EventQueueState,
    direction: 'pull' | 'push',
    emit: (event: AutoVpnEvent) => void = (event) => pushEvent(queue, event)
  ): Promise<void> {
    const url = resolveSharedPoolUrl(this.env);
    if (!url) return;
    const pool = describeSharedPoolUrl(url);
    const store = new AccountStore({ env: this.env });
    try {
      if (direction === 'pull') {
        const pulled = await pullSharedPool(store, { url, env: this.env });
        emit({
          type: 'log',
          level: 'info',
          message: `shared pool ${pool}: pulled new=${pulled.inserted} updated=${pulled.updated}` +
            ` unchanged=${pulled.unchanged} local_newer=${pulled.local_newer}`
        });
      } else {
        const pushed = await pushSharedPool(store, { url, env: this.env });
        emit({
          type: 'log',
          level: 'info',
          message: `shared pool ${pool}: pushed sent=${pushed.sent} new=${pushed.inserted}` +
            ` updated=${pushed.updated} stale=${pushed.stale}`
        });
      }
    } finally {
      store.close();
    }
  }

  private async syncPushAfterRun(queue: EventQueueState): Promise<void> {
    try {
      await this.syncSharedPool(queue, 'push');
    } catch (error) {
      // This line is mirrored into the run's artifact log, which is uploaded;
      // a connection error can quote the URL and with it the database password.
      pushEvent(queue, {
        type: 'log',
        level: 'warn',
        message: `shared pool push failed: ${redactText(error instanceof Error ? error.message : String(error))}`
      });
    }
  }

  /**
   * One night on top of the shared pool: pull, run, push.
   *
   * Both `run` and `resume` need exactly this, and the order is the point — a
   * push before the pull would overwrite rows the other host retired since
   * this one last synced.
   */
  private async runWithSharedPool(
    queue: EventQueueState,
    emit: (event: AutoVpnEvent) => void,
    run: () => Promise<unknown>
  ): Promise<void> {
    await this.syncSharedPool(queue, 'pull', emit);
    try {
      await run();
    } finally {
      await this.syncPushAfterRun(queue);
    }
  }

  async *run(options: RunOptions): AsyncIterable<AutoVpnEvent> {
    const queue: EventQueueState = { events: [], wake: [], done: false };
    const mirror = createArtifactEventMirror(options.eventLog);
    const runner = options.resumeLatest
      ? async () => {
        const artifactDir = latestIncompleteRunArtifact(options.projectRoot, this.env);
        if (!artifactDir) {
          throw new Error('No incomplete run.db found to resume');
        }
        const resumeMirror = createArtifactEventMirror(options.eventLog, artifactDir);
        const stateEvent: AutoVpnEvent = { type: 'resume_latest_state', artifact_dir: artifactDir };
        resumeMirror.write(stateEvent);
        pushEvent(queue, stateEvent);
        const session = writeResumeLatestSession(artifactDir, options);
        return resumeNodePipeline({
          projectRoot: options.projectRoot,
          mode: 'pipeline',
          session,
          skipDeploy: options.skipDeploy,
          skipVerify: options.skipVerify,
          output: options.output,
          eventLog: options.eventLog,
          humanLog: options.humanLog
        }, {
          env: this.env,
          emit: (event) => {
            resumeMirror.write(event);
            pushEvent(queue, event);
          }
        });
      }
      : async () => runNodePipeline(options, {
        env: this.env,
        emit: (event) => {
          mirror.write(event);
          pushEvent(queue, event);
        }
      });
    const emit = (event: AutoVpnEvent) => {
      mirror.write(event);
      pushEvent(queue, event);
    };
    const execute = () => this.runWithSharedPool(queue, emit, runner);
    void execute()
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

  async *retryStage(options: RetryOptions): AsyncIterable<AutoVpnEvent> {
    const queue: EventQueueState = { events: [], wake: [], done: false };
    const mirror = createArtifactEventMirror(options.eventLog);
    void retryNodePipelineStage({
        projectRoot: options.projectRoot,
        artifactDir: options.artifactDir,
        stage: options.stage,
        output: options.output,
        eventLog: options.eventLog,
        humanLog: options.humanLog
      }, {
        env: this.env,
        emit: (event) => {
          mirror.write(event);
          pushEvent(queue, event);
        }
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

  async *resume(options: ResumeOptions): AsyncIterable<AutoVpnEvent> {
    const queue: EventQueueState = { events: [], wake: [], done: false };
    // A resumed run emits no `run_started`, so the mirror is seeded from the
    // session's artifact directory: without it the artifact log would keep the
    // interrupted run's `running` stages forever.
    const mirror = createArtifactEventMirror(options.eventLog, resumeArtifactDir(options.session));
    const emit = (event: AutoVpnEvent) => {
      mirror.write(event);
      pushEvent(queue, event);
    };
    const resume = () => resumeNodePipeline({
      projectRoot: options.projectRoot,
      mode: options.mode,
      session: options.session,
      output: options.output,
      eventLog: options.eventLog,
      humanLog: options.humanLog
    }, { env: this.env, emit });
    const execute = () => this.runWithSharedPool(queue, emit, resume);
    void execute()
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
