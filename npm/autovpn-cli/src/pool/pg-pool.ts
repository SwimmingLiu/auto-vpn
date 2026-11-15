/**
 * The shared account pool: one Postgres table every host rotates from.
 *
 * The pool used to be a file. A file works on one machine, and the deployment
 * copied it into GitHub secrets as two base64 halves — which is why retiring an
 * account on the source server changed nothing on the runner, and why adding a
 * single account meant re-splitting a 57 KB secret. The pool of record is now a
 * table: `autovpn.accounts` in the operator's Postgres database.
 *
 * The local sqlite file stays as a working copy, not a second truth. The
 * pipeline leases a credential once per login, synchronously, hundreds of times
 * a night; a remote round trip cannot serve that path. So a run pulls the table
 * once at the start, rotates the copy, and pushes the result back at the end.
 * The operator's `accounts` commands do the same around a mutation, which is
 * what keeps `accounts disable` on the laptop visible to the source server.
 *
 * Sync rules:
 *
 * - Rows are keyed by `(brand, account)`. Local ids never cross hosts.
 * - `updated_at` decides a conflict: a stale side never overwrites a fresher
 *   one, so a push cannot undo a retirement another host recorded this minute.
 * - A plain push never deletes: absence on one host is not a verdict. `purge`
 *   prunes remotely with the same retention predicate it applies locally.
 * - Nothing here prints a URL or a row. The URL carries the database password
 *   and a row carries a vendor credential; only counts leave this module.
 */

import pg from 'pg';

import { retentionCutoffFor, type AccountStore, type MergeOutcome, type SyncedAccount } from './account-store.js';

const { Client } = pg;

/** Environment names a shared pool may arrive under, most specific first. */
export const SHARED_POOL_ENV = ['AUTOVPN_ACCOUNTS_DB_URL', 'VPN_AUTOMATION_ACCOUNTS_DB_URL', 'PGSQL'] as const;

/** The database URL, or '' when this host runs on its local pool alone. */
export function resolveSharedPoolUrl(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of SHARED_POOL_ENV) {
    const value = String(env[name] ?? '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * `host:port/database` with the credentials stripped.
 *
 * The URL embeds the database password, so it must never reach a log line, an
 * event or an Actions transcript. This is the only spelling of it that may.
 */
export function describeSharedPoolUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\/+/, '');
    return `${parsed.hostname}:${parsed.port || '5432'}/${database}`;
  } catch {
    return 'postgres (unparsable url)';
  }
}

export interface SharedPoolOptions {
  url?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export interface PushCounts {
  sent: number;
  inserted: number;
  updated: number;
  /** Rows the database already had with a fresher `updated_at`. */
  stale: number;
}

export interface SyncReport {
  pool: string;
  pulled: MergeOutcome | null;
  pushed: PushCounts | null;
  pruned: number;
  at: string;
}

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS autovpn;
CREATE TABLE IF NOT EXISTS autovpn.accounts (
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
  PRIMARY KEY (brand, account)
);
CREATE INDEX IF NOT EXISTS accounts_rotation ON autovpn.accounts (brand, status, deleted_at, last_used_at);
CREATE TABLE IF NOT EXISTS autovpn.pool_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const COLUMNS = [
  'brand', 'account', 'password', 'official_site', 'expires_at', 'status', 'status_reason', 'note',
  'created_at', 'updated_at', 'last_used_at', 'use_count', 'success_count', 'fail_count', 'deleted_at'
] as const;

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface ConnectOptions {
  connectTimeoutMs: number;
  statementTimeoutMs: number;
}

/**
 * Open one connection, applying libpq's SSL semantics.
 *
 * `sslmode=prefer` really means "TLS if the server offers it". node-postgres
 * parses it into mandatory TLS with verification off, so a server built without
 * OpenSSL — the source host's build is one — fails instead of falling back.
 * The fallback is implemented here, and only for `prefer`: `require` and the
 * `verify-*` modes must never silently downgrade.
 */
async function connect(url: string, options: ConnectOptions) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('the shared pool URL is not a valid postgresql:// URL');
  }
  const sslmode = String(parsed.searchParams.get('sslmode') ?? '').toLowerCase();
  parsed.searchParams.delete('sslmode');
  const connectionString = parsed.toString();
  const base = {
    connectionString,
    connectionTimeoutMillis: options.connectTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    application_name: 'autovpn-pool'
  };

  const open = async (ssl: false | { rejectUnauthorized: boolean }) => {
    const client = new Client({ ...base, ssl });
    await client.connect();
    return client;
  };

  if (sslmode === 'disable') return open(false);
  if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') {
    return open({ rejectUnauthorized: sslmode !== 'verify-ca' && sslmode !== 'verify-full' });
  }
  if (sslmode === 'prefer') {
    try {
      return await open({ rejectUnauthorized: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/does not support SSL/i.test(message)) throw error;
      return open(false);
    }
  }
  // No sslmode: leave the decision to node-postgres, so `?ssl=true` in the URL
  // still means TLS. Passing `ssl: false` here would silently downgrade a URL
  // that asked for it.
  const client = new Client({ ...base });
  await client.connect();
  return client;
}

type PgClient = InstanceType<typeof Client>;

async function withClient<T>(options: SharedPoolOptions, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const url = String(options.url ?? resolveSharedPoolUrl(options.env ?? process.env)).trim();
  if (!url) {
    throw new Error(
      `no shared pool database configured; set ${SHARED_POOL_ENV[0]} (or run \`accounts sync --url\`)`
    );
  }
  const client = await connect(url, {
    connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
    statementTimeoutMs: options.statementTimeoutMs ?? 60_000
  });
  try {
    await client.query(SCHEMA);
    return await fn(client);
  } finally {
    await client.end().catch(() => {
      // The connection is already gone; nothing here is worth masking the
      // caller's error with an end() failure.
    });
  }
}

function toSyncedAccount(row: Record<string, unknown>): SyncedAccount {
  return {
    brand: String(row.brand ?? '') as SyncedAccount['brand'],
    account: String(row.account ?? ''),
    password: String(row.password ?? ''),
    official_site: String(row.official_site ?? ''),
    expires_at: String(row.expires_at ?? ''),
    status: String(row.status ?? 'active') as SyncedAccount['status'],
    status_reason: String(row.status_reason ?? ''),
    note: String(row.note ?? ''),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    last_used_at: String(row.last_used_at ?? ''),
    use_count: Number(row.use_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    fail_count: Number(row.fail_count ?? 0),
    deleted_at: row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at)
  };
}

/** Read the shared table into the local working copy. */
export async function pullSharedPool(store: AccountStore, options: SharedPoolOptions = {}): Promise<MergeOutcome> {
  const rows = await withClient(options, async (client) => {
    const result = await client.query(`SELECT ${COLUMNS.join(', ')} FROM autovpn.accounts`);
    return result.rows.map((row) => toSyncedAccount(row as Record<string, unknown>));
  });
  const outcome = store.mergeRemoteRows(rows);
  const now = (options.now ?? (() => new Date()))();
  store.recordSync('pull', isoNow(now), outcome);
  return outcome;
}

/**
 * Upsert the local working copy into the shared table.
 *
 * One statement per 100 rows rather than one per row: the runner reaches this
 * database across the public internet, where 631 single-row round trips would
 * take minutes. The `WHERE excluded.updated_at >= ...` clause is the same
 * last-writer-wins rule the pull merge applies, so neither direction can
 * resurrect a row the other side retired later.
 */
export async function pushSharedPool(store: AccountStore, options: SharedPoolOptions = {}): Promise<PushCounts> {
  const rows = store.syncSnapshot();
  const counts: PushCounts = { sent: rows.length, inserted: 0, updated: 0, stale: 0 };
  if (rows.length === 0) return counts;
  await withClient(options, async (client) => {
    // `use_count` / `success_count` only ever grow, so an equal-timestamp
    // upsert keeps the larger value — the same rule `mergeRemoteRows` applies
    // on the way in. Without it, two hosts pushing the same `updated_at` could
    // rewind each other's history until the next pull repaired it.
    const updateSet = COLUMNS
      .filter((column) => column !== 'brand' && column !== 'account')
      .map((column) => (column === 'use_count' || column === 'success_count'
        ? `${column} = GREATEST(autovpn.accounts.${column}, EXCLUDED.${column})`
        : `${column} = EXCLUDED.${column}`))
      .join(', ');
    const chunkSize = 100;
    for (let start = 0; start < rows.length; start += chunkSize) {
      const chunk = rows.slice(start, start + chunkSize);
      const values: unknown[] = [];
      const tuples = chunk.map((row, rowIndex) => {
        const offset = rowIndex * COLUMNS.length;
        values.push(
          row.brand, row.account, row.password, row.official_site, row.expires_at, row.status,
          row.status_reason, row.note, row.created_at, row.updated_at, row.last_used_at,
          Math.max(0, Math.trunc(row.use_count) || 0),
          Math.max(0, Math.trunc(row.success_count) || 0),
          Math.max(0, Math.trunc(row.fail_count) || 0),
          row.deleted_at
        );
        return `(${COLUMNS.map((__, columnIndex) => `$${offset + columnIndex + 1}`).join(', ')})`;
      });
      const result = await client.query(
        `INSERT INTO autovpn.accounts (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}
         ON CONFLICT (brand, account) DO UPDATE SET ${updateSet}
         WHERE EXCLUDED.updated_at >= autovpn.accounts.updated_at
         RETURNING (xmax = 0) AS inserted`,
        values
      );
      for (const row of result.rows as Array<{ inserted: boolean }>) {
        if (row.inserted) counts.inserted += 1;
        else counts.updated += 1;
      }
      counts.stale += chunk.length - result.rows.length;
    }
    const now = isoNow((options.now ?? (() => new Date()))());
    await client.query(
      `INSERT INTO autovpn.pool_meta (key, value) VALUES ('last_push_at', $1), ('last_push_counts', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [now, JSON.stringify(counts)]
    );
  });
  store.recordSync('push', isoNow((options.now ?? (() => new Date()))()), counts);
  return counts;
}

/**
 * Erase retired rows on the shared table with the local retention predicate.
 *
 * Only `purge` calls this. A plain push must not delete: a host that has not
 * seen a row yet would otherwise erase it for everyone.
 */
export async function pruneSharedPool(
  store: AccountStore,
  days: number,
  options: SharedPoolOptions = {}
): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = retentionCutoffFor((options.now ?? (() => new Date()))(), days);
  const removed = await withClient(options, async (client) => {
    const result = await client.query(
      `DELETE FROM autovpn.accounts
       WHERE deleted_at IS NOT NULL AND deleted_at < $1 AND status IN ('expired', 'invalid')`,
      [cutoff]
    );
    return Number(result.rowCount ?? 0);
  });
  store.recordSync('prune', isoNow((options.now ?? (() => new Date()))()), { pruned: removed, retention_days: days });
  return removed;
}

/** Remote totals plus the last push stamp, for `accounts sync --status`. */
export async function sharedPoolStatus(options: SharedPoolOptions = {}): Promise<{
  pool: string;
  total: number;
  active: number;
  retired: number;
  last_push_at: string;
}> {
  const url = String(options.url ?? resolveSharedPoolUrl(options.env ?? process.env)).trim();
  return withClient({ ...options, url }, async (client) => {
    const totals = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'active' AND deleted_at IS NULL)::int AS active,
              COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS retired
       FROM autovpn.accounts`
    );
    const stamp = await client.query("SELECT value FROM autovpn.pool_meta WHERE key = 'last_push_at'");
    const row = totals.rows[0] ?? {};
    return {
      pool: describeSharedPoolUrl(url),
      total: Number(row.total ?? 0),
      active: Number(row.active ?? 0),
      retired: Number(row.retired ?? 0),
      last_push_at: String(stamp.rows[0]?.value ?? '')
    };
  });
}
