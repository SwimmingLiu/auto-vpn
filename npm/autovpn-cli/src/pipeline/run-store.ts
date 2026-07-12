import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

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
  status: SourceStatus;
  error?: string;
}

export interface StoredProbeResult extends ProbeResult {
  error: string;
}

export interface StoredSpeedResult extends SpeedTestResult {
  error: string;
  status: SpeedStatus;
}

export interface AvailabilityStoreResult {
  link: string;
  all_passed: boolean;
  provider_results: Record<string, unknown>;
  error?: string;
}

export interface StoredAvailabilityResult extends AvailabilityStoreResult {
  error: string;
  status: AvailabilityStatus;
}

export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled' | 'stopped';
export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'stopped';
export type SourceStatus = Exclude<StageStatus, 'stopped'>;
export type SpeedStatus = 'pending' | 'running' | 'speed_passed' | 'speed_failed' | 'cancelled' | 'skipped';
export type AvailabilityStatus = 'pending' | 'running' | 'availability_passed' | 'availability_failed' | 'cancelled' | 'skipped';

const TERMINAL_STATUSES = new Set([
  'success', 'failed', 'cancelled', 'skipped', 'stopped',
  'speed_passed', 'speed_failed', 'availability_passed', 'availability_failed'
]);

function parseProviderResults(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function strictBoolean(value: unknown): boolean {
  return value === true || value === 1;
}

function readLegacyLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function readLegacyReport(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  const payload: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(payload) || payload.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`Invalid legacy report: ${path.basename(filePath)}`);
  }
  return payload as Array<Record<string, unknown>>;
}

export function readRunStatus(dbPath: string): string | undefined {
  if (!fs.existsSync(dbPath)) return undefined;
  let db: Database | undefined;
  try {
    db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT status FROM runs ORDER BY run_id DESC LIMIT 1').get() as { status?: unknown } | undefined;
    const status = String(row?.status ?? '').trim();
    return status || undefined;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* malformed or locked databases are ignored */ }
  }
}

export function readLatestStageStatuses(dbPath: string): Record<string, string> {
  if (!fs.existsSync(dbPath)) return {};
  let db: Database | undefined;
  try {
    db = new DatabaseSync(dbPath);
    const rows = db.prepare('SELECT stage_name, status FROM stage_events ORDER BY rowid').all() as Array<{ stage_name?: unknown; status?: unknown }>;
    return Object.fromEntries(rows.map((row) => [String(row.stage_name ?? ''), String(row.status ?? '')]).filter(([name]) => name));
  } catch {
    return {};
  } finally {
    try { db?.close(); } catch { /* malformed or locked databases are ignored */ }
  }
}

export class RunStore {
  private readonly statements = new Map<string, Statement>();
  private runId: number | undefined;
  private closed = false;

  private constructor(private readonly db: Database) {
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL CHECK (status IN ('pending','running','success','failed','cancelled','stopped')),
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS stage_events (
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        stage_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','running','success','failed','cancelled','skipped','stopped')),
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS source_progress (
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        processed INTEGER NOT NULL CHECK (processed >= 0 AND processed <= total),
        total INTEGER NOT NULL CHECK (total >= 0),
        status TEXT NOT NULL CHECK (status IN ('pending','running','success','failed','cancelled','skipped')),
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
        first_source TEXT,
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
        status TEXT NOT NULL CHECK (status IN ('pending','running','speed_passed','speed_failed','cancelled','skipped')),
        reachable INTEGER NOT NULL DEFAULT 0,
        average_download_mb_s REAL NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, canonical_key)
      );
      CREATE TABLE IF NOT EXISTS availability_results (
        run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        canonical_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','running','availability_passed','availability_failed','cancelled','skipped')),
        all_passed INTEGER NOT NULL DEFAULT 0,
        provider_results TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, canonical_key)
      );
    `);
    this.migrateSchema();
    const latest = this.db.prepare('SELECT run_id FROM runs ORDER BY run_id DESC LIMIT 1').get() as { run_id: number } | undefined;
    this.runId = latest?.run_id;
  }

  static open(filePath: string): RunStore {
    return new RunStore(new DatabaseSync(filePath));
  }

  static openOrImport(artifactDir: string): RunStore {
    const dbPath = path.join(artifactDir, 'run.db');
    if (fs.existsSync(dbPath)) {
      const store = RunStore.open(dbPath);
      try {
        const hasLegacyLinks = readLegacyLines(path.join(artifactDir, 'vpn_node_raw.txt')).length > 0
          || readLegacyLines(path.join(artifactDir, 'vpn_node_deduped.txt')).length > 0;
        if (store.counts().deduped === 0 && hasLegacyLinks) store.importLegacyArtifacts(artifactDir);
        return store;
      } catch (error) {
        store.close();
        throw error;
      }
    }
    const store = RunStore.open(dbPath);
    try {
      store.initializeRun('running');
      store.importLegacyArtifacts(artifactDir);
      return store;
    } catch (error) {
      store.close();
      try { fs.rmSync(dbPath, { force: true }); } catch { /* preserve the original import error */ }
      throw error;
    }
  }

  static seedRetry(sourceArtifactDir: string, destinationArtifactDir: string, boundary: string): RunStore {
    const source = RunStore.openOrImport(sourceArtifactDir);
    const dbPath = path.join(destinationArtifactDir, 'run.db');
    let destination: RunStore | undefined;
    try {
      destination = RunStore.open(dbPath);
      destination.transaction(() => {
        const inserted = destination!.statement('INSERT INTO runs(status) VALUES (?)').run('running');
        destination!.runId = Number(inserted.lastInsertRowid);
        const runId = destination!.currentRunId();
        for (const observation of source.rawObservations()) {
          destination!.statement('INSERT INTO raw_observations(run_id, source, link) VALUES (?, ?, ?)').run(runId, observation.source, observation.link);
        }
        source.dedupedNodeOwnership().forEach(({ link, first_source }, index) => {
          destination!.statement('INSERT INTO pipeline_nodes(run_id, canonical_key, link, sequence, first_source) VALUES (?, ?, ?, ?, ?)')
            .run(runId, canonicalVmessKey(parseVmessLink(link)), link, index + 1, first_source);
        });
        const preserveSpeed = boundary !== 'speedtest';
        const preserveAvailability = !['speedtest', 'availability'].includes(boundary);
        if (preserveSpeed) {
          for (const probe of source.probeResults()) destination!.recordProbe(probe);
          for (const result of source.speedResults().filter((row) => row.status === 'speed_passed' || row.status === 'speed_failed')) {
            destination!.recordSpeedResult(result, result.status === 'speed_passed');
          }
        }
        if (preserveAvailability) {
          for (const result of source.availabilityResults().filter((row) => row.status === 'availability_passed' || row.status === 'availability_failed')) {
            destination!.recordAvailabilityResult(result);
          }
        }
      });
      return destination;
    } catch (error) {
      destination?.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* preserve seed failure */ }
      }
      throw error;
    } finally {
      source.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  busyTimeout(): number {
    return Number((this.statement('PRAGMA busy_timeout').get() as { timeout: number }).timeout);
  }

  initializeRun(status: RunStatus = 'running'): number {
    const result = this.statement('INSERT INTO runs(status) VALUES (?)').run(status);
    this.runId = Number(result.lastInsertRowid);
    return this.runId;
  }

  setRunStatus(status: RunStatus, error = ''): void {
    const runId = this.currentRunId();
    try {
      this.statement(`UPDATE runs SET status = ?, error = ? WHERE run_id = ?
        AND status NOT IN ('success','failed','cancelled')`).run(status, redactText(error), runId);
    } catch (failure) {
      if (!(failure instanceof Error) || !/no such column: error/.test(failure.message)) throw failure;
      this.statement(`UPDATE runs SET status = ? WHERE run_id = ?
        AND status NOT IN ('success','failed','cancelled')`).run(status, runId);
    }
  }

  reopenForResume(): void {
    const runId = this.currentRunId();
    this.transaction(() => {
      this.statement("UPDATE runs SET status='running', error='' WHERE run_id=? AND status IN ('failed','cancelled','stopped')").run(runId);
      const failedStages = this.statement(`SELECT stage_name FROM stage_events e WHERE run_id=? AND status IN ('failed','stopped')
        AND rowid=(SELECT MAX(rowid) FROM stage_events x WHERE x.run_id=e.run_id AND x.stage_name=e.stage_name)`).all(runId) as Array<{ stage_name: string }>;
      for (const row of failedStages) {
        this.statement("INSERT INTO stage_events(run_id, stage_name, status, error) VALUES (?, ?, 'running', '')").run(runId, row.stage_name);
      }
    });
  }

  reopenSourcesForResume(sourceNames?: string[]): void {
    const runId = this.currentRunId();
    this.transaction(() => {
      if (sourceNames && sourceNames.length === 0) return;
      if (sourceNames) {
        const placeholders = sourceNames.map(() => '?').join(',');
        this.statement(`UPDATE source_progress SET status='pending', error='' WHERE run_id=?
          AND source IN (${placeholders}) AND status IN ('failed','cancelled')`).run(runId, ...sourceNames);
      } else {
        this.statement("UPDATE source_progress SET status='pending', error='' WHERE run_id=? AND status IN ('failed','cancelled')").run(runId);
      }
    });
  }

  resetSourceForRerun(source: string, total = 0): boolean {
    if (!Number.isInteger(total) || total < 0) throw new RangeError('source rerun total must be a non-negative integer');
    return this.transaction(() => Number(this.statement(`UPDATE source_progress SET processed=0, total=?, status='pending', error=''
      WHERE run_id=? AND source=? AND status NOT IN ('success','skipped')`).run(total, this.currentRunId(), source).changes) > 0);
  }

  stopForResume(error = 'Stopped by user'): boolean {
    const runId = this.currentRunId();
    return this.transaction(() => {
      const changed = Number(this.statement("UPDATE runs SET status='stopped', error=? WHERE run_id=? AND status IN ('pending','running')")
        .run(redactText(error), runId).changes) > 0;
      if (!changed) return false;
      const activeStages = this.statement(`SELECT stage_name FROM stage_events e WHERE run_id=? AND status='running'
        AND rowid=(SELECT MAX(rowid) FROM stage_events x WHERE x.run_id=e.run_id AND x.stage_name=e.stage_name)`).all(runId) as Array<{ stage_name: string }>;
      for (const { stage_name } of activeStages) {
        this.statement("INSERT INTO stage_events(run_id, stage_name, status, error) VALUES (?, ?, 'stopped', ?)")
          .run(runId, stage_name, redactText(error));
      }
      this.statement("UPDATE speed_results SET status='pending', error='' WHERE run_id=? AND status='running'").run(runId);
      this.statement("UPDATE availability_results SET status='pending', error='' WHERE run_id=? AND status='running'").run(runId);
      this.statement("UPDATE source_progress SET status='pending', error='' WHERE run_id=? AND status='running'").run(runId);
      return true;
    });
  }

  setStageStatus(stageName: string, status: StageStatus, error = ''): void {
    const runId = this.currentRunId();
    try {
      this.transaction(() => {
        const latest = this.statement('SELECT status FROM stage_events WHERE run_id = ? AND stage_name = ? ORDER BY rowid DESC LIMIT 1')
          .get(runId, stageName) as { status: string } | undefined;
        if (!latest || !TERMINAL_STATUSES.has(latest.status)) {
          this.statement('INSERT INTO stage_events(run_id, stage_name, status, error) VALUES (?, ?, ?, ?)')
            .run(runId, stageName, status, redactText(error));
        }
      });
    } catch (failure) {
      if (!(failure instanceof Error) || !/no such column: run_id/.test(failure.message)) throw failure;
      const latest = this.statement('SELECT status FROM stage_events WHERE stage_name = ? ORDER BY rowid DESC LIMIT 1')
        .get(stageName) as { status: string } | undefined;
      if (!latest || !TERMINAL_STATUSES.has(latest.status)) {
        this.statement('INSERT INTO stage_events(stage_name, status) VALUES (?, ?)').run(stageName, status);
      }
    }
  }

  recordSourceProgress(source: string, progress: SourceProgressInput): void {
    if (!Number.isInteger(progress.processed) || !Number.isInteger(progress.total) || progress.processed < 0 || progress.total < 0 || progress.processed > progress.total) {
      throw new RangeError('source progress requires integer values with 0 <= processed <= total');
    }
    this.statement(`INSERT INTO source_progress(run_id, source, processed, total, status, error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, source) DO UPDATE SET
        processed=excluded.processed, total=excluded.total, status=excluded.status, error=excluded.error
      WHERE excluded.processed >= source_progress.processed
        AND excluded.total >= source_progress.total
        AND source_progress.status NOT IN ('success','failed','cancelled','skipped')`)
      .run(this.currentRunId(), source, progress.processed, progress.total, progress.status, redactText(progress.error ?? ''));
  }

  sourceProgress(): Array<{ source: string; processed: number; total: number; status: string; error: string }> {
    const rows = this.statement('SELECT source, processed, total, status, error FROM source_progress WHERE run_id = ? ORDER BY rowid')
      .all(this.currentRunId()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ source: String(row.source), processed: Number(row.processed), total: Number(row.total), status: String(row.status), error: String(row.error) }));
  }

  incompleteSourceProgress(): Array<{ source: string; processed: number; total: number; status: string; error: string }> {
    return this.sourceProgress().filter((row) => !['success', 'skipped'].includes(row.status));
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
      this.statement('INSERT INTO pipeline_nodes(run_id, canonical_key, link, sequence, first_source) VALUES (?, ?, ?, ?, ?)')
        .run(runId, key, link, row.sequence, source);
      return { inserted: true, sequence: row.sequence };
    });
  }

  rawLinks(): string[] {
    return (this.statement('SELECT link FROM raw_observations WHERE run_id = ? ORDER BY observation_id').all(this.currentRunId()) as Array<{ link: string }>).map((row) => row.link);
  }

  rawLinksForSource(source: string): string[] {
    return (this.statement('SELECT link FROM raw_observations WHERE run_id = ? AND source = ? ORDER BY observation_id')
      .all(this.currentRunId(), source) as Array<{ link: string }>).map((row) => row.link);
  }

  dedupedLinks(): string[] {
    return (this.statement('SELECT link FROM pipeline_nodes WHERE run_id = ? ORDER BY sequence').all(this.currentRunId()) as Array<{ link: string }>).map((row) => row.link);
  }

  sourceDedupedCounts(): Record<string, number> {
    const rows = this.statement(`SELECT first_source AS source, COUNT(*) AS count FROM pipeline_nodes
      WHERE run_id = ? AND first_source IS NOT NULL GROUP BY first_source ORDER BY MIN(sequence)`)
      .all(this.currentRunId()) as Array<{ source: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.source, Number(row.count)]));
  }

  hasCompleteSourceOwnership(): boolean {
    const row = this.statement(`SELECT NOT EXISTS(
      SELECT 1 FROM pipeline_nodes WHERE run_id = ? AND first_source IS NULL
    ) AS complete`).get(this.currentRunId()) as { complete: number };
    return Boolean(row.complete);
  }

  sourceRawCounts(): Record<string, number> {
    const rows = this.statement(`SELECT source, COUNT(*) AS count FROM raw_observations
      WHERE run_id = ? GROUP BY source ORDER BY MIN(observation_id)`)
      .all(this.currentRunId()) as Array<{ source: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.source, Number(row.count)]));
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
    return rows.map((row) => ({ link: String(row.link), reachable: Boolean(row.reachable), average_download_mb_s: Number(row.average_download_mb_s), latency_ms: Number(row.latency_ms), error: String(row.error), status: String(row.status) as SpeedStatus }));
  }

  speedLinksNeedingWork(): string[] {
    return (this.statement(`SELECT n.link FROM pipeline_nodes n
      LEFT JOIN speed_results s ON s.run_id=n.run_id AND s.canonical_key=n.canonical_key
      WHERE n.run_id=? AND (s.status IS NULL OR s.status IN ('pending','running')) ORDER BY n.sequence`)
      .all(this.currentRunId()) as Array<{ link: string }>).map((row) => row.link);
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
    const passed = strictBoolean(result.all_passed) && !error;
    const status = passed ? 'availability_passed' : 'availability_failed';
    this.statement(`INSERT INTO availability_results(run_id, canonical_key, status, all_passed, provider_results, error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, canonical_key) DO UPDATE SET status=excluded.status, all_passed=excluded.all_passed,
        provider_results=excluded.provider_results, error=excluded.error
      WHERE availability_results.status NOT IN ('availability_passed','availability_failed','cancelled','skipped')`)
      .run(runId, key, status, Number(passed), JSON.stringify(result.provider_results), error);
  }

  availabilityResults(): StoredAvailabilityResult[] {
    const rows = this.statement(`SELECT n.link, a.status, a.all_passed, a.provider_results, a.error FROM availability_results a
      JOIN pipeline_nodes n ON n.run_id=a.run_id AND n.canonical_key=a.canonical_key
      WHERE a.run_id=? ORDER BY n.sequence`).all(this.currentRunId()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ link: String(row.link), all_passed: Boolean(row.all_passed), provider_results: parseProviderResults(row.provider_results), error: String(row.error), status: String(row.status) as AvailabilityStatus }));
  }

  availabilityLinksNeedingWork(): string[] {
    return (this.statement(`SELECT n.link FROM pipeline_nodes n
      JOIN speed_results s ON s.run_id=n.run_id AND s.canonical_key=n.canonical_key AND s.status='speed_passed'
      LEFT JOIN availability_results a ON a.run_id=n.run_id AND a.canonical_key=n.canonical_key
      WHERE n.run_id=? AND (a.status IS NULL OR a.status IN ('pending','running')) ORDER BY n.sequence`)
      .all(this.currentRunId()) as Array<{ link: string }>).map((row) => row.link);
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

  classifySpeedResults(minDownloadMbS: number): void {
    this.statement(`UPDATE speed_results SET status = CASE
      WHEN reachable = 1 AND average_download_mb_s >= ? AND error = '' THEN 'speed_passed'
      ELSE 'speed_failed' END
      WHERE run_id = ? AND status IN ('speed_passed','speed_failed')`)
      .run(minDownloadMbS, this.currentRunId());
  }

  private importLegacyArtifacts(artifactDir: string): void {
    const runId = this.currentRunId();
    const rawLinks = readLegacyLines(path.join(artifactDir, 'vpn_node_raw.txt'));
    const dedupedLinks = readLegacyLines(path.join(artifactDir, 'vpn_node_deduped.txt'));
    const speedRows = readLegacyReport(path.join(artifactDir, 'vpn_node_speedtest_report.json'));
    const availabilityRows = readLegacyReport(path.join(artifactDir, 'vpn_node_availability_report.json'));
    this.transaction(() => {
      const rawCanonicalKeys = new Set<string>();
      for (const link of rawLinks) {
        rawCanonicalKeys.add(canonicalVmessKey(parseVmessLink(link)));
        this.statement('INSERT INTO raw_observations(run_id, source, link) VALUES (?, ?, ?)').run(runId, 'legacy', link);
      }
      const nodeLinks = dedupedLinks.length > 0 ? dedupedLinks : rawLinks;
      const seen = new Set<string>();
      for (const link of nodeLinks) {
        const key = canonicalVmessKey(parseVmessLink(link));
        if (seen.has(key)) continue;
        seen.add(key);
        this.statement('INSERT INTO pipeline_nodes(run_id, canonical_key, link, sequence, first_source) VALUES (?, ?, ?, ?, ?)')
          .run(runId, key, link, seen.size, rawCanonicalKeys.has(key) ? 'legacy' : null);
      }
      for (const row of speedRows) {
        const link = String(row.link ?? '');
        const key = canonicalVmessKey(parseVmessLink(link));
        if (!seen.has(key)) throw new Error('Legacy speed report references an unknown link');
        const reachable = Boolean(row.reachable);
        this.statement(`INSERT INTO speed_results(run_id, canonical_key, status, reachable, average_download_mb_s, latency_ms, error)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(runId, key, reachable && Number(row.average_download_mb_s ?? 0) > 0 ? 'speed_passed' : 'speed_failed', Number(reachable), Number(row.average_download_mb_s ?? 0), Number(row.latency_ms ?? 0), redactText(String(row.error ?? '')));
      }
      for (const row of availabilityRows) {
        const link = String(row.link ?? '');
        const key = canonicalVmessKey(parseVmessLink(link));
        if (!seen.has(key)) throw new Error('Legacy availability report references an unknown link');
        const error = redactText(String(row.error ?? ''));
        const allPassed = strictBoolean(row.all_passed) && !error;
        this.statement(`INSERT INTO availability_results(run_id, canonical_key, status, all_passed, provider_results, error)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(runId, key, allPassed ? 'availability_passed' : 'availability_failed', Number(allPassed), JSON.stringify(row.provider_results ?? {}), error);
      }
    });
  }

  private nodeIdentity(link: string): { runId: number; key: string } {
    const runId = this.currentRunId();
    const key = canonicalVmessKey(parseVmessLink(link));
    const exists = this.statement('SELECT 1 AS found FROM pipeline_nodes WHERE run_id = ? AND canonical_key = ?').get(runId, key);
    if (!exists) throw new Error('unknown pipeline node');
    return { runId, key };
  }

  private rawObservations(): Array<{ source: string; link: string }> {
    return this.statement('SELECT source, link FROM raw_observations WHERE run_id = ? ORDER BY observation_id')
      .all(this.currentRunId()) as Array<{ source: string; link: string }>;
  }

  private dedupedNodeOwnership(): Array<{ link: string; first_source: string | null }> {
    return this.statement('SELECT link, first_source FROM pipeline_nodes WHERE run_id = ? ORDER BY sequence')
      .all(this.currentRunId()) as Array<{ link: string; first_source: string | null }>;
  }

  private migrateSchema(): void {
    const columns = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!columns('runs').has('error')) this.db.exec("ALTER TABLE runs ADD COLUMN error TEXT NOT NULL DEFAULT ''");
      if (!columns('pipeline_nodes').has('first_source')) {
        this.db.exec('ALTER TABLE pipeline_nodes ADD COLUMN first_source TEXT');
        const earliestSources = new Map<string, string>();
        const observations = this.db.prepare('SELECT run_id, source, link FROM raw_observations ORDER BY run_id, observation_id')
          .all() as Array<{ run_id: number; source: string; link: string }>;
        for (const observation of observations) {
          try {
            const identity = `${observation.run_id}\0${canonicalVmessKey(parseVmessLink(observation.link))}`;
            if (!earliestSources.has(identity)) earliestSources.set(identity, observation.source);
          } catch {
            // Historical malformed observations cannot establish canonical ownership.
          }
        }
        const nodes = this.db.prepare('SELECT node_id, run_id, canonical_key FROM pipeline_nodes ORDER BY run_id, sequence')
          .all() as Array<{ node_id: number; run_id: number; canonical_key: string }>;
        const update = this.db.prepare('UPDATE pipeline_nodes SET first_source = ? WHERE node_id = ? AND first_source IS NULL');
        for (const node of nodes) {
          const source = earliestSources.get(`${node.run_id}\0${node.canonical_key}`);
          if (source !== undefined) update.run(source, node.node_id);
        }
      }
      const stageColumns = columns('stage_events');
      if (!stageColumns.has('run_id')) {
        this.db.exec('ALTER TABLE stage_events ADD COLUMN run_id INTEGER');
        this.db.exec('UPDATE stage_events SET run_id=(SELECT run_id FROM runs ORDER BY run_id DESC LIMIT 1) WHERE run_id IS NULL');
      }
      if (!stageColumns.has('error')) this.db.exec("ALTER TABLE stage_events ADD COLUMN error TEXT NOT NULL DEFAULT ''");
      const schemaRows = this.db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name IN ('runs','stage_events')").all() as Array<{ name: string; sql: string }>;
      const needsStoppedMigration = schemaRows.some((row) => !row.sql.includes("'stopped'"));
      if (needsStoppedMigration) {
        this.db.exec(`
          ALTER TABLE stage_events RENAME TO stage_events_v1;
          CREATE TABLE stage_events (
            run_id INTEGER NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
            stage_name TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending','running','success','failed','cancelled','skipped','stopped')),
            error TEXT NOT NULL DEFAULT ''
          );
          INSERT INTO stage_events(run_id,stage_name,status,error) SELECT run_id,stage_name,status,error FROM stage_events_v1;
          DROP TABLE stage_events_v1;
          ALTER TABLE runs RENAME TO runs_v1;
          CREATE TABLE runs (
            run_id INTEGER PRIMARY KEY AUTOINCREMENT,
            status TEXT NOT NULL CHECK (status IN ('pending','running','success','failed','cancelled','stopped')),
            error TEXT NOT NULL DEFAULT ''
          );
          INSERT INTO runs(run_id,status,error) SELECT run_id,status,error FROM runs_v1;
          DROP TABLE runs_v1;
        `);
      }
      this.db.exec('PRAGMA user_version=3; COMMIT');
      this.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');
      throw error;
    }
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
