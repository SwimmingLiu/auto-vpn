/**
 * Account pool: the credentials every official-site login draws from.
 *
 * SQLite rather than a profile section, for three reasons the profile cannot
 * serve: the pool is written by the pipeline while a run is in flight (usage
 * counters, failure marks), it outlives any one profile, and it has to answer
 * "how many usable accounts does brand X have" without parsing TOML.
 *
 * Retired accounts are soft-deleted. The row stays so the history and the
 * `(brand, account)` uniqueness survive a re-import, but `deleted_at` takes it
 * out of rotation permanently until an operator revives it.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { resolveUserRuntimeRoot } from '../runtime/paths.js';
import { brandSite, normalizeBrand, type BrandKey } from './brands.js';
import { RETIRED_STATUSES, normalizeExpiry, type AccountRecord, type AccountStatus } from './csv.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

type Database = import('node:sqlite').DatabaseSync;

export function resolveAccountsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.VPN_AUTOMATION_ACCOUNTS_DB ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveUserRuntimeRoot(env), 'accounts.db');
}

/** Full row, secrets included. Never returned by a list or stats call. */
export interface StoredAccount extends AccountRecord {
  id: number;
  status_reason: string;
  created_at: string;
  updated_at: string;
  last_used_at: string;
  use_count: number;
  success_count: number;
  fail_count: number;
  deleted_at: string | null;
}

/**
 * What the UI and `accounts list` are allowed to see.
 *
 * The password is absent by construction, not blanked at the edge: a display
 * path that never reads the column cannot leak it into a log or a screenshot.
 */
export interface PublicAccount {
  id: number;
  brand: BrandKey;
  account_masked: string;
  official_site: string;
  expires_at: string;
  status: AccountStatus;
  status_reason: string;
  note: string;
  created_at: string;
  updated_at: string;
  last_used_at: string;
  use_count: number;
  success_count: number;
  fail_count: number;
  deleted: boolean;
}

export interface PoolBrandStats {
  brand: BrandKey;
  total: number;
  active: number;
  disabled: number;
  expired: number;
  invalid: number;
}

export interface PoolStats {
  total: number;
  active: number;
  disabled: number;
  expired: number;
  invalid: number;
  deleted: number;
  expiring_soon: number;
  by_brand: PoolBrandStats[];
  db_path: string;
}

export interface ImportOutcome {
  inserted: number;
  updated: number;
  /** Rows whose password changed: the operator supplied a rotation. */
  rotated: number;
  /** Rows brought back from a soft delete by the import. */
  revived: number;
  unchanged: number;
  skipped: number;
}

export interface ListFilter {
  brand?: BrandKey | string;
  status?: AccountStatus | 'all';
  includeDeleted?: boolean;
  query?: string;
  limit?: number;
}

/** Keep the first and last character; a 6-char account still reads as itself. */
export function maskAccount(value: string): string {
  const text = String(value ?? '');
  if (text.length <= 2) return '*'.repeat(text.length);
  if (text.length <= 4) return `${text[0]}${'*'.repeat(text.length - 2)}${text[text.length - 1]}`;
  return `${text.slice(0, 2)}${'*'.repeat(Math.min(6, text.length - 4))}${text.slice(-2)}`;
}

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Today as the operator's local calendar day.
 *
 * A membership `expires_at` is a calendar date the vendor states, not an
 * instant, so it must be compared against the local day: with the UTC day, an
 * account that lapsed yesterday evening Beijing time is still leaseable until
 * 08:00 the next morning.
 */
function isoDay(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  account TEXT NOT NULL,
  password TEXT NOT NULL,
  official_site TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  status_reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT '',
  use_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  UNIQUE (brand, account)
);
CREATE INDEX IF NOT EXISTS accounts_rotation ON accounts (brand, status, deleted_at, last_used_at);
CREATE TABLE IF NOT EXISTS pool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS pool_events_account ON pool_events (account_id, id);
`;

export interface AccountStoreOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * Suppress every implicit write.
   *
   * `accounts import --dry-run` is documented as read-only, but the getters
   * sweep expired rows, so opening a writable store would still flip statuses
   * and append events before the preview. A preview connection must not write.
   */
  readOnly?: boolean;
}

export class AccountStore {
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly readOnly: boolean;
  readonly dbPath: string;

  constructor(options: AccountStoreOptions = {}) {
    this.dbPath = options.dbPath ?? resolveAccountsDbPath(options.env ?? process.env);
    this.now = options.now ?? (() => new Date());
    this.readOnly = options.readOnly === true;
    const inMemory = this.dbPath === ':memory:';
    if (!inMemory) {
      // The pool holds plaintext credentials in the main file *and* in the WAL
      // while it is open. Create the directory owner-only, and create the
      // database plus its sidecars under a restrictive umask so a world-readable
      // `-wal` never appears in the first place. The umask is restored before
      // anything else in the process runs.
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    }
    const previousUmask = inMemory ? null : process.umask(0o077);
    try {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.db.exec(SCHEMA);
    } finally {
      if (previousUmask !== null) process.umask(previousUmask);
    }
    if (!inMemory) {
      // A file created by an older build, or by an operator's editor, may still
      // be world-readable. The sidecars persist for the life of the connection,
      // so tightening them here holds until the next open.
      for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
        try {
          fs.chmodSync(file, 0o600);
        } catch {
          // A read-only mount or a non-POSIX host still gets a working pool.
        }
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private event(accountId: number, kind: string, detail = ''): void {
    this.db
      .prepare('INSERT INTO pool_events (account_id, at, kind, detail) VALUES (?, ?, ?, ?)')
      .run(accountId, isoNow(this.now()), kind, detail);
  }

  /**
   * Retire accounts whose membership date has passed.
   *
   * Runs before every read that decides rotation, so an account expires
   * without anyone having to notice: the date in the file is the source of
   * truth and the pool enforces it.
   */
  expireDue(): number {
    if (this.readOnly) return 0;
    const today = isoDay(this.now());
    const due = this.db
      .prepare(
        `SELECT id FROM accounts
         WHERE deleted_at IS NULL AND status = 'active' AND expires_at != '' AND expires_at < ?`
      )
      .all(today) as Array<{ id: number }>;
    if (due.length === 0) return 0;
    const stamp = isoNow(this.now());
    const mark = this.db.prepare(
      `UPDATE accounts SET status = 'expired', status_reason = 'membership expired', deleted_at = ?, updated_at = ? WHERE id = ?`
    );
    for (const row of due) {
      mark.run(stamp, stamp, row.id);
      this.event(row.id, 'expired', 'membership expired');
    }
    return due.length;
  }

  /**
   * Insert or refresh rows from an import file.
   *
   * An import is the operator asserting current truth, so a changed password
   * updates the row and revives it. That is deliberately different from the
   * runtime path (`markInvalid`), where a rejected login retires the row: one
   * is "here is the new password", the other is "the stored one no longer works".
   */
  importRecords(records: readonly AccountRecord[]): ImportOutcome {
    const outcome: ImportOutcome = { inserted: 0, updated: 0, rotated: 0, revived: 0, unchanged: 0, skipped: 0 };
    const stamp = isoNow(this.now());
    const find = this.db.prepare('SELECT * FROM accounts WHERE brand = ? AND account = ?');
    const insert = this.db.prepare(
      `INSERT INTO accounts (brand, account, password, official_site, expires_at, status, note, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const update = this.db.prepare(
      `UPDATE accounts SET password = ?, official_site = ?, expires_at = ?, status = ?, note = ?,
       status_reason = '', updated_at = ?, deleted_at = ? WHERE id = ?`
    );

    // IMMEDIATE takes the write lock up front. A deferred BEGIN reads first and
    // then fails instantly with 'database is locked' when another process (a
    // running pipeline, a second UI import) committed in between; that path
    // never consults busy_timeout.
    if (!this.readOnly) this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        const brand = normalizeBrand(record.brand);
        if (!brand || !record.account || !record.password) {
          outcome.skipped += 1;
          continue;
        }
        const existing = find.get(brand, record.account) as StoredAccount | undefined;
        const retired = RETIRED_STATUSES.includes(record.status);
        if (!existing) {
          const deletedAt = retired ? stamp : null;
          outcome.inserted += 1;
          if (this.readOnly) continue;
          const result = insert.run(
            brand,
            record.account,
            record.password,
            record.official_site || brandSite(brand),
            record.expires_at,
            record.status,
            record.note,
            stamp,
            stamp,
            deletedAt
          );
          this.event(Number(result.lastInsertRowid), 'imported', record.status);
          continue;
        }
        const rotated = existing.password !== record.password;
        // A column the file omits is "not specified", not "clear it". The
        // template advertises a 3-column CSV, and treating its empty cells as
        // erasures would wipe a known expiry (so the row could never expire
        // again) and the note on every password rotation.
        const expiresAt = record.expires_at || existing.expires_at;
        const note = record.note || existing.note;
        const officialSite = record.official_site || existing.official_site || brandSite(brand);
        const revived = existing.deleted_at !== null && !retired;
        // A stale expiry in the file (or the one already stored) still retires
        // the row: un-retiring an account whose membership lapsed would put a
        // dead credential back into rotation on every re-import.
        const expiredByDate = !retired && Boolean(expiresAt) && expiresAt < isoDay(this.now());
        const status = expiredByDate ? 'expired' : record.status;
        const deletedAt = RETIRED_STATUSES.includes(status) ? stamp : null;
        const changed =
          rotated ||
          revived ||
          expiredByDate ||
          existing.status !== status ||
          existing.expires_at !== expiresAt ||
          existing.official_site !== officialSite ||
          existing.note !== note;
        if (!changed) {
          outcome.unchanged += 1;
          continue;
        }
        outcome.updated += 1;
        if (rotated) outcome.rotated += 1;
        if (revived && !expiredByDate) outcome.revived += 1;
        if (this.readOnly) continue;
        update.run(
          record.password,
          officialSite,
          expiresAt,
          status,
          note,
          stamp,
          deletedAt,
          existing.id
        );
        this.event(existing.id, rotated ? 'rotated' : 'updated', record.status);
      }
      if (!this.readOnly) this.db.exec('COMMIT');
    } catch (error) {
      if (!this.readOnly) this.db.exec('ROLLBACK');
      throw error;
    }
    return outcome;
  }

  private toPublic(row: StoredAccount): PublicAccount {
    return {
      id: row.id,
      brand: row.brand,
      account_masked: maskAccount(row.account),
      official_site: row.official_site,
      expires_at: row.expires_at,
      status: row.status,
      status_reason: row.status_reason,
      note: row.note,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_used_at: row.last_used_at,
      use_count: row.use_count,
      success_count: row.success_count,
      fail_count: row.fail_count,
      deleted: row.deleted_at !== null
    };
  }

  /** Masked rows for the UI and `accounts list`. Never carries a password. */
  list(filter: ListFilter = {}): PublicAccount[] {
    this.expireDue();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (!filter.includeDeleted) clauses.push('deleted_at IS NULL');
    if (filter.brand) {
      const brand = normalizeBrand(filter.brand);
      if (!brand) return [];
      clauses.push('brand = ?');
      params.push(brand);
    }
    if (filter.status && filter.status !== 'all') {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.query) {
      clauses.push('(account LIKE ? OR note LIKE ?)');
      params.push(`%${filter.query}%`, `%${filter.query}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit && filter.limit > 0 ? `LIMIT ${Math.trunc(filter.limit)}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM accounts ${where} ORDER BY brand, id ${limit}`)
      .all(...params) as unknown as StoredAccount[];
    return rows.map((row) => this.toPublic(row));
  }

  stats(): PoolStats {
    this.expireDue();
    const rows = this.db
      .prepare('SELECT brand, status, deleted_at, expires_at FROM accounts')
      .all() as unknown as Array<{ brand: BrandKey; status: AccountStatus; deleted_at: string | null; expires_at: string }>;
    const stats: PoolStats = {
      total: rows.length,
      active: 0,
      disabled: 0,
      expired: 0,
      invalid: 0,
      deleted: 0,
      expiring_soon: 0,
      by_brand: [],
      db_path: this.dbPath
    };
    const soon = isoDay(new Date(this.now().getTime() + 7 * 86_400_000));
    const today = isoDay(this.now());
    const brands = new Map<BrandKey, PoolBrandStats>();
    for (const row of rows) {
      stats[row.status] += 1;
      if (row.deleted_at !== null) stats.deleted += 1;
      if (row.status === 'active' && row.expires_at && row.expires_at >= today && row.expires_at <= soon) {
        stats.expiring_soon += 1;
      }
      const bucket = brands.get(row.brand) ?? { brand: row.brand, total: 0, active: 0, disabled: 0, expired: 0, invalid: 0 };
      bucket.total += 1;
      bucket[row.status] += 1;
      brands.set(row.brand, bucket);
    }
    stats.by_brand = [...brands.values()].sort((left, right) => left.brand.localeCompare(right.brand));
    return stats;
  }

  /**
   * Take the next usable credential for a brand.
   *
   * Least-recently-used first, so a run spreads load across the pool instead of
   * hammering account #1 until the vendor rate-limits it. Returns the only shape
   * in this module that carries a password, and it is called by the pipeline,
   * never by a display path.
   */
  lease(brand: BrandKey | string): StoredAccount | null {
    this.expireDue();
    const key = normalizeBrand(brand);
    if (!key) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM accounts
         WHERE brand = ? AND status = 'active' AND deleted_at IS NULL
         ORDER BY last_used_at ASC, use_count ASC, id ASC LIMIT 1`
      )
      .get(key) as StoredAccount | undefined;
    if (!row) return null;
    const stamp = isoNow(this.now());
    this.db
      .prepare('UPDATE accounts SET last_used_at = ?, use_count = use_count + 1, updated_at = ? WHERE id = ?')
      .run(stamp, stamp, row.id);
    this.event(row.id, 'leased');
    return { ...row, last_used_at: stamp, use_count: row.use_count + 1 };
  }

  /** Every usable credential for a brand, for a run that wants to fan out. */
  leaseAll(brand: BrandKey | string): StoredAccount[] {
    this.expireDue();
    const key = normalizeBrand(brand);
    if (!key) return [];
    return this.db
      .prepare(
        `SELECT * FROM accounts WHERE brand = ? AND status = 'active' AND deleted_at IS NULL
         ORDER BY last_used_at ASC, use_count ASC, id ASC`
      )
      .all(key) as unknown as StoredAccount[];
  }

  private setStatus(id: number, status: AccountStatus, reason: string, kind: string): void {
    const stamp = isoNow(this.now());
    const retired = RETIRED_STATUSES.includes(status);
    this.db
      .prepare('UPDATE accounts SET status = ?, status_reason = ?, deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(status, reason, retired ? stamp : null, stamp, id);
    this.event(id, kind, reason);
  }

  private findId(brand: BrandKey | string, account: string): number | null {
    const key = normalizeBrand(brand);
    if (!key) return null;
    const row = this.db.prepare('SELECT id FROM accounts WHERE brand = ? AND account = ?').get(key, account) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }

  markSuccess(id: number): void {
    const stamp = isoNow(this.now());
    this.db
      .prepare('UPDATE accounts SET success_count = success_count + 1, fail_count = 0, updated_at = ? WHERE id = ?')
      .run(stamp, id);
    this.event(id, 'login_ok');
  }

  /**
   * A login was rejected: the stored password no longer works.
   *
   * Soft-deletes rather than erasing, so the operator can see which accounts
   * went bad and when, and a later import of the same account revives it.
   */
  markInvalid(id: number, reason = 'login rejected'): void {
    const stamp = isoNow(this.now());
    this.db.prepare('UPDATE accounts SET fail_count = fail_count + 1, updated_at = ? WHERE id = ?').run(stamp, id);
    this.setStatus(id, 'invalid', reason, 'invalidated');
  }

  markExpired(id: number, reason = 'membership expired'): void {
    this.setStatus(id, 'expired', reason, 'expired');
  }

  disable(brand: BrandKey | string, account: string, reason = 'disabled by operator'): boolean {
    const id = this.findId(brand, account);
    if (id === null) return false;
    return this.disableById(id, reason);
  }

  enable(brand: BrandKey | string, account: string): boolean | null {
    const id = this.findId(brand, account);
    if (id === null) return false;
    return this.enableById(id);
  }

  /** UI actions address rows by id so the raw account never leaves the DB. */
  disableById(id: number, reason = 'disabled by operator'): boolean {
    if (!this.hasId(id)) return false;
    this.setStatus(id, 'disabled', reason, 'disabled');
    return true;
  }

  /**
   * Bring a row back into rotation.
   *
   * Returns null when the membership date has already passed: flipping the
   * status to active would be undone by the very next `expireDue` sweep, so a
   * caller that got `true` here would show a success the pool contradicts one
   * refresh later. The operator has to extend the date first.
   */
  enableById(id: number): boolean | null {
    const row = this.db.prepare('SELECT status, expires_at FROM accounts WHERE id = ?').get(Math.trunc(id)) as
      { status: AccountStatus; expires_at: string } | undefined;
    if (!row) return false;
    if (row.expires_at && row.expires_at < isoDay(this.now())) return null;
    this.setStatus(id, 'active', '', 'enabled');
    return true;
  }

  private hasId(id: number): boolean {
    return Boolean(this.db.prepare('SELECT id FROM accounts WHERE id = ?').get(Math.trunc(id)));
  }

  /** Set or clear a membership date without touching the credential. */
  setExpiry(brand: BrandKey | string, account: string, expiresAt: string): boolean | null {
    const id = this.findId(brand, account);
    if (id === null) return false;
    return this.setExpiryById(id, expiresAt);
  }

  /**
   * Set or clear a membership date without touching the credential.
   *
   * The date is normalized first: `expireDue` compares `expires_at` as text, so
   * a stored `2026/1/5` would sort above every ISO date and never retire the
   * row. Returns null when the value is not a date, so the caller can refuse
   * instead of writing something the sweep will skip forever.
   */
  setExpiryById(id: number, expiresAt: string): boolean | null {
    if (!this.hasId(id)) return false;
    const normalized = normalizeExpiry(expiresAt);
    if (normalized === null) return null;
    const stamp = isoNow(this.now());
    this.db.prepare('UPDATE accounts SET expires_at = ?, updated_at = ? WHERE id = ?').run(normalized, stamp, id);
    this.event(id, 'expiry_set', normalized || '(cleared)');
    this.expireDue();
    return true;
  }

  /** Full rows including secrets, for `accounts export` only. */
  exportRecords(includeDeleted = false): AccountRecord[] {
    const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
    const rows = this.db.prepare(`SELECT * FROM accounts ${where} ORDER BY brand, id`).all() as unknown as StoredAccount[];
    return rows.map((row) => ({
      brand: row.brand,
      account: row.account,
      password: row.password,
      official_site: row.official_site,
      expires_at: row.expires_at,
      status: row.status,
      note: row.note
    }));
  }

  history(id: number, limit = 20): Array<{ at: string; kind: string; detail: string }> {
    return this.db
      .prepare('SELECT at, kind, detail FROM pool_events WHERE account_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, Math.max(1, Math.trunc(limit))) as unknown as Array<{ at: string; kind: string; detail: string }>;
  }
}