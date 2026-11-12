/**
 * `autovpn accounts …` — the pool's operator surface.
 *
 * Every listing is masked. Only `export` writes real credentials, and it says
 * so on stderr, so a terminal scrollback or a pasted log never carries them by
 * accident.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AccountStore, retiredRetentionDays, type PublicAccount } from '../pool/account-store.js';
import { BRANDS, brandLabel, normalizeBrand } from '../pool/brands.js';
import { CSV_COLUMNS, RETIRED_STATUSES, parseAccountFile, stringifyCsv, type AccountStatus } from '../pool/csv.js';
import { CliUsageError } from './errors.js';
import { readOptionValue } from './global-options.js';
import type { CliIo } from './output.js';

export const ACCOUNTS_SUBCOMMANDS = ['import', 'list', 'stats', 'snapshot', 'disable', 'enable', 'expire', 'export', 'template', 'refresh-expiry', 'purge'] as const;
export type AccountsSubcommand = (typeof ACCOUNTS_SUBCOMMANDS)[number];

/** Options that consume the next argv slot, so positionals can be found. */
const VALUE_OPTIONS = new Set([
  '--project-root', '--format', '--output', '--brand', '--status', '--reason', '--date', '--file', '--limit', '--query', '--id',
  '--concurrency', '--days'
]);

/**
 * One account's outcome from `accounts refresh-expiry`.
 *
 * The worker lives in the pipeline (`../pipeline/credential-source.js`) because
 * only it knows how to log in to each brand; this module owns only parsing,
 * rendering and the store seam.
 */
export interface RefreshExpiryEvent {
  brand: string;
  account_masked: string;
  expires_at: string;
  status: 'updated' | 'expired' | 'retired' | 'failed';
  error?: string;
}

export interface RefreshExpiryResult {
  checked: number;
  updated: number;
  expired: number;
  /** Free-tier or rejected rows removed from rotation. */
  retired?: number;
  failed: number;
  results: RefreshExpiryEvent[];
}

export interface RefreshExpiryInput {
  brand?: string;
  limit?: number;
  concurrency?: number;
  env?: NodeJS.ProcessEnv;
  store?: AccountStore;
  now?: () => Date;
  onProgress?: (event: RefreshExpiryEvent) => void;
}

export type RefreshAccountExpiry = (input: RefreshExpiryInput) => Promise<RefreshExpiryResult>;

/**
 * Resolve the pipeline worker lazily.
 *
 * The worker is owned by the pipeline module; a build that predates it (or a
 * stripped install) must still let the rest of `accounts` work, so the command
 * reports `refresh_expiry_unavailable` instead of failing at import time.
 */
async function loadRefreshAccountExpiry(): Promise<RefreshAccountExpiry | null> {
  try {
    const module = await import('../pipeline/credential-source.js') as unknown as Record<string, unknown>;
    const worker = module.refreshAccountExpiry;
    return typeof worker === 'function' ? (worker as RefreshAccountExpiry) : null;
  } catch {
    return null;
  }
}

export function accountsPositionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (VALUE_OPTIONS.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('--')) continue;
    out.push(value);
  }
  // argv[1] is the subcommand itself.
  return out.slice(1);
}

function jsonLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function wantsHuman(argv: string[]): boolean {
  return readOptionValue(argv, '--output') === 'human';
}

export function validateAccountsCommand(argv: string[]): void {
  const subcommand = argv[1] ?? '';
  if (!ACCOUNTS_SUBCOMMANDS.includes(subcommand as AccountsSubcommand)) {
    throw new CliUsageError(`accounts subcommand must be one of: ${ACCOUNTS_SUBCOMMANDS.join(', ')}`);
  }
  const format = readOptionValue(argv, '--format');
  if (format !== undefined && !['auto', 'csv', 'legacy'].includes(format)) {
    throw new CliUsageError('accounts import --format must be one of: auto, csv, legacy');
  }
  const output = readOptionValue(argv, '--output');
  if (output !== undefined && !['human', 'jsonl', 'json'].includes(output)) {
    throw new CliUsageError('accounts --output must be one of: human, jsonl');
  }
  const status = readOptionValue(argv, '--status');
  if (status !== undefined && !['active', 'disabled', 'expired', 'invalid', 'all'].includes(status)) {
    throw new CliUsageError('accounts --status must be one of: active, disabled, expired, invalid, all');
  }
  const brand = readOptionValue(argv, '--brand');
  if (brand !== undefined && !normalizeBrand(brand)) {
    throw new CliUsageError(`accounts --brand must be one of: ${BRANDS.map((item) => item.key).join(', ')}`);
  }
  const positionals = accountsPositionals(argv);
  if (subcommand === 'import' && !positionals[0] && readOptionValue(argv, '--file') === undefined && !argv.includes('--stdin')) {
    throw new CliUsageError('accounts import requires a file path or --stdin');
  }
  if (subcommand === 'refresh-expiry') {
    for (const option of ['--limit', '--concurrency']) {
      const value = readOptionValue(argv, option);
      if (value === undefined) continue;
      if (!/^\d+$/.test(value)) {
        throw new CliUsageError(`accounts refresh-expiry ${option} must be a non-negative integer`);
      }
    }
    if (Number(readOptionValue(argv, '--concurrency') ?? 3) < 1) {
      throw new CliUsageError('accounts refresh-expiry --concurrency must be a positive integer');
    }
  }
  if (subcommand === 'purge') {
    const days = readOptionValue(argv, '--days');
    // Whole days only. The cutoff is built from `days * 86_400_000` and rows
    // are compared as strings, so a fraction would have to be rounded one way
    // or the other anyway; refuse it rather than quietly giving a different
    // window than the operator typed. 0 is legal and means "keep everything".
    if (days !== undefined && !/^\d+$/.test(days)) {
      throw new CliUsageError('accounts purge --days must be a non-negative whole number of days');
    }
  }
  if (['disable', 'enable', 'expire'].includes(subcommand)) {
    const id = readOptionValue(argv, '--id');
    if (id !== undefined) {
      if (!/^\d+$/.test(id) || Number(id) < 1) throw new CliUsageError('accounts --id must be a positive integer');
      return;
    }
    if (!positionals[0] || !positionals[1]) {
      throw new CliUsageError(`accounts ${subcommand} requires <brand> <account> or --id`);
    }
    if (!normalizeBrand(positionals[0])) {
      throw new CliUsageError(`unknown brand: ${positionals[0]}`);
    }
  }
}

function renderStatsHuman(stats: ReturnType<AccountStore['stats']>): string {
  const lines = [
    `account pool: ${stats.total} total, ${stats.active} active`,
    `  retired: ${stats.disabled} disabled, ${stats.expired} expired, ${stats.invalid} invalid`,
    `  expiring within 7 days: ${stats.expiring_soon}`,
    `  expiry unknown: ${stats.expiry_unknown}`
  ];
  for (const brand of stats.by_brand) {
    lines.push(
      `  ${brandLabel(brand.brand).padEnd(8)} total=${String(brand.total).padStart(3)} active=${String(brand.active).padStart(3)}` +
      ` disabled=${brand.disabled} expired=${brand.expired} invalid=${brand.invalid} unknown=${brand.expiry_unknown}`
    );
  }
  lines.push(`  db: ${stats.db_path}`);
  return `${lines.join('\n')}\n`;
}

function renderListHuman(rows: PublicAccount[], hiddenRetired = 0): string {
  const footer = hiddenRetired > 0 ? `${hiddenRetired} retired row(s) hidden; use --all to show them\n` : '';
  if (rows.length === 0) return footer || 'account pool: no matching accounts\n';
  const lines = ['brand     account        status    expires     uses  ok/fail  note'];
  for (const row of rows) {
    lines.push(
      `${row.brand.padEnd(9)} ${row.account_masked.padEnd(14)} ${row.status.padEnd(9)} ` +
      `${(row.expires_at || '-').padEnd(11)} ${String(row.use_count).padStart(4)}  ` +
      `${row.success_count}/${row.fail_count}`.padEnd(8) + `  ${row.status_reason || row.note}`
    );
  }
  // A sweep that retires an expired row hides it from the default view without
  // a trace, which reads as "the pool lost accounts". Say how many are hidden
  // and how to see them. English, like the rest of this table and the command's
  // operator messages.
  return `${lines.join('\n')}\n${footer}`;
}

function renderRefreshLine(event: RefreshExpiryEvent): string {
  return `${event.brand.padEnd(9)} ${event.account_masked.padEnd(14)} ${(event.expires_at || '-').padEnd(11)} ${event.status}${event.error ? `  ${event.error}` : ''}`;
}

function renderRefreshHuman(rows: readonly RefreshExpiryEvent[], result: RefreshExpiryResult): string {
  const lines = rows.map(renderRefreshLine);
  lines.push(
    `checked=${result.checked} updated=${result.updated} expired=${result.expired}` +
    ` retired=${result.retired ?? 0} failed=${result.failed}`
  );
  return `${lines.join('\n')}\n`;
}

export function accountsTemplate(): string {
  const example = BRANDS.map((brand) => ({
    brand: brand.key,
    account: 'ACCOUNT',
    password: 'PASSWORD',
    official_site: brand.official_site,
    expires_at: '',
    status: 'active' as AccountStatus,
    note: ''
  }));
  return stringifyCsv(example);
}

export interface AccountsContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  now?: () => Date;
  readStdin?: () => string | Promise<string>;
  /** Test seam: an already-open store, so `:memory:` can be injected. */
  store?: AccountStore;
  /** Test seam: replaces the pipeline's login worker so tests never hit the network. */
  refreshExpiry?: RefreshAccountExpiry | null;
}

/**
 * `accounts refresh-expiry`: log in to pool accounts to learn their real
 * membership date.
 *
 * The worker (brand-specific login, membership-date parsing, retries) lives in
 * the pipeline; this function parses the flags, supplies the store and renders
 * the result. Without the worker — an install whose dist predates it — the
 * command refuses instead of pretending it checked anything.
 */
async function runRefreshExpiry(argv: string[], context: AccountsContext): Promise<number> {
  const worker = context.refreshExpiry === null
    ? null
    : context.refreshExpiry ?? await loadRefreshAccountExpiry();
  if (!worker) {
    context.io.writeStdout(jsonLine({ ok: false, error: 'refresh_expiry_unavailable' }));
    context.io.writeStderr('accounts refresh-expiry: the installed build has no expiry refresh worker\n');
    return 1;
  }
  const limit = Number(readOptionValue(argv, '--limit') ?? 0);
  const concurrency = Number(readOptionValue(argv, '--concurrency') ?? 3);
  const store = context.store ?? new AccountStore({ env: context.env, now: context.now });
  const ownsStore = !context.store;
  try {
    let streamed = 0;
    const result = await worker({
      brand: readOptionValue(argv, '--brand'),
      limit: Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0,
      concurrency: Number.isFinite(concurrency) ? Math.max(1, Math.trunc(concurrency)) : 3,
      env: context.env,
      store,
      now: context.now,
      // A refresh logs in to every account, which takes minutes per brand; the
      // human view prints each outcome as it lands instead of going silent.
      onProgress: wantsHuman(argv)
        ? (event) => {
            context.io.writeStdout(`${renderRefreshLine(event)}\n`);
            streamed += 1;
          }
        : undefined
    });
    // Any result the worker did not stream (or a worker version that never
    // calls onProgress) is still printed once, so human and JSON output cover
    // exactly the same accounts.
    const remaining = result.results.slice(streamed);
    context.io.writeStdout(wantsHuman(argv) ? renderRefreshHuman(remaining, result) : jsonLine(result));
    return result.failed > 0 ? 1 : 0;
  } finally {
    if (ownsStore) store.close();
  }
}

export async function runAccountsCommand(argv: string[], context: AccountsContext): Promise<number> {
  const subcommand = argv[1] as AccountsSubcommand;
  // The template is a static document: it must work before the pool exists and
  // on a host where the database path is not writable, so it never opens a store.
  if (subcommand === 'template') {
    context.io.writeStdout(accountsTemplate());
    return 0;
  }
  if (subcommand === 'refresh-expiry') {
    return await runRefreshExpiry(argv, context);
  }
  const dryRun = (subcommand === 'import' || subcommand === 'purge') && argv.includes('--dry-run');
  // A preview must not write: the store's getters sweep expired rows, so even
  // opening it read-write would mutate the pool before showing the plan.
  const store = context.store ?? new AccountStore({ env: context.env, now: context.now, readOnly: dryRun });
  const ownsStore = !context.store;
  try {
    if (subcommand === 'stats') {
      const stats = store.stats();
      context.io.writeStdout(wantsHuman(argv) ? renderStatsHuman(stats) : jsonLine(stats));
      return 0;
    }

    if (subcommand === 'snapshot') {
      const accounts = store.list({ status: 'all', includeDeleted: true });
      const payload = { ok: true, stats: store.stats(), accounts };
      context.io.writeStdout(jsonLine(payload));
      return 0;
    }

    if (subcommand === 'purge') {
      // An explicit, unconditional sweep: the operator asked for it now, so it
      // ignores the once-per-window stamp that read paths use. `--dry-run`
      // reports what would go without erasing anything, and opens the store
      // read-only so not even the lapse sweep writes.
      //
      // The count has two parts because they are two different answers. Retired
      // rows past the window go on this run. Unrecorded lapses are retired by
      // the sweep first, and their own window starts at that moment - so they
      // are reported as a separate number rather than promised as erased.
      const daysRaw = readOptionValue(argv, '--days');
      // Checked here as well as in `validateAccountsCommand`, because this
      // function is also the entry point for callers that skip validation; a
      // fractional value would otherwise be silently truncated to whole days.
      if (daysRaw !== undefined && !/^\d+$/.test(daysRaw)) {
        throw new CliUsageError('accounts purge --days must be a non-negative whole number of days');
      }
      const days = daysRaw === undefined ? retiredRetentionDays(context.env) : Number.parseInt(daysRaw, 10);
      const dryRun = argv.includes('--dry-run');
      if (dryRun) {
        const counted = store.countRetired(days);
        context.io.writeStdout(wantsHuman(argv)
          ? `would purge ${counted.purgeable} retired account(s); retention ${days} day(s)` +
            `${counted.pendingLapse ? `; ${counted.pendingLapse} lapsed account(s) will be retired now and counted next window` : ''}\n`
          : jsonLine({ ok: true, retired_retention_days: days, erased: 0, would_erase: counted.purgeable, pending_lapse: counted.pendingLapse, dry_run: true }));
        return 0;
      }
      // Retire first, so a row whose date lapsed before anyone read the pool is
      // reported as expired rather than left invisible to both numbers.
      const lapsed = store.expireDue();
      const erased = store.sweepRetired(days, true);
      // `--days 0` means "keep everything", so the report itself must not
      // sweep with the default window on the way out.
      const after = store.stats({ maintain: days > 0 });
      const payload = { ok: true, retired_retention_days: days, erased, lapsed, dry_run: false, stats: after };
      context.io.writeStdout(wantsHuman(argv)
        ? `purged ${erased} retired account(s); retention ${days} day(s); ${after.total} row(s) remain` +
          `${lapsed ? `; ${lapsed} expired account(s) newly retired` : ''}\n`
        : jsonLine(payload));
      return 0;
    }

    if (subcommand === 'list') {
      const limitRaw = readOptionValue(argv, '--limit');
      let limit: number | undefined;
      if (limitRaw !== undefined) {
        const parsed = Number(limitRaw);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new CliUsageError('accounts list --limit must be a positive integer');
        }
        limit = Math.trunc(parsed);
      }
      const statusRaw = readOptionValue(argv, '--status');
      // Every retired row is soft-deleted, so filtering by a retired status
      // without including deleted rows would always answer with nothing.
      const retiredFilter = statusRaw !== undefined && RETIRED_STATUSES.includes(statusRaw as AccountStatus);
      const includeDeleted = argv.includes('--all') || retiredFilter;
      // `--all` means "including retired rows", so it must not be combined with
      // the active-only default: that pair returned nothing at all.
      const status = (statusRaw ?? (includeDeleted ? 'all' : 'active')) as AccountStatus | 'all';
      const rows = store.list({
        brand: readOptionValue(argv, '--brand'),
        status,
        includeDeleted,
        query: readOptionValue(argv, '--query'),
        limit
      });
      if (wantsHuman(argv)) {
        // The default view hides every soft-deleted row, so an expiry retirement
        // would look like an account that vanished. Count what the filter hid;
        // `--all` and a retired-status filter already show those rows.
        const hiddenRetired = includeDeleted
          ? 0
          : store.list({
              brand: readOptionValue(argv, '--brand'),
              status: 'all',
              includeDeleted: true,
              query: readOptionValue(argv, '--query')
            }).filter((row) => row.deleted).length;
        context.io.writeStdout(renderListHuman(rows, hiddenRetired));
      } else {
        context.io.writeStdout(jsonLine({ ok: true, count: rows.length, accounts: rows }));
      }
      return 0;
    }

    if (subcommand === 'import') {
      const positionals = accountsPositionals(argv);
      const target = readOptionValue(argv, '--file') ?? positionals[0];
      let text: string;
      let fileName: string;
      if (argv.includes('--stdin')) {
        if (!context.readStdin) throw new CliUsageError('accounts import --stdin is unavailable in this context');
        text = await context.readStdin();
        fileName = 'upload.csv';
      } else {
        const filePath = path.resolve(context.cwd, target);
        if (!fs.existsSync(filePath)) {
          throw new CliUsageError(`accounts import: file not found: ${filePath}`);
        }
        text = fs.readFileSync(filePath, 'utf8');
        fileName = path.basename(filePath);
      }
      const format = (readOptionValue(argv, '--format') ?? 'auto') as 'auto' | 'csv' | 'legacy';
      const parsed = parseAccountFile(text, format);
      if (parsed.records.length === 0) {
        context.io.writeStdout(jsonLine({ ok: false, imported: 0, issues: parsed.issues }));
        context.io.writeStderr(`accounts import: no usable rows in ${fileName}\n`);
        return 1;
      }
      const outcome = dryRun
        ? { ...store.importRecords(parsed.records), dry_run: true }
        : store.importRecords(parsed.records);
      const payload = {
        ok: true,
        dry_run: dryRun,
        file: fileName,
        parsed: parsed.records.length,
        ...outcome,
        issues: parsed.issues,
        stats: store.stats()
      };
      if (wantsHuman(argv)) {
        const lines = [
          `${dryRun ? 'would import' : 'imported'} ${parsed.records.length} rows from ${fileName}`,
          `  new=${outcome.inserted} updated=${outcome.updated} rotated=${outcome.rotated} revived=${outcome.revived} unchanged=${outcome.unchanged} skipped=${outcome.skipped}`
        ];
        for (const issue of parsed.issues) lines.push(`  line ${issue.line}: ${issue.message}`);
        context.io.writeStdout(`${lines.join('\n')}\n`);
      } else {
        context.io.writeStdout(jsonLine(payload));
      }
      return parsed.issues.length > 0 && !argv.includes('--allow-issues') ? 1 : 0;
    }

    if (subcommand === 'export') {
      const includeDeleted = argv.includes('--all');
      const records = store.exportRecords(includeDeleted);
      const text = stringifyCsv(records);
      const target = readOptionValue(argv, '--file') ?? accountsPositionals(argv)[0];
      if (target) {
        const filePath = path.resolve(context.cwd, target);
        // `mode` only applies when the file is created. An existing backup.csv
        // from an editor or `touch` stays world-readable unless it is tightened
        // here, and this file is the one artifact that holds plaintext credentials.
        const existed = fs.existsSync(filePath);
        fs.writeFileSync(filePath, text, { mode: 0o600 });
        if (existed) {
          try {
            fs.chmodSync(filePath, 0o600);
          } catch {
            // A filesystem without POSIX modes still gets the file written.
          }
        }
        context.io.writeStdout(jsonLine({ ok: true, file: filePath, rows: records.length }));
      } else {
        context.io.writeStdout(text);
      }
      context.io.writeStderr('accounts export: output contains plaintext credentials\n');
      return 0;
    }

    const [brandRaw, account] = accountsPositionals(argv);
    const idRaw = readOptionValue(argv, '--id');
    const id = idRaw === undefined ? null : Number(idRaw);
    if (subcommand === 'disable') {
      const ok = id === null
        ? store.disable(brandRaw, account, readOptionValue(argv, '--reason') ?? 'disabled by operator')
        : store.disableById(id, readOptionValue(argv, '--reason') ?? 'disabled by operator');
      context.io.writeStdout(jsonLine({ ok, ...(id === null ? { brand: normalizeBrand(brandRaw) } : { id }), action: 'disabled' }));
      return ok ? 0 : 1;
    }
    if (subcommand === 'enable') {
      const ok = id === null ? store.enable(brandRaw, account) : store.enableById(id);
      if (ok === null) {
        // The row exists but its membership date has passed: reporting success
        // would be undone by the next read, so say why and exit non-zero.
        context.io.writeStdout(jsonLine({
          ok: false,
          error: 'membership_expired',
          ...(id === null ? { brand: normalizeBrand(brandRaw) } : { id }),
          action: 'enabled'
        }));
        context.io.writeStderr('accounts enable: the membership date has passed; set a new one with `accounts expire --date` first\n');
        return 1;
      }
      context.io.writeStdout(jsonLine({ ok, ...(id === null ? { brand: normalizeBrand(brandRaw) } : { id }), action: 'enabled' }));
      return ok ? 0 : 1;
    }
    if (subcommand === 'expire') {
      const date = readOptionValue(argv, '--date');
      // Without --date the old code wrote '' and reported success, which erased
      // a known expiry and left the row permanently un-expirable. `--clear` is
      // the explicit way to say "no date known".
      if (date === undefined && !argv.includes('--clear')) {
        throw new CliUsageError('accounts expire requires --date YYYY-MM-DD (or --clear)');
      }
      const target = argv.includes('--clear') ? '' : String(date);
      const ok = id === null
        ? store.setExpiry(brandRaw, account, target)
        : store.setExpiryById(id, target);
      if (ok === null) {
        context.io.writeStdout(jsonLine({ ok: false, error: 'invalid_date', ...(id === null ? { brand: normalizeBrand(brandRaw) } : { id }), action: 'expiry_set' }));
        context.io.writeStderr(`accounts expire: --date must be YYYY-MM-DD, got ${target}\n`);
        return 1;
      }
      context.io.writeStdout(jsonLine({ ok, ...(id === null ? { brand: normalizeBrand(brandRaw) } : { id }), expires_at: target, action: 'expiry_set' }));
      return ok ? 0 : 1;
    }
    throw new CliUsageError(`unknown accounts subcommand: ${subcommand}`);
  } finally {
    if (ownsStore) store.close();
  }
}

export { CSV_COLUMNS };