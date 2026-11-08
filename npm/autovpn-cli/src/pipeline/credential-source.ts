import { createHash } from 'node:crypto';

import {
  androidChunkUrls,
  apkDiscoveryFromBytes,
  type ApkDiscovery,
  candidateApkUrls,
  cdnConfigUrls,
  parseCdnConfig,
  apkSlot
} from './apk-discovery.js';
import {
  buildUrl,
  commonParams,
  type BrandLayout,
  flattenRouteGroups,
  isPlaceholderNode,
  LOGIN_SALT,
  pathAndQuery,
  selectApiDomain,
  type BrandIdentity,
  type DeviceIdentity,
  type Platform,
  type RouteGroup,
  type RouteNode
} from './brand-protocol.js';
import { decryptPayload, extractLinksFromPlaintext } from './extract.js';
import type { FingerprintStore } from './brand-cache.js';
import type { ExtractedSourceResult, SourceConfigInput, ExtractInput } from './extract.js';

/**
 * Credential-driven extraction: an official site plus an account yields nodes.
 *
 * This replaces the older "paste a pre-built evmess URL" source. The only
 * inputs are the official site and the account, so nothing expires: the
 * session, device id and per-request signature are produced on every run.
 *
 * Flow per brand, mirroring the app's own button chain:
 *   official site -> APK -> seeds/package/cert
 *   -> /api/eversion        (control-plane key, api_links, api_lines)
 *   -> /myapi/eapilogin     (token)
 *   -> /myapi/apinodelist   (route ids)
 *   -> /api/evmess?area=ID  (one vmess link per route)
 */

export interface BrandCredentialSource {
  /** Official site used to locate the current APK. */
  official_site?: string;
  /** Optional explicit APK URL, bypassing site discovery. */
  apk_url?: string;
  /** Local APK path, bypassing both site discovery and download. */
  apk_path?: string;
  /** Control-plane AES key; discovered from the APK when omitted. */
  key?: string;
  account?: string;
  password?: string;
  enabled?: boolean;
  /** Which client identity to impersonate. */
  platform?: Platform;
  /** Stable device id; a fixed default is used when omitted. */
  device_id?: string;
  /** Install date in `yyyy-MM-dd`; today is used when omitted. */
  install_date?: string;
  /** Brand parameter layout; inferred from the brand name when omitted. */
  brand_flags?: string;
  /** Invite/recommendation code echoed back as `&code=`. */
  code?: string;
  /** Maximum routes to request; all routes when omitted. */
  max_areas?: number;
  /** Per-request timeout in milliseconds. */
  timeout_ms?: number;
}

export interface CredentialExtractOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  eventCallback?: (type: string, payload: Record<string, unknown>) => void;
  linksCallback?: (links: string[]) => void | Promise<void>;
  /** Injected for tests: returns the APK bytes for a brand. */
  loadApk?: (source: BrandCredentialSource) => Promise<Buffer | null>;
  /** Persistent fingerprint cache; when absent the APK is inspected each run. */
  fingerprintStore?: FingerprintStore;
  /** Shared in-memory fingerprint, so several sources of one brand inspect once. */
  memo?: FingerprintMemo;
}

export interface CredentialDiagnostics {
  brand: string;
  platform: Platform;
  apk_url: string;
  package_name: string;
  version_name: string;
  seed_domains: string[];
  api_domain: string;
  route_count: number;
  node_count: number;
  placeholder_count: number;
  errors: string[];
}

export interface CredentialExtractResult extends ExtractedSourceResult {
  diagnostics: CredentialDiagnostics;
}


/**
 * Each brand concatenates `getCommParams()` in its own order with its own
 * literal block. The layout can be overridden from the profile, and is picked
 * from the brand name otherwise.
 */
export function resolveBrandLayout(source: BrandCredentialSource & { brand?: string }): BrandLayout {
  const explicit = String(source.brand_flags ?? '').trim();
  if (explicit) {
    try {
      const parsed = JSON.parse(explicit) as BrandLayout;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // A bare literal block is treated as an after-package flag.
      return { afterPackage: explicit.startsWith('&') ? explicit : `&${explicit}` };
    }
  }
  const brand = String(source.brand ?? '').trim();
  if (brand.includes('旋风') || /xuanfeng/i.test(brand)) {
    return { vipFirst: true, viewport: true };
  }
  if (brand.includes('雷霆') || /leiting/i.test(brand)) {
    return { viewport: true, afterPackage: '&newlt=1', beforeApps: '&update_action=web' };
  }
  if (brand.includes('黑洞') || /heidong|blackhole/i.test(brand)) {
    return { afterPackage: '&newhd=1' };
  }
  return {};
}

/**
 * Archive filename prefixes, keyed by every name a brand is addressed by.
 *
 * A profile normally names its sources in English (`leiting`), while the
 * downloader uses a Chinese product name, so both are mapped. The official
 * host is the last resort when a profile uses a custom source name.
 */
const BRAND_APK_PREFIXES: Record<string, string> = {
  雷霆: 'lt',
  旋风: 'xf',
  黑洞: 'hd',
  蜜蜂: 'mf',
  leiting: 'lt',
  xuanfeng: 'xf',
  heidong: 'hd',
  mifeng: 'mf',
  'www.68123836.com': 'lt',
  'www.16863988.com': 'xf',
  'www.67986457.com': 'hd',
  'www.86933221.com': 'mf'
};

/** Host of an official site, without scheme or path. */
function siteHost(site: string): string {
  try {
    return new URL(site).host.toLowerCase();
  } catch {
    return '';
  }
}

/** A fingerprint shared across the sources of one pipeline run. */
export interface FingerprintMemo {
  get(): ApkDiscovery | null;
  set(value: ApkDiscovery | null): void;
}

export function createFingerprintMemo(store: FingerprintStore | null, brand: string): FingerprintMemo {
  let value: ApkDiscovery | null = store?.read(brand) ?? null;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    }
  };
}

/**
 * AES key candidates for the control plane.
 *
 * The key is not a literal in the dex, so it is offered as the configured value
 * plus the two constants the current builds share; `/api/eversion` is what
 * decides which one is right.
 */
export function credentialKeyCandidates(source: BrandCredentialSource, discovery?: ApkDiscovery): string[] {
  const out: string[] = [];
  const add = (value: string | undefined) => {
    const trimmed = String(value ?? '').trim();
    if (trimmed && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  };
  // A configured key wins; the dex pool is what makes rotation survivable,
  // and the two shared constants cover a cache written before the pool existed.
  add(source.key);
  for (const candidate of discovery?.key_candidates ?? []) {
    add(candidate);
  }
  add('ks9KUrbWJj46AftX');
  add('awdtif20190619ti');
  return out;
}

const DEFAULT_DEVICE_ID = '6C3B3033-4FAD-42FA-B8AD-DF3EDBCFA872';
const DEFAULT_TIMEOUT_MS = 20_000;

function today(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `doLogin()` signs `account + password + salt`. */
export function loginSignature(account: string, password: string): string {
  return createHash('md5').update(`${account}${password}${LOGIN_SALT}`, 'utf8').digest('hex');
}

interface FetchTextResult {
  text: string;
  url: string;
  ok: boolean;
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number
): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      return { text: '', url, ok: false };
    }
    return { text: await response.text(), url, ok: true };
  } catch {
    return { text: '', url, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Control-plane responses are AES-CBC with key == IV. */
export function decodeControlPlane(cipherText: string, key: string): string {
  if (!cipherText.trim() || !key) {
    return '';
  }
  try {
    return decryptPayload(cipherText.trim(), key);
  } catch {
    return '';
  }
}

interface CommContext {
  identity: BrandIdentity;
  device: DeviceIdentity;
  platform: Platform;
  layout: BrandLayout;
  token: string;
  code: string;
  isVip?: boolean;
  isUnlimited?: boolean;
  /** `last_active_domain` — the host that last answered successfully. */
  lastActiveDomain: string;
  key: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

function buildComm(ctx: CommContext, timestampMs: number): string {
  return commonParams({
    identity: ctx.identity,
    device: ctx.device,
    platform: ctx.platform,
    timestampMs,
    token: ctx.token,
    code: ctx.code,
    isVip: ctx.isVip,
    unlimited: ctx.isUnlimited
  }, ctx.layout);
}

/**
 * `getCommStr()` domain priority: last active, then the api_links array, then
 * `getApiDomain()`, then the remaining seeds. The first non-empty response wins.
 */
async function getCommStr(
  ctx: CommContext,
  apiLinks: string[],
  apiDomain: string,
  uri: string,
  params: string,
  seedDomains: string[]
): Promise<string> {
  const lastActive = ctx.lastActiveDomain;
  const candidates: string[] = [];
  // `last_active_domain` is first in the app: the host that last answered is
  // kept, so every later call stays on the control plane that served eversion.
  for (const value of [lastActive, ...apiLinks, apiDomain, ...seedDomains]) {
    if (value && !candidates.includes(value)) {
      candidates.push(value);
    }
  }
  for (const base of candidates) {
    // `build_url()` is domain + uri + comm params + the call's own params.
    const url = buildUrl(`${base.replace(/\/+$/, '')}${uri}`, buildComm(ctx, Date.now()) + params);
    const response = await fetchText(ctx.fetchImpl, url, ctx.timeoutMs);
    const decrypted = decodeControlPlane(response.text, ctx.key ?? '');
    if (decrypted) {
      ctx.lastActiveDomain = base;
      return decrypted;
    }
  }
  return '';
}

/**
 * Same domain walk as `getCommStr`, but keeps the response as sent.
 *
 * `/myapi/apinodelist` is the one control-plane call that answers in plain
 * JSON; everything else is AES-wrapped, and only this endpoint needs the raw
 * body for the `res` tree the app renders.
 */
async function getRawCommStr(
  ctx: CommContext,
  apiLinks: string[],
  apiDomain: string,
  uri: string,
  params: string,
  seedDomains: string[]
): Promise<string> {
  const candidates: string[] = [];
  for (const value of [ctx.lastActiveDomain, ...apiLinks, apiDomain, ...seedDomains]) {
    if (value && !candidates.includes(value)) {
      candidates.push(value);
    }
  }
  for (const base of candidates) {
    const url = buildUrl(`${base.replace(/\/+$/, '')}${uri}`, buildComm(ctx, Date.now()) + params);
    const response = await fetchText(ctx.fetchImpl, url, ctx.timeoutMs);
    if (response.text.trim()) {
      ctx.lastActiveDomain = base;
      return response.text;
    }
  }
  return '';
}

export interface EversionResult {
  /** Seed host that answered; becomes `last_active_domain`. */
  domain: string;
  key: string;
  api_links: string[];
  api_lines: string;
  payload: Record<string, unknown>;
}

/**
 * `/api/eversion` is the one endpoint that must succeed without a session, and
 * its response reveals the AES key: the key is the one that turns the body into
 * JSON. Candidates come from the configured value and the two known constants.
 */
export async function resolveEversion(
  fetchImpl: typeof fetch,
  seedDomains: string[],
  comm: (ts: number) => string,
  keyCandidates: string[],
  timeoutMs: number
): Promise<EversionResult | null> {
  for (const base of seedDomains) {
    const url = buildUrl(`${base.replace(/\/+$/, '')}/api/eversion`, comm(Date.now()));
    const response = await fetchText(fetchImpl, url, timeoutMs);
    if (!response.text) {
      continue;
    }
    for (const key of keyCandidates) {
      const plain = decodeControlPlane(response.text, key);
      if (!plain) {
        continue;
      }
      try {
        const payload = JSON.parse(plain) as Record<string, unknown>;
        return {
          domain: base,
          key,
          api_links: apiLinkValues(payload.api_links),
          api_lines: apiLineValue(payload.api_lines),
          payload
        };
      } catch {
        // Wrong key produces mojibake, not JSON; try the next candidate.
      }
    }
  }
  return null;
}

export function parseRouteGroups(payload: string): RouteGroup[] {
  try {
    const parsed = JSON.parse(payload) as { res?: unknown };
    const groups = Array.isArray(parsed.res) ? parsed.res : [];
    return groups.map((group) => {
      const record = group as Record<string, unknown>;
      const nodes = Array.isArray(record.data) ? record.data : [];
      return {
        cid: Number(record.cid ?? -1),
        cname: String(record.cname ?? ''),
        open: Number(record.open ?? 0),
        nodes: nodes.map((node) => {
          const item = node as Record<string, unknown>;
          return {
            id: Number(item.id ?? -1),
            name: String(item.name ?? ''),
            enable: Number(item.enable ?? 0),
            enable_desc: String(item.enable_desc ?? '')
          };
        })
      };
    });
  } catch {
    return [];
  }
}

/**
 * `api_links` is a plain string array on most brands and an `{key, value}`
 * array on 旋风, whose `value` field is the endpoint.
 */
export function apiLinkValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
    } else if (item && typeof item === 'object') {
      const value = (item as Record<string, unknown>).value;
      if (typeof value === 'string' && value.trim()) {
        out.push(value.trim());
      }
    }
  }
  return out;
}

/**
 * `api_lines` is a single URL on most brands and a `{key, value}` list on 旋风,
 * where each entry is a separately labelled route table.
 */
export function apiLineValue(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) {
        return item.trim();
      }
      if (item && typeof item === 'object') {
        const value = (item as Record<string, unknown>).value;
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
    }
  }
  return '';
}

function eversionStrings(payload: Record<string, unknown>): { apiLinks: string[]; apiLines: string } {
  return {
    apiLinks: apiLinkValues(payload.api_links),
    apiLines: apiLineValue(payload.api_lines)
  };
}

function event(options: CredentialExtractOptions, type: string, payload: Record<string, unknown>): void {
  options.eventCallback?.(type, payload);
}

async function defaultLoadApk(
  source: BrandCredentialSource,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: Date,
  log: (message: string) => void,
  brandName = ''
): Promise<Buffer | null> {
  if (source.apk_path) {
    try {
      const { readFile } = await import('node:fs/promises');
      return await readFile(source.apk_path);
    } catch {
      return null;
    }
  }
  if (source.apk_url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 120_000));
    try {
      const response = await fetchImpl(source.apk_url, { signal: controller.signal });
      if (!response.ok) {
        return null;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const site = String(source.official_site ?? '').trim().replace(/\/+$/, '');
  if (!site) {
    return null;
  }

  // The site names its download chunk; that chunk points at a cdn.js which
  // declares the download hosts and the archive cadence.
  const home = await fetchText(fetchImpl, `${site}/`, timeoutMs);
  if (!home.text) {
    log(`[extract] official site unreachable: ${site}`);
    return null;
  }
  const hosts: string[] = [];
  let interval = 0;
  let prefix = '';

  const consumeChunk = async (chunkText: string, chunkUrl: string): Promise<void> => {
    // Some brands hardcode the download origin and slot formula in the chunk.
    // The filename is assembled at runtime (`'…_mf'+index+'apk'`), so the host
    // and the interval are read separately rather than from one literal path.
    const hostsInChunk = [...chunkText.matchAll(/https?:\/\/([a-z0-9.-]+)\/apks64\//gi)]
      .map((match) => `https://${match[1]}`);
    if (hostsInChunk.length > 0) {
      hosts.push(...hostsInChunk);
      const prefixInChunk = /apks64\/[^"'`+]*_([a-z]{2,6})["'`+]?\s*\+\s*index/i.exec(chunkText)
        ?? /apks64\/[^"'`]*_([a-z]{2,6})\d*\.apk/i.exec(chunkText);
      if (prefixInChunk) {
        prefix = prefix || prefixInChunk[1].toLowerCase();
      }
      const intervalMatch = /getHours\(\)\s*\*\s*(\d+)\s*\+\s*Math\.floor\([^)]*getMinutes\(\)\s*\/\s*(\d+)\)/.exec(chunkText);
      if (intervalMatch) {
        interval = interval || Number.parseInt(intervalMatch[2], 10);
      }
    }
    // Others load a `cdn.js` that declares the hosts and the archive cadence.
    const cdnRefs = [
      ...chunkText.matchAll(/["'`]([^"'`]*cdn[^"'`]*\.js[^"'`]*)["'`]/gi)
    ].map((match) => match[1]);
    for (const reference of cdnRefs) {
      let cdnUrl: string;
      try {
        cdnUrl = new URL(reference, chunkUrl).toString();
      } catch {
        continue;
      }
      const cdn = await fetchText(fetchImpl, cdnUrl, timeoutMs);
      if (!cdn.text) {
        continue;
      }
      const config = parseCdnConfig(cdn.text);
      hosts.push(...config.download_hosts);
      if (config.apk_interval_minutes) {
        interval = interval || config.apk_interval_minutes;
      }
    }
  };

  // The page's own entry bundle references its lazy route chunks; the Android
  // downloader lives in one of those, so the dep map has to be followed.
  const seenChunks = new Set<string>();
  const pending = androidChunkUrls(home.text, site);
  while (pending.length > 0 && hosts.length === 0) {
    const chunkUrl = pending.shift() as string;
    if (seenChunks.has(chunkUrl)) {
      continue;
    }
    seenChunks.add(chunkUrl);
    const chunk = await fetchText(fetchImpl, chunkUrl, timeoutMs);
    if (!chunk.text) {
      continue;
    }
    await consumeChunk(chunk.text, chunkUrl);
    if (hosts.length === 0) {
      // Follow one level of chunk references to reach the actual downloader.
      for (const nested of chunk.text.matchAll(/["'`](\.\/?[\w.-]+\.js|\.\.\/[\w.-]+\.js)["'`]/g)) {
        try {
          const next = new URL(nested[1], chunkUrl).toString();
          if (!seenChunks.has(next)) {
            pending.push(next);
          }
        } catch {
          // Ignore unresolvable references.
        }
      }
    }
  }

  // Fall back to the root `cdn.js`, which two of the brands serve directly.
  if (hosts.length === 0) {
    for (const cdnUrl of cdnConfigUrls(site, now.getTime())) {
      const cdn = await fetchText(fetchImpl, cdnUrl, timeoutMs);
      if (!cdn.text) {
        continue;
      }
      const config = parseCdnConfig(cdn.text);
      hosts.push(...config.download_hosts);
      if (config.apk_interval_minutes) {
        interval = interval || config.apk_interval_minutes;
      }
      if (hosts.length) {
        break;
      }
    }
  }
  if (!hosts.length) {
    log(`[extract] no download host found on ${site}`);
    return null;
  }
  // The archive filename prefix (`20261108_lt463.apk`) is not published by every
  // site. It is derived from the site host when it is not in the chunk, and the
  // per-brand table covers the case where neither is available.
  if (!prefix) {
    prefix = BRAND_APK_PREFIXES[brandName] ?? BRAND_APK_PREFIXES[siteHost(site)] ?? 'apk';
  }
  if (!interval) {
    interval = 1;
  }

  for (const candidate of candidateApkUrls([...new Set(hosts)], prefix, now, interval)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 120_000));
    try {
      const response = await fetchImpl(candidate, { signal: controller.signal });
      if (!response.ok) {
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 1_000_000 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
        log(`[extract] apk ${candidate} (${(bytes.length / 1_048_576).toFixed(1)} MB)`);
        return bytes;
      }
    } catch {
      // Try the next slot.
    } finally {
      clearTimeout(timer);
    }
  }
  log(`[extract] no APK published for ${prefix} near slot ${apkSlot(now, interval)}`);
  return null;
}

/**
 * Runs the credential flow for one brand.
 *
 * Returns the same shape the legacy URL source produced so the rest of the
 * pipeline (dedupe, speed test, availability, render, deploy) is unchanged.
 */
export async function fetchCredentialSourceLinks(
  input: ExtractInput,
  options: CredentialExtractOptions = {}
): Promise<CredentialExtractResult> {
  const source = input.source as SourceConfigInput & BrandCredentialSource;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const now = (options.now ?? (() => new Date()))();
  const timeoutMs = Number(source.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  const platform: Platform = source.platform === 'ios' ? 'ios' : 'android';
  const device: DeviceIdentity = {
    device_id: source.device_id ?? DEFAULT_DEVICE_ID,
    install_date: source.install_date ?? today(now)
  };
  const errors: string[] = [];
  const log = (message: string) => event(options, 'log', { message });
  const diagnostics: CredentialDiagnostics = {
    brand: input.source_name,
    platform,
    apk_url: '',
    package_name: '',
    version_name: '',
    seed_domains: [],
    api_domain: '',
    route_count: 0,
    node_count: 0,
    placeholder_count: 0,
    errors
  };

  const empty: CredentialExtractResult = {
    source_name: input.source_name,
    requested_iterations: 0,
    successful_iterations: 0,
    failed_iterations: 0,
    links: [],
    diagnostics
  };

  if (!fetchImpl) {
    errors.push('fetch is unavailable');
    return empty;
  }
  const account = String(source.account ?? '').trim();
  const password = String(source.password ?? '').trim();
  if (!account || !password) {
    errors.push('account and password are required');
    return empty;
  }

  event(options, 'extract_source_started', {
    source_name: input.source_name,
    requested_iterations: 0,
    min_iterations: 0,
    resume_from_iteration: 1
  });

  // 1) Brand fingerprint: package, version, certificate and seed domains.
  //
  // These only change when the vendor publishes a new build, so a cached entry
  // is used first and the APK is inspected only when the cached seeds all stop
  // answering. That keeps a normal run to a handful of HTTP calls.
  const store = options.fingerprintStore ?? null;
  const memo = options.memo ?? createFingerprintMemo(store, input.source_name);
  const cached = memo.get();

  const inspectApk = async (): Promise<ApkDiscovery | null> => {
    let apkBytes: Buffer | null = null;
    try {
      apkBytes = options.loadApk
        ? await options.loadApk(source)
        : await defaultLoadApk(source, fetchImpl, timeoutMs, now, log, input.source_name);
    } catch (error) {
      errors.push(`apk: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!apkBytes) {
      errors.push('APK could not be located');
      return null;
    }
    const discovered = apkDiscoveryFromBytes(apkBytes, source.apk_url ?? '');
    log(`[extract] ${discovered.package_name} ${discovered.version_name} seeds=${discovered.seed_domains.length}`);
    return discovered.seed_domains.length > 0 ? discovered : null;
  };

  let discovery: ApkDiscovery | null = cached;
  let keyCandidates = credentialKeyCandidates(source, cached ?? undefined);
  let eversion: EversionResult | null = null;

  if (discovery) {
    log(`[extract] cached fingerprint ${discovery.package_name} ${discovery.version_name}`);
    eversion = await tryEversion(discovery, keyCandidates);
    if (eversion) {
      store?.touch(input.source_name);
    } else {
      log('[extract] cached seeds stopped answering; re-inspecting the APK');
      discovery = null;
    }
  }

  if (!discovery) {
    discovery = await inspectApk();
    if (!discovery) {
      errors.push('APK could not be located');
      return { ...empty, failed_iterations: 1 };
    }
    keyCandidates = credentialKeyCandidates(source, discovery);
    eversion = await tryEversion(discovery, keyCandidates);
    if (!eversion) {
      errors.push('eversion failed on every seed');
      return { ...empty, failed_iterations: 1 };
    }
    memo.set(discovery);
    store?.write(input.source_name, discovery);
  }

  diagnostics.apk_url = discovery.apk_url;
  diagnostics.package_name = discovery.package_name;
  diagnostics.version_name = discovery.version_name;
  diagnostics.seed_domains = discovery.seed_domains;
  if (!eversion) {
    errors.push('eversion failed on every seed');
    return { ...empty, failed_iterations: 1 };
  }

  const identity: BrandIdentity = {
    seed_domains: discovery.seed_domains,
    package_name: discovery.package_name,
    version_name: discovery.version_name,
    cert_sha1: discovery.cert_sha1,
    protocol: discovery.protocol,
    core_version: discovery.core_version,
    lite_version: discovery.lite_version
  };

  /** Runs eversion for one candidate fingerprint. */
  async function tryEversion(candidate: ApkDiscovery, keys: string[]): Promise<EversionResult | null> {
    return resolveEversion(
      fetchImpl,
      candidate.seed_domains,
      (ts) => commonParams({
        identity: {
          seed_domains: candidate.seed_domains,
          package_name: candidate.package_name,
          version_name: candidate.version_name,
          cert_sha1: candidate.cert_sha1,
          protocol: candidate.protocol,
          core_version: candidate.core_version,
          lite_version: candidate.lite_version
        },
        device,
        platform,
        timestampMs: ts,
        code: ''
      }, resolveBrandLayout({ ...source, brand: input.source_name })),
      keys,
      timeoutMs
    );
  }
  log(`[extract] eversion ok key=${eversion.key.slice(0, 6)}*** api_links=${eversion.api_links.length}`);

  const ctx: CommContext = {
    identity,
    device,
    platform,
    layout: resolveBrandLayout({ ...source, brand: input.source_name }),
    token: '',
    // Before login the app's local KV has no `code`, so the request carries an
    // empty one; `&code=` only holds a value once the account has one.
    code: '',
    lastActiveDomain: eversion.domain,
    key: eversion.key,
    fetchImpl,
    timeoutMs
  };
  const apiDomain = selectApiDomain(discovery.seed_domains, device.device_id);
  diagnostics.api_domain = apiDomain;
  const eversionFields = eversionStrings(eversion.payload);

  // 3) `/myapi/eapilogin`: obtain the session token.
  const loginParams = `&phone=${encodeURIComponent(account)}&passwd=${encodeURIComponent(password)}&ver_code=&sign=${loginSignature(account, password)}`;
  const loginPlain = await getCommStr(
    ctx, eversionFields.apiLinks, apiDomain, '/myapi/eapilogin?', loginParams, discovery.seed_domains
  );
  if (!loginPlain) {
    errors.push('login returned nothing');
    return { ...empty, failed_iterations: 1 };
  }
  let token = '';
  try {
    const payload = JSON.parse(loginPlain) as Record<string, unknown>;
    if (Number(payload.code) !== 0) {
      errors.push(`login rejected: code=${String(payload.code)} msg=${String(payload.msg ?? '')}`);
      return { ...empty, failed_iterations: 1 };
    }
    token = String(payload.token ?? '');
  } catch {
    errors.push('login response was not JSON');
    return { ...empty, failed_iterations: 1 };
  }
  if (!token) {
    errors.push('login returned no token');
    return { ...empty, failed_iterations: 1 };
  }
  ctx.token = token;
  // `&code=` must be non-empty from here on: the server answers an empty body
  // when it is blank, so the value from the profile (or the app's default) is
  // used once a session exists.
  ctx.code = String(source.code ?? '').trim() || 'Z2E4QG';
  log('[extract] login ok');

  // `/myapi/eapiuserinfo` carries the real level and unlimit flags.
  try {
    const infoPlain = await getCommStr(
      ctx, eversionFields.apiLinks, apiDomain, '/myapi/eapiuserinfo', '', discovery.seed_domains
    );
    if (infoPlain) {
      const info = JSON.parse(infoPlain) as Record<string, unknown>;
      const detail = (info.info ?? {}) as Record<string, unknown>;
      const codeInfo = (info.code_info ?? {}) as Record<string, unknown>;
      const level = Number(detail.level ?? 0);
      const unlimit = String(codeInfo.unlimit ?? '').trim();
      ctx.isVip = level >= 2;
      ctx.isUnlimited = unlimit === '1';
    }
  } catch {
    // Defaults keep isvip/unlimit enabled, matching a paid account.
  }

  // 4) `/myapi/apinodelist`: the clickable route ids.
  const routeGroups = parseRouteGroups(
    await getRawCommStr(
      ctx, eversionFields.apiLinks, apiDomain,
      pathAndQuery(eversionFields.apiLines), '', discovery.seed_domains
    )
  );
  let routes: RouteNode[] = flattenRouteGroups(routeGroups);
  if (source.max_areas && source.max_areas > 0) {
    routes = routes.slice(0, source.max_areas);
  }
  diagnostics.route_count = routes.length;
  if (!routes.length) {
    errors.push('node list was empty');
    return { ...empty, failed_iterations: 1 };
  }
  log(`[extract] routes=${routes.length}`);

  // 5) `/api/evmess?area=ID` per clickable route.
  const links: string[] = [];
  const seen = new Set<string>();
  let placeholders = 0;
  for (const route of routes) {
    if (!route.enabled) {
      continue;
    }
    const plain = await getCommStr(
      ctx, eversionFields.apiLinks, apiDomain, '/api/evmess', `&area=${route.area}`, discovery.seed_domains
    );
    if (!plain) {
      continue;
    }
    const decoded = extractLinksFromPlaintext(`${route.region}-${route.name}`, plain);
    for (const link of decoded) {
      if (isPlaceholderLink(link)) {
        placeholders += 1;
        continue;
      }
      if (!seen.has(link)) {
        seen.add(link);
        links.push(link);
      }
    }
    if (links.length > 0 && links.length % 8 === 0) {
      await options.linksCallback?.(links.slice(-8));
    }
  }
  diagnostics.placeholder_count = placeholders;
  diagnostics.node_count = links.length;
  await options.linksCallback?.(links);

  event(options, 'extract_source_completed', {
    source_name: input.source_name,
    requested_iterations: routes.length,
    successful_iterations: routes.length - errors.length,
    failed_iterations: errors.length,
    raw_links: links.length
  });

  return {
    source_name: input.source_name,
    requested_iterations: routes.length,
    successful_iterations: routes.length,
    failed_iterations: 0,
    links,
    diagnostics
  };
}

function isPlaceholderLink(link: string): boolean {
  try {
    const encoded = link.replace(/^vmess:\/\//, '');
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>;
    return isPlaceholderNode(String(payload.add ?? ''));
  } catch {
    return false;
  }
}
