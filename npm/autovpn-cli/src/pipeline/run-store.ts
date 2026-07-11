import { createRequire } from 'node:module';

import { redactText } from '../runtime/redaction.js';
import { canonicalVmessKey, parseVmessLink } from './dedupe.js';
import type { ProbeResult, SpeedTestResult } from './speedtest.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

type Database = import('node:sqlite').DatabaseSync;
type Statement = import('node:sqlite').StatementSync;

export interface SourceProgressInput {
  processed: number;
  total: number;
  status: string;
  error?: string;
}

export interface StoredProbeResult extends ProbeResult {
  error: string;
}

export interface StoredSpeedResult extends SpeedTestResult {
  error: string;
  status: string;
}

export interface AvailabilityStoreResult {
  link: string;
  all_passed: boolean;
  provider_results: Record<string, unknown>;
  error?: string;
}

export interface StoredAvailabilityResult extends AvailabilityStoreResult {
  error: string;
  status: string;
}

const TERMINAL_STATUSES = new Set([
  'success', 'failed', 'cancelled', 'skipped',
  'speed_passed', 'speed_failed', 'availability_passed', 'availability_failed'
]);

export class RunStore {
  private readonly statements = new Map<string, Statement>();
  private runId: number | undefined;

  private constructor(private readonly db: Database) {
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS stage_events (
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        stage_name TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS source_progress (
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        processed INTEGER NOT NULL,
        total INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, source)
      );
      CREATE TABLE IF NOT EXISTS raw_observations (
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        link TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pipeline_nodes (
        node_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        canonical_key TEXT NOT NULL,
        link TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        UNIQUE (run_id, canonical_key),
        UNIQUE (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS probe_results (
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        canonical_key TEXT NOT NULL,
        reachable INTEGER NOT NULL,
        latency_ms REAL NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, canonical_key)
      );
      CREATE TABLE IF NOT EXISTS speed_results (
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        canonical_key TEXT NOT NULL,
        status TEXT NOT NULL,
        reachable INTEGER NOT NULL DEFAULT 0,
        average_download_mb_s REAL NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, canonical_key)
      );
      CREATE TABLE IF NOT EXISTS availability_results (
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        canonical_key TEXT NOT NULL,
        status TEXT NOT NULL,
        all_passed INTEGER NOT NULL DEFAULT 0,
        provider_results TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, canonical_key)
      );
    `);
    const latest = this.db.prepare('SELECT run_id FROM runs ORDER BY run_id DESC LIMIT 1').get() as { run_id: number } | undefined;
    this.runId = latest?.run_id;
  }

  static open(filePath: string): RunStore {
    return new RunStore(new DatabaseSync(filePath));
  }

  close(): void {
    this.db.close();
  }

  busyTimeout(): number {
    return Number((this.statement('PRAGMA busy_timeout').get() as { timeout: number }).timeout);
  }

  initializeRun(status = 'running'): number {
    const result = this.statement('INSERT INTO runs(status) VALUES (?)').run(status);
    this.runId = Number(result.lastInsertRowid);
    return this.runId;
  }

  setRunStatus(status: string, error = ''): void {
    const runId = this.currentRunId();
    const current = this.statement('SELECT status FROM runs WHERE run_id = ?').get(runId) as { status: string };
    if (TERMINAL_STATUSES.has(current.status)) return;
    this.statement('UPDATE runs SET status = ?, error = ? WHERE run_id = ?').run(status, redactText(error), runId);
  }

  setStageStatus(stageName: string, status: string, error = ''): void {
    const runId = this.currentRunId();
    const latest = this.statement('SELECT status FROM stage_events WHERE run_id = ? AND stage_name = ? ORDER BY rowid DESC LIMIT 1')
      .get(runId, stageName) as { status: string } | undefined;
    if (latest && TERMINAL_STATUSES.has(latest.status)) return;
    this.statement('INSERT INTO stage_events(run_id, stage_name, status, error) VALUES (?, ?, ?, ?)')
      .run(runId, stageName, status, redactText(error));
  }

  recordSourceProgress(source: string, progress: SourceProgressInput): void {
    this.statement(`INSERT INTO source_progress(run_id, source, processed, total, status, error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, source) DO UPDATE SET
        processed=excluded.processed, total=excluded.total, status=excluded.status, error=excluded.error`)
      .run(this.currentRunId(), source, progress.processed, progress.total, progress.status, redactText(progress.error ?? ''));
  }

  sourceProgress(): Array<{ source: string; processed: number; total: number; status: string; error: string }> {
    const rows = this.statement('SELECT source, processed, total, status, error FROM source_progress WHERE run_id = ? ORDER BY rowid')
      .all(this.currentRunId()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ source: String(row.source), processed: Number(row.processed), total: Number(row.total), status: String(row.status), error: String(row.error) }));
  }

  recordExtractedNode(source: string, link: string): { inserted: boolean; sequence: number } {
    const runId = this.currentRunId();
    const key = canonicalVmessKey(parseVmessLink(link));
    return this.transaction(() => {
      this.statement('INSERT INTO raw_observations(run_id, source, link) VALUES (?, ?, ?)').run(runId, source, link);
      const existing = this.statement('SELECT sequence FROM pipeline_nodes WHERE run_id = ? AND canonical_key = ?')
        .get(runId, key) as { sequence: number } | undefined;
      if (existing) return { inserted: false, sequence: existing.sequence };
      const row = this.statement('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM pipeline_nodes WHERE run_id = ?')
        .get(runId) as { sequence: number };
      this.statement('INSERT INTO pipeline_nodes(run_id, canonical_key, link, sequence) VALUES (?, ?, ?, ?)')
        .run(runId, key, link, row.sequence);
      return { inserted: true, sequence: row.sequence };
    });
  }

  rawLinks(): string[] {
    return (this.statement('SELECT link FROM raw_observations WHERE run_id = ? ORDER BY observation_id').all(this.currentRunId()) as Array<{ link: string }>).map((row) => row.link);
  }

  dedupedLinks(): string[] {
    return (this.statement('SELECT link FROM pipeline_nodes WHERE run_id = ? ORDER BY sequence').all(this.currentRunId()) as Array<{ link: string }>).map((row) => row.link);
  }

  markSpeedRunning(link: string): void {
    const { runId, key } = this.nodeIdentity(link);
    this.statement(`INSERT INTO speed_results(run_id, canonical_key, status) VALUES (?, ?, 'running')
      ON CONFLICT(run_id, canonical_key) DO UPDATE SET status='running'
      WHERE speed_results.status NOT IN ('success','failed','speed_passed','speed_failed','cancelled','skipped')`).run(runId, key);
  }

  recordProbe(result: ProbeResult): void {
    const { runId, key } = this.nodeIdentity(result.link);
    this.statement(`INSERT INTO probe_results(run_id, canonical_key, reachable, latency_ms, error) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, canonical_key) DO UPDATE SET reachable=excluded.reachable, latency_ms=excluded.latency_ms, error=excluded.error`)
      .run(runId, key, Number(result.reachable), result.latency_ms, redactText(result.error ?? ''));
  }

  recordSpeedResult(result: SpeedTestResult, passed: boolean): void {
    const { runId, key } = this.nodeIdentity(result.link);
    this.statement(`INSERT INTO speed_results(run_id, canonical_key, status, reachable, average_download_mb_s, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, canonical_key) DO UPDATE SET status=excluded.status, reachable=excluded.reachable,
        average_download_mb_s=excluded.average_download_mb_s, latency_ms=excluded.latency_ms, error=excluded.error
      WHERE speed_results.status NOT IN ('speed_passed','speed_failed','cancelled','skipped')`)
      .run(runId, key, passed ? 'speed_passed' : 'speed_failed', Number(result.reachable), result.average_download_mb_s, result.latency_ms, redactText(result.error ?? ''));
  }

  probeResults(): StoredProbeResult[] {
    const rows = this.statement(`SELECT n.link, p.reachable, p.latency_ms, p.error FROM probe_results p
      JOIN pipeline_nodes n ON n.run_id=p.run_id AND n.canonical_key=p.canonical_key
      WHERE p.run_id=? ORDER BY n.sequence`).all(this.currentRunId()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ link: String(row.link), reachable: Boolean(row.reachable), latency_ms: Number(row.latency_ms), error: String(row.error) }));
  }

  speedResults(): StoredSpeedResult[] {
    const rows = this.statement(`SELECT n.link, s.status, s.reachable, s.average_download_mb_s, s.latency_ms, s.error FROM speed_results s
      JOIN pipeline_nodes n ON n.run_id=s.run_id AND n.canonical_key=s.canonical_key
      WHERE s.run_id=? ORDER BY n.sequence`).all(this.currentRunId()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ link: String(row.link), reachable: Boolean(row.reachable), average_download_mb_s: Number(row.average_download_mb_s), latency_ms: Number(row.latency_ms), error: String(row.error), status: String(row.status) }));
  }

  markAvailabilityRunning(link: string): void {
    const { runId, key } = this.nodeIdentity(link);
    this.statement(`INSERT INTO availability_results(run_id, canonical_key, status) VALUES (?, ?, 'running')
      ON CONFLICT(run_id, canonical_key) DO UPDATE SET status='running'
      WHERE availability_results.status NOT IN ('success','failed','availability_passed','availability_failed','cancelled','skipped')`).run(runId, key);
  }

  recordAvailabilityResult(result: AvailabilityStoreResult): void {
    const { runId, key } = this.nodeIdentity(result.link);
    const error = redactText(result.error ?? '');
    const status = result.all_passed && !error ? 'availability_passed' : 'availability_failed';
    this.statement(`INSERT INTO availability_results(run_id, canonical_key, status, all_passed, provider_results, error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, canonical_key) DO UPDATE SET status=excluded.status, all_passed=excluded.all_passed,
        provider_results=excluded.provider_results, error=excluded.error
      WHERE availability_results.status NOT IN ('availability_passed','availability_failed','cancelled','skipped')`)
      .run(runId, key, status, Number(result.all_passed), JSON.stringify(result.provider_results), error);
  }

  availabilityResults(): StoredAvailabilityResult[] {
    const rows = this.statement(`SELECT n.link, a.status, a.all_passed, a.provider_results, a.error FROM availability_results a
      JOIN pipeline_nodes n ON n.run_id=a.run_id AND n.canonical_key=a.canonical_key
      WHERE a.run_id=? ORDER BY n.sequence`).all(this.currentRunId()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ link: String(row.link), all_passed: Boolean(row.all_passed), provider_results: JSON.parse(String(row.provider_results)) as Record<string, unknown>, error: String(row.error), status: String(row.status) }));
  }

  counts(): { raw: number; deduped: number; probes: number; speed: number; availability: number } {
    const runId = this.currentRunId();
    const count = (table: string): number => Number((this.statement(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`).get(runId) as { count: number }).count);
    return { raw: count('raw_observations'), deduped: count('pipeline_nodes'), probes: count('probe_results'), speed: count('speed_results'), availability: count('availability_results') };
  }

  resetInterruptedRunning(): { speed: string[]; availability: string[] } {
    const runId = this.currentRunId();
    return this.transaction(() => {
      const links = (table: string): string[] => (this.statement(`SELECT n.link FROM ${table} r JOIN pipeline_nodes n ON n.run_id=r.run_id AND n.canonical_key=r.canonical_key WHERE r.run_id=? AND r.status='running' ORDER BY n.sequence`).all(runId) as Array<{ link: string }>).map((row) => row.link);
      const speed = links('speed_results');
      const availability = links('availability_results');
      this.statement("UPDATE speed_results SET status='pending' WHERE run_id=? AND status='running'").run(runId);
      this.statement("UPDATE availability_results SET status='pending' WHERE run_id=? AND status='running'").run(runId);
      return { speed, availability };
    });
  }

  private nodeIdentity(link: string): { runId: number; key: string } {
    return { runId: this.currentRunId(), key: canonicalVmessKey(parseVmessLink(link)) };
  }

  private currentRunId(): number {
    if (this.runId === undefined) throw new Error('RunStore.initializeRun() must be called first');
    return this.runId;
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
