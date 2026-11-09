/**
 * Canonical brand registry for the account pool.
 *
 * An account belongs to a brand, not to a profile source: `xuanfeng-area` and
 * `xuanfeng-all-area` were two views of one vendor, and a pool keyed by source
 * name would split one vendor's accounts across two buckets. Every spelling a
 * profile, an import file or a human is likely to use resolves to one key here.
 */

export type BrandKey = 'leiting' | 'xuanfeng' | 'heidong' | 'mifeng';

export interface BrandDefinition {
  key: BrandKey;
  /** Product name shown in the UI and written by `accounts export`. */
  label: string;
  /** Archive filename prefix used by the APK downloader. */
  prefix: string;
  /** Login site used when an imported row leaves `official_site` empty. */
  official_site: string;
  aliases: readonly string[];
}

export const BRANDS: readonly BrandDefinition[] = [
  {
    key: 'leiting',
    label: '雷霆加速器',
    prefix: 'lt',
    official_site: 'https://www.68123836.com',
    aliases: ['雷霆', '雷霆加速器', 'leiting', 'lt', 'www.68123836.com']
  },
  {
    key: 'xuanfeng',
    label: '旋风加速器',
    prefix: 'xf',
    official_site: 'https://www.16863988.com',
    aliases: ['旋风', '旋风加速器', 'xuanfeng', 'xf', 'xuanfeng-area', 'xuanfeng-all-area', 'www.16863988.com']
  },
  {
    key: 'heidong',
    label: '黑洞加速器',
    prefix: 'hd',
    official_site: 'https://www.67986457.com',
    aliases: ['黑洞', '黑洞加速器', 'heidong', 'blackhole', 'hd', 'www.67986457.com']
  },
  {
    key: 'mifeng',
    label: '蜜蜂加速器',
    prefix: 'mf',
    official_site: 'https://www.86933221.com',
    aliases: ['蜜蜂', '蜜蜂加速器', 'mifeng', 'mf', 'www.86933221.com']
  }
];

const ALIAS_INDEX = new Map<string, BrandKey>();
for (const brand of BRANDS) {
  ALIAS_INDEX.set(brand.key, brand.key);
  for (const alias of brand.aliases) {
    const key = alias.toLowerCase();
    ALIAS_INDEX.set(key, brand.key);
    // A host is the same site with or without its `www.` label; register both
    // spellings so an operator who drops it still resolves to this brand.
    if (/^www\./.test(key)) ALIAS_INDEX.set(key.slice(4), brand.key);
    else if (key.includes('.')) ALIAS_INDEX.set(`www.${key}`, brand.key);
  }
}

/**
 * Resolve any brand spelling to its canonical key.
 *
 * Section headings in the legacy file carry an index suffix (`雷霆加速器 #12`),
 * and profile sources carry a platform or variant suffix (`leiting_ios`), so a
 * trailing `#N` or `_suffix` is stripped before the lookup. Returns null for an
 * unknown brand rather than guessing: importing under the wrong brand would
 * send a working credential to a vendor that has never heard of it.
 */
export function normalizeBrand(value: unknown): BrandKey | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const direct = ALIAS_INDEX.get(raw.toLowerCase());
  if (direct) return direct;
  const stripped = raw.replace(/\s*#\s*\d+\s*$/, '').replace(/[_-](area|all-area|ios|android|\d+)$/i, '').trim();
  return ALIAS_INDEX.get(stripped.toLowerCase()) ?? null;
}

export function brandDefinition(key: BrandKey): BrandDefinition {
  const found = BRANDS.find((brand) => brand.key === key);
  if (!found) throw new Error(`unknown brand: ${key}`);
  return found;
}

export function brandLabel(key: BrandKey): string {
  return brandDefinition(key).label;
}

/** Official site for a brand, used when an imported row omits it. */
export function brandSite(key: BrandKey): string {
  return brandDefinition(key).official_site;
}

/** Brand of an official site URL or bare host, if it is one we know. */
export function brandFromSite(site: unknown): BrandKey | null {
  const raw = String(site ?? '').trim();
  if (!raw) return null;
  let host = raw.toLowerCase();
  try {
    const parsed = new URL(raw);
    // `new URL('www.68123836.com:443')` succeeds with an empty host and the
    // bogus scheme `www.68123836.com:`; only a real http(s) parse is usable.
    host = parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.host.toLowerCase()
      : raw.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  } catch {
    host = raw.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  }
  // Strip the port, a trailing dot and a `www.` label, in any order: an operator
  // who writes `68123836.com` must resolve to the same brand as the canonical
  // `www.68123836.com`, or the cross-brand guard silently lets the row through.
  const bare = host.replace(/:\d+$/, '').replace(/\.$/, '');
  return ALIAS_INDEX.get(host)
    ?? ALIAS_INDEX.get(bare)
    ?? ALIAS_INDEX.get(bare.replace(/^www\./, ''))
    ?? null;
}