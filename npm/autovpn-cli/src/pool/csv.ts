/**
 * The account-pool interchange format.
 *
 * CSV was chosen over JSON because the pool is maintained by hand in a
 * spreadsheet as often as it is generated, and over the legacy INI-like file
 * because that format repeats the official site on every row and has no place
 * for an expiry date or a status. One row is one account of one brand.
 *
 *   brand,account,password,official_site,expires_at,status,note
 *
 * `brand`, `account` and `password` are required. The rest may be left empty:
 * `official_site` falls back to the brand's site, `expires_at` to "unknown",
 * `status` to `active`. Column order is fixed by the header, and a file may
 * omit trailing optional columns entirely.
 */

import { brandFromSite, brandSite, normalizeBrand, type BrandKey } from './brands.js';

export const CSV_COLUMNS = ['brand', 'account', 'password', 'official_site', 'expires_at', 'status', 'note'] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

export const ACCOUNT_STATUSES = ['active', 'disabled', 'expired', 'invalid'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Statuses that take an account out of rotation without erasing its history. */
export const RETIRED_STATUSES: readonly AccountStatus[] = ['disabled', 'expired', 'invalid'];

export interface AccountRecord {
  brand: BrandKey;
  account: string;
  password: string;
  official_site: string;
  /** ISO date (`YYYY-MM-DD`) or '' when the vendor has not told us. */
  expires_at: string;
  status: AccountStatus;
  note: string;
}

export interface ParseIssue {
  /** 1-based line in the source file, counting the header. */
  line: number;
  message: string;
}

export interface ParseResult {
  records: AccountRecord[];
  issues: ParseIssue[];
}

/**
 * RFC 4180 reader: quoted fields, escaped quotes, embedded newlines, CRLF.
 *
 * A spreadsheet exports `password` values containing commas and quotes, so a
 * naive `split(',')` would silently corrupt exactly the rows that matter most.
 * Returns rows of raw strings; blank lines are dropped, not turned into rows.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvRows(text).map((row) => row.cells);
}

/** A parsed row plus the physical line it started on. */
export interface CsvRow {
  /** 1-based physical line in the file, counting blank lines and embedded newlines. */
  line: number;
  cells: string[];
}

/**
 * RFC 4180 reader that also remembers where each row started.
 *
 * A reported line number must match what the operator sees in an editor, so a
 * blank separator line or a quoted multi-line note shifts the numbers rather
 * than being silently collapsed (the old reader reported row indices).
 */
export function parseCsvRows(text: string): CsvRow[] {
  const source = text.replace(/^﻿/, '');
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;
  let line = 1;
  let rowStart = 1;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim() !== '')) rows.push({ line: rowStart, cells: row });
    row = [];
  };

  while (index < source.length) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      // A quoted field may contain newlines; the physical line counter still
      // has to advance or every later row reports the wrong line.
      if (char === '\n') line += 1;
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      endRow();
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1;
      line += 1;
      rowStart = line;
      continue;
    }
    field += char;
    index += 1;
  }
  endRow();
  return rows;
}

/** Quote only when the value needs it, so exported files stay readable. */
export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function stringifyCsv(records: readonly AccountRecord[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const record of records) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(record[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

const HEADER_ALIASES: Record<string, CsvColumn> = {
  brand: 'brand',
  品牌: 'brand',
  厂商: 'brand',
  account: 'account',
  username: 'account',
  user: 'account',
  账号: 'account',
  帐号: 'account',
  password: 'password',
  pass: 'password',
  密码: 'password',
  official_site: 'official_site',
  site: 'official_site',
  url: 'official_site',
  官网: 'official_site',
  expires_at: 'expires_at',
  expiry: 'expires_at',
  expires: 'expires_at',
  到期: 'expires_at',
  到期时间: 'expires_at',
  status: 'status',
  状态: 'status',
  note: 'note',
  remark: 'note',
  备注: 'note'
};

const STATUS_ALIASES: Record<string, AccountStatus> = {
  active: 'active',
  enabled: 'active',
  ok: 'active',
  正常: 'active',
  可用: 'active',
  disabled: 'disabled',
  paused: 'disabled',
  停用: 'disabled',
  禁用: 'disabled',
  expired: 'expired',
  过期: 'expired',
  到期: 'expired',
  invalid: 'invalid',
  revoked: 'invalid',
  bad: 'invalid',
  失效: 'invalid',
  密码错误: 'invalid'
};

export function normalizeStatus(value: unknown): AccountStatus | null {
  const raw = String(value ?? '').trim();
  if (!raw) return 'active';
  return STATUS_ALIASES[raw.toLowerCase()] ?? null;
}

/**
 * Accept the date spellings a spreadsheet produces and emit one ISO date.
 *
 * `2026/1/5`, `2026-01-05` and `2026-01-05 00:00:00` are the same day; an
 * unparseable value is an issue on that row rather than a silent "no expiry",
 * because a dropped expiry date keeps a dead account in rotation forever.
 */
export function normalizeExpiry(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Parse a pool CSV into validated records.
 *
 * Bad rows are reported and skipped rather than aborting the file: a 143-row
 * export with one malformed line should still import the other 142, and the
 * caller decides whether the issues are fatal.
 */
export function parseAccountCsv(text: string): ParseResult {
  const rows = parseCsvRows(text);
  const issues: ParseIssue[] = [];
  if (rows.length === 0) {
    return { records: [], issues: [{ line: 1, message: 'file is empty' }] };
  }

  const headerCells = rows[0].cells;
  const header = headerCells.map((cell) => HEADER_ALIASES[cell.trim().toLowerCase()] ?? null);
  if (!header.includes('brand') || !header.includes('account') || !header.includes('password')) {
    // Never echo the raw first row: when the file has no header line at all,
    // row 1 is a real account row and one of its cells is the password. Report
    // which known columns were recognised instead, and which are missing.
    const recognised = [...new Set(header.filter((value): value is CsvColumn => Boolean(value)))];
    const missing = (['brand', 'account', 'password'] as CsvColumn[]).filter((column) => !header.includes(column));
    const seenText = recognised.length > 0 ? `recognised columns: ${recognised.join(', ')}` : 'no recognised columns; the first line must be a header row';
    return {
      records: [],
      issues: [{ line: 1, message: `header is missing ${missing.join(', ')} (${seenText})` }]
    };
  }

  const records: AccountRecord[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const { line, cells } = rows[rowIndex];
    // A row wider than the header almost always means an unquoted comma inside
    // a field: taking the first cells silently stores a truncated password,
    // and the vendor then rejects the login and retires a good account.
    const expectedWidth = headerCells.length;
    if (cells.length > expectedWidth) {
      issues.push({
        line,
        message: `row has ${cells.length} cells but the header has ${expectedWidth}; quote any value containing a comma`
      });
      continue;
    }
    const value = (column: CsvColumn): string => {
      const position = header.indexOf(column);
      return position === -1 ? '' : String(cells[position] ?? '').trim();
    };

    const brandRaw = value('brand');
    const brand = normalizeBrand(brandRaw);
    if (!brand) {
      issues.push({ line, message: `unknown brand: ${brandRaw || '(empty)'}` });
      continue;
    }
    const account = value('account');
    const password = value('password');
    if (!account || !password) {
      issues.push({ line, message: 'account and password are required' });
      continue;
    }
    const status = normalizeStatus(value('status'));
    if (!status) {
      issues.push({ line, message: `unknown status: ${value('status')}` });
      continue;
    }
    const expiresAt = normalizeExpiry(value('expires_at'));
    if (expiresAt === null) {
      issues.push({ line, message: `unparseable expires_at: ${value('expires_at')}` });
      continue;
    }
    const siteRaw = value('official_site');
    // A site we do not recognise is allowed (vendors rotate domains), but one
    // we do recognise that belongs to another brand is a data error: the row
    // would log in to the wrong vendor with a credential it has never issued.
    const siteBrand = brandFromSite(siteRaw);
    if (siteBrand && siteBrand !== brand) {
      issues.push({ line, message: `official_site belongs to ${siteBrand}, not ${brand}` });
      continue;
    }
    records.push({
      brand,
      account,
      password,
      official_site: siteRaw || brandSite(brand),
      expires_at: expiresAt,
      status,
      note: value('note')
    });
  }
  return { records, issues };
}

/**
 * Reader for the original hand-maintained file:
 *
 *   [雷霆加速器 #2]
 *   官网：https://…
 *   账号: …
 *   密码: …
 *
 * Kept so the existing 143 accounts can be seeded once without a manual
 * conversion step. Every row it produces still goes through the same
 * validation as a CSV row.
 */
export function parseLegacyAccountFile(text: string): ParseResult {
  const issues: ParseIssue[] = [];
  const records: AccountRecord[] = [];
  let current: { line: number; heading: string; fields: Map<string, string> } | null = null;

  const flush = () => {
    if (!current) return;
    const { line, heading, fields } = current;
    const brand = normalizeBrand(heading);
    if (!brand) {
      issues.push({ line, message: `unknown brand: ${heading}` });
      current = null;
      return;
    }
    const account = fields.get('account') ?? '';
    const password = fields.get('password') ?? '';
    if (!account || !password) {
      issues.push({ line, message: 'account and password are required' });
      current = null;
      return;
    }
    const expiresAt = normalizeExpiry(fields.get('expires_at') ?? '');
    if (expiresAt === null) {
      issues.push({ line, message: `unparseable expiry in section ${heading}` });
      current = null;
      return;
    }
    const status = normalizeStatus(fields.get('status') ?? '');
    if (!status) {
      issues.push({ line, message: `unknown status in section ${heading}` });
      current = null;
      return;
    }
    const siteRaw = fields.get('official_site') ?? '';
    // Same guard as the CSV path: a section whose 官网 was copied from another
    // brand would log in to the wrong vendor with a credential it never issued.
    const siteBrand = brandFromSite(siteRaw);
    if (siteBrand && siteBrand !== brand) {
      issues.push({ line, message: `official_site belongs to ${siteBrand}, not ${brand}` });
      current = null;
      return;
    }
    records.push({
      brand,
      account,
      password,
      official_site: siteRaw || brandSite(brand),
      expires_at: expiresAt,
      status,
      note: fields.get('note') ?? ''
    });
    current = null;
  };

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const heading = /^\[(.+)\]$/.exec(line);
    if (heading) {
      flush();
      current = { line: index + 1, heading: heading[1].trim(), fields: new Map() };
      continue;
    }
    const pair = /^([^:：]+)[:：](.*)$/.exec(line);
    if (!pair) {
      issues.push({ line: index + 1, message: 'expected key: value' });
      continue;
    }
    if (!current) {
      issues.push({ line: index + 1, message: 'value outside a [brand] section' });
      continue;
    }
    const key = HEADER_ALIASES[pair[1].trim().toLowerCase()];
    if (!key) {
      issues.push({ line: index + 1, message: `unknown field: ${pair[1].trim()}` });
      continue;
    }
    current.fields.set(key, pair[2].trim());
  }
  flush();
  return { records, issues };
}

/**
 * Pick the reader from the file's first meaningful line, not its extension.
 *
 * The legacy reader accepts `#` / `;` comments, so a legacy file with a header
 * comment must not be misdetected as CSV and fail its header check.
 */
export function parseAccountFile(text: string, format: 'auto' | 'csv' | 'legacy' = 'auto'): ParseResult {
  if (format === 'csv') return parseAccountCsv(text);
  if (format === 'legacy') return parseLegacyAccountFile(text);
  const first = text.replace(/^﻿/, '').split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#') && !line.startsWith(';')) ?? '';
  return /^\[.+\]$/.test(first) ? parseLegacyAccountFile(text) : parseAccountCsv(text);
}