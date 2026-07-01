import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AutoVpnEvent } from '../events/schema.js';
import { resumeNodePipeline, retryNodePipelineStage, runNodePipeline } from '../pipeline/orchestrator.js';
import { resolveArtifactsRoot } from '../runtime/paths.js';
import {
  AutoVpnBackend,
  DetachedRunOptions,
  JobSummary,
  LogOptions,
  ResumeOptions,
  RetryOptions,
  RunOptions
} from './types.js';

const require = createRequire(import.meta.url);

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

function latestIncompleteRunArtifact(projectRoot: string, env: NodeJS.ProcessEnv): string | undefined {
  const artifactsRoot = resolveArtifactsRoot(projectRoot, env);
  if (!fs.existsSync(artifactsRoot)) {
    return undefined;
  }
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const candidates = fs.readdirSync(artifactsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const artifactDir = path.join(artifactsRoot, entry.name);
      const dbPath = path.join(artifactDir, 'run.db');
      return { artifactDir, dbPath };
    })
    .filter((candidate) => fs.existsSync(candidate.dbPath))
    .sort((left, right) => fs.statSync(right.artifactDir).mtimeMs - fs.statSync(left.artifactDir).mtimeMs);

  for (const candidate of candidates) {
    let db: import('node:sqlite').DatabaseSync | undefined;
    try {
      db = new DatabaseSync(candidate.dbPath);
      const runRow = db.prepare('SELECT status FROM runs ORDER BY run_id DESC LIMIT 1').get() as { status?: unknown } | undefined;
      const runStatus = String(runRow?.status ?? '').trim();
      if (['success', 'failed', 'stopped'].includes(runStatus)) {
        continue;
      }
      const stageRows = db.prepare('SELECT stage_name, status FROM stage_events ORDER BY rowid ASC').all() as Array<{ stage_name?: unknown; status?: unknown }>;
      const stageStatus = new Map(stageRows.map((row) => [String(row.stage_name ?? ''), String(row.status ?? '')]));
      if (stageStatus.get('verify') === 'success') {
        continue;
      }
      return candidate.artifactDir;
    } catch {
      continue;
    } finally {
      db?.close();
    }
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
    const queue: EventQueueState = { events: [], wake: [], done: false };
    const runner = options.resumeLatest
      ? async () => {
        const artifactDir = latestIncompleteRunArtifact(options.projectRoot, this.env);
        if (!artifactDir) {
          throw new Error('No incomplete run.db found to resume');
        }
        pushEvent(queue, { type: 'resume_latest_state', artifact_dir: artifactDir });
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
          emit: (event) => pushEvent(queue, event)
        });
      }
      : async () => runNodePipeline(options, {
        env: this.env,
        emit: (event) => pushEvent(queue, event)
      });
    void runner()
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
    void retryNodePipelineStage({
        projectRoot: options.projectRoot,
        artifactDir: options.artifactDir,
        stage: options.stage,
        output: options.output,
        eventLog: options.eventLog,
        humanLog: options.humanLog
      }, {
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

  async *resume(options: ResumeOptions): AsyncIterable<AutoVpnEvent> {
    const queue: EventQueueState = { events: [], wake: [], done: false };
    void resumeNodePipeline({
        projectRoot: options.projectRoot,
        mode: options.mode,
        session: options.session,
        output: options.output,
        eventLog: options.eventLog,
        humanLog: options.humanLog
      }, {
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
