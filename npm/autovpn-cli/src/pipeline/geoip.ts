import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

type ResolveResult = { address: string; family: number };
type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> }>;

export interface GeoIpLookupOptions {
  fetch?: FetchLike;
  resolve?: (hostname: string) => Promise<ResolveResult[]>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  timeoutMs?: number;
  successTtlMs?: number;
  negativeTtlMs?: number;
  maxRetryAfterMs?: number;
  primaryUrl?: (ip: string) => string;
  fallbackUrl?: (ip: string) => string;
}

const ISO_ALPHA_2 = /^[A-Z]{2}$/;

function countryCode(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return ISO_ALPHA_2.test(normalized) && normalized !== 'ZZ' ? normalized : null;
}

export function createGeoIpLookup(options: GeoIpLookupOptions = {}): (address: string) => Promise<string> {
  const fetchFn = options.fetch ?? (globalThis.fetch as FetchLike);
  const resolve = options.resolve ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((done) => globalThis.setTimeout(done, milliseconds)));
  const setTimer = options.setTimeout ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const timeoutMs = options.timeoutMs ?? 3000;
  const successTtlMs = options.successTtlMs ?? 24 * 60 * 60 * 1000;
  const negativeTtlMs = options.negativeTtlMs ?? 60 * 1000;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 2000;
  const primaryUrl = options.primaryUrl ?? ((ip) => `https://ipwho.is/${encodeURIComponent(ip)}`);
  const fallbackUrl = options.fallbackUrl ?? ((ip) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`);
  const cache = new Map<string, { country: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();

  async function request(url: string, provider: 'primary' | 'fallback'): Promise<{ country: string | null; retryAfterMs: number }> {
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      const retryAfter = response.status === 429 ? Number(response.headers.get('retry-after')) : 0;
      if (!response.ok) return { country: null, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, maxRetryAfterMs) : 0 };
      const payload = await response.json() as Record<string, unknown>;
      if (provider === 'primary' && payload.success !== true) return { country: null, retryAfterMs: 0 };
      if (provider === 'fallback' && payload.error === true) return { country: null, retryAfterMs: 0 };
      return { country: countryCode(payload.country_code), retryAfterMs: 0 };
    } catch {
      return { country: null, retryAfterMs: 0 };
    } finally {
      clearTimer(timer);
    }
  }

  async function lookupIp(ip: string): Promise<string> {
    const cached = cache.get(ip);
    if (cached && cached.expiresAt > now()) return cached.country;
    const existing = pending.get(ip);
    if (existing) return existing;
    const operation = (async () => {
      const primary = await request(primaryUrl(ip), 'primary');
      if (primary.country) return primary.country;
      if (primary.retryAfterMs > 0) await sleep(primary.retryAfterMs);
      const fallback = await request(fallbackUrl(ip), 'fallback');
      return fallback.country ?? 'ZZ';
    })();
    pending.set(ip, operation);
    try {
      const result = await operation;
      cache.set(ip, { country: result, expiresAt: now() + (result === 'ZZ' ? negativeTtlMs : successTtlMs) });
      return result;
    } finally {
      pending.delete(ip);
    }
  }

  return async (rawAddress: string): Promise<string> => {
    const address = String(rawAddress ?? '').trim();
    if (!address) return 'ZZ';
    try {
      const results = isIP(address) ? [{ address, family: isIP(address) }] : await resolve(address);
      const resolved = results.find((entry) => isIP(entry.address));
      return resolved ? lookupIp(resolved.address) : 'ZZ';
    } catch {
      return 'ZZ';
    }
  };
}
