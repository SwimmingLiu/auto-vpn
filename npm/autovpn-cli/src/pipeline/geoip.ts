import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIsoAlpha2CountryCode } from './country-codes.js';

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
  providerConcurrency?: number;
  primaryUrl?: (ip: string) => string;
  fallbackUrl?: (ip: string) => string;
}

interface GeoIpResult {
  country: string;
  detected: boolean;
}

function countryCode(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return isIsoAlpha2CountryCode(normalized) ? normalized : null;
}

function retryAfterMilliseconds(value: string | null, now: number, maximum: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, maximum) : 0;
}

function ipv4Number(address: string): number | null {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InCidr(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base) as number;
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(baseValue / size);
}

function isRejectedIpv4(value: number): boolean {
  return [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]
  ].some(([base, prefix]) => ipv4InCidr(value, base as string, prefix as number));
}

function ipv6Number(address: string): bigint | null {
  const pieces = address.toLowerCase().split('::');
  if (pieces.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const groups = side.split(':');
    const last = groups.at(-1) ?? '';
    if (last.includes('.')) {
      const mapped = ipv4Number(last);
      if (mapped === null) return null;
      groups.splice(-1, 1, ((mapped >>> 16) & 0xffff).toString(16), (mapped & 0xffff).toString(16));
    }
    const parsed = groups.map((group) => /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : -1);
    return parsed.some((group) => group < 0) ? null : parsed;
  };
  const left = parseSide(pieces[0]);
  const right = parseSide(pieces[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill(0), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function canonicalIpv6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  const before = hex.slice(0, bestStart).join(':');
  const after = hex.slice(bestStart + bestLength).join(':');
  return `${before}::${after}`;
}

function normalizeGlobalAddress(address: string): string | null {
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    return value !== null && !isRejectedIpv4(value) ? address : null;
  }
  const value = ipv6Number(address);
  if (value === null) return null;
  if ((value >> 32n) === 0xffffn) {
    const mapped = Number(value & 0xffffffffn) >>> 0;
    if (isRejectedIpv4(mapped)) return null;
    return `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
  }
  const globalUnicast = value >= 0x20000000000000000000000000000000n && value <= 0x3fffffffffffffffffffffffffffffffn;
  const ietfProtocolAssignments = value >= 0x20010000000000000000000000000000n && value <= 0x200101ffffffffffffffffffffffffffn;
  const documentation = value >= 0x20010db8000000000000000000000000n && value <= 0x20010db8ffffffffffffffffffffffffn;
  const extendedDocumentation = value >= 0x3fff0000000000000000000000000000n && value <= 0x3fff0fffffffffffffffffffffffffffn;
  return globalUnicast && !ietfProtocolAssignments && !documentation && !extendedDocumentation ? canonicalIpv6(value) : null;
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
  const providerConcurrency = Math.max(1, Math.floor(options.providerConcurrency ?? 4));
  const primaryUrl = options.primaryUrl ?? ((ip) => `https://ipwho.is/${encodeURIComponent(ip)}`);
  const fallbackUrl = options.fallbackUrl ?? ((ip) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`);
  const cache = new Map<string, GeoIpResult & { expiresAt: number }>();
  const pending = new Map<string, Promise<GeoIpResult>>();
  const providerWaiters: Array<() => void> = [];
  let activeProviderRequests = 0;
  let providerCooldownUntil = 0;

  async function acquireProviderSlot(): Promise<() => void> {
    if (activeProviderRequests >= providerConcurrency) {
      await new Promise<void>((resolve) => providerWaiters.push(resolve));
    } else {
      activeProviderRequests += 1;
    }
    return () => {
      const next = providerWaiters.shift();
      if (next) next();
      else activeProviderRequests -= 1;
    };
  }

  async function request(url: string, provider: 'primary' | 'fallback'): Promise<{ country: string | null; retryAfterMs: number }> {
    try {
      const parsed = new URL(url);
      const expectedHost = provider === 'primary' ? 'ipwho.is' : 'ipapi.co';
      if (parsed.protocol !== 'https:' || parsed.hostname !== expectedHost || parsed.port || parsed.username || parsed.password) {
        return { country: null, retryAfterMs: 0 };
      }
    } catch {
      return { country: null, retryAfterMs: 0 };
    }
    const release = await acquireProviderSlot();
    const cooldownMs = providerCooldownUntil - now();
    if (cooldownMs > 0) await sleep(cooldownMs);
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      const retryAfterMs = response.status === 429
        ? retryAfterMilliseconds(response.headers.get('retry-after'), now(), maxRetryAfterMs)
        : 0;
      if (retryAfterMs > 0) providerCooldownUntil = Math.max(providerCooldownUntil, now() + retryAfterMs);
      if (!response.ok) return { country: null, retryAfterMs };
      const payload = await response.json() as Record<string, unknown>;
      if (provider === 'primary' && payload.success !== true) return { country: null, retryAfterMs: 0 };
      if (provider === 'fallback' && payload.error === true) return { country: null, retryAfterMs: 0 };
      return { country: countryCode(payload.country_code), retryAfterMs: 0 };
    } catch {
      return { country: null, retryAfterMs: 0 };
    } finally {
      clearTimer(timer);
      release();
    }
  }

  async function lookupIp(ip: string): Promise<GeoIpResult> {
    const cached = cache.get(ip);
    if (cached && cached.expiresAt > now()) return cached;
    const existing = pending.get(ip);
    if (existing) return existing;
    const operation = (async () => {
      const primary = await request(primaryUrl(ip), 'primary');
      if (primary.country) return { country: primary.country, detected: true };
      const fallback = await request(fallbackUrl(ip), 'fallback');
      return fallback.country
        ? { country: fallback.country, detected: true }
        : { country: 'US', detected: false };
    })();
    pending.set(ip, operation);
    try {
      const result = await operation;
      cache.set(ip, { ...result, expiresAt: now() + (result.detected ? successTtlMs : negativeTtlMs) });
      return result;
    } finally {
      pending.delete(ip);
    }
  }

  return async (rawAddress: string): Promise<string> => {
    const address = String(rawAddress ?? '').trim();
    if (!address) return 'US';
    try {
      const results = isIP(address) ? [{ address, family: isIP(address) }] : await resolve(address);
      const seen = new Set<string>();
      for (const result of results) {
        const globalAddress = normalizeGlobalAddress(result.address);
        if (!globalAddress || seen.has(globalAddress)) continue;
        seen.add(globalAddress);
        const resultCountry = await lookupIp(globalAddress);
        if (resultCountry.detected) return resultCountry.country;
      }
      return 'US';
    } catch {
      return 'US';
    }
  };
}
