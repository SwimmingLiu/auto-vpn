import { createHash } from 'node:crypto';

import {
  androidChunkUrls,
  apkDiscoveryFromBytes,
  inlineDownloadSpec,
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
  selectForeignRoutes,
  type BrandIdentity,
  type DeviceIdentity,
  type Platform,
  type RouteGroup,
  type RouteNode
} from './brand-protocol.js';
import { decryptPayload, extractLinksFromPlaintext } from './extract.js';
import { AccountStore, type StoredAccount } from '../pool/account-store.js';
import { brandFromSite, normalizeBrand } from '../pool/brands.js';
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
  /** Legacy single-channel field; ignored by the pool-backed flow. */
  platform?: Platform;
  /** Internal/test override. Omitted means Android and iOS run concurrently. */
  platforms?: Platform[];
  /** Pool accounts to try after an explicit credential rejection. */
  account_retry_limit?: number;
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
  /** Keep the free tier's rows. Off: they answer with placeholders. */
  include_free_routes?: boolean;
  /** Keep mainland and return-to-China rows. Off: wrong direction. */
  include_china_routes?: boolean;
  /** Upper bound on request rounds; each round asks every enabled route once. */
  max_iterations?: number;
  /** Rounds that always run before a plateau may stop the run. */
  min_iterations?: number;
  /** Consecutive rounds without a new link that stop the run. */
  plateau_limit?: number;
  /** Wall-clock budget in seconds; 0 means unlimited. */
  max_runtime_seconds?: number;
  /** Per-request timeout in milliseconds. */
  timeout_ms?: number;
}

export type CredentialFetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok?: boolean;
  status?: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * The extract backend's own fetch shape, which does not promise `arrayBuffer`.
 * The APK download needs it; the text calls do not.
 */
export type CredentialTextFetch = (url: string, init?: Record<string, unknown>) => Promise<{
  ok?: boolean;
  status?: number;
  text(): Promise<string>;
}>;

export interface CredentialExtractOptions {
  /** Injectable for tests; production passes `globalThis.fetch`. */
  fetchImpl?: CredentialTextFetch | CredentialFetchLike;
  now?: () => Date;
  eventCallback?: (type: string, payload: Record<string, unknown>) => void;
  linksCallback?: (links: string[]) => void | Promise<void>;
  /** Injected for tests: returns the APK bytes for a brand. */
  loadApk?: (source: BrandCredentialSource) => Promise<Buffer | null>;
  /** Persistent fingerprint cache; when absent the APK is inspected each run. */
  fingerprintStore?: FingerprintStore;
  /** Shared in-memory fingerprint, so several sources of one brand inspect once. */
  memo?: FingerprintMemo;
  /** Test seam for the account pool; production opens the runtime SQLite DB. */
  accountStore?: AccountStore;
  /**
   * Egress settings, forwarded from the extract backend so a credential source
   * behaves like a url source on networks that need a proxy or a TLS fallback.
   */
  env?: NodeJS.ProcessEnv;
  curlFetch?: (url: string, proxyUrl: string) => Promise<string>;
}

export interface CredentialDiagnostics {
  brand: string;
  platform: Platform | 'android+ios';
  platforms?: Platform[];
  platform_results?: Array<{
    platform: Platform;
    links: number;
    rounds: number;
    requests: number;
    errors: string[];
  }>;
  login_ok?: boolean;
  login_rejected?: boolean;
  credential_rejected?: boolean;
  membership_expires_at?: string;
  membership_level?: number;
  apk_url: string;
  package_name: string;
  version_name: string;
  seed_domains: string[];
  api_domain: string;
  route_count: number;
  /** Route tables merged; 旋风 advertises two, the others one. */
  route_tables?: number;
  /** Rows removed before the round loop, by reason. */
  routes_dropped?: { free: number; china: number; disabled: number; duplicate: number };
  node_count: number;
  placeholder_count: number;
  /** Rounds actually executed (one request per enabled route per round). */
  rounds: number;
  /** Total `/api/evmess` requests issued. */
  requests: number;
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

/**
 * Stable key for a brand's fingerprint.
 *
 * A profile may name two sources of the same brand (`leiting`, `leiting_ios`),
 * and both resolve to the same APK: the package, certificate and seeds do not
 * depend on the profile entry. Keying the cache and the in-run memo by that
 * identity means one download and one inspection per brand, and one cache file
 * that both sources share. Falls back to the source name when the brand can't
 * be established, which keeps custom entries working.
 */
export function credentialBrandKey(sourceName: string, source: BrandCredentialSource): string {
  const site = String(source.official_site ?? '').trim();
  const host = siteHost(site);
  if (host) {
    return BRAND_APK_PREFIXES[host] ?? host;
  }
  const name = String(sourceName ?? '').trim().toLowerCase();
  const prefix = BRAND_APK_PREFIXES[sourceName] ?? BRAND_APK_PREFIXES[name];
  return prefix ?? (name || 'unknown');
}

/** A fingerprint shared across the sources of one pipeline run. */
export interface FingerprintMemo {
  get(): ApkDiscovery | null;
  set(value: ApkDiscovery | null): void;
  /** Coalesce concurrent APK inspections for the same brand. */
  resolve?(loader: () => Promise<ApkDiscovery | null>): Promise<ApkDiscovery | null>;
}

export function createFingerprintMemo(store: FingerprintStore | null, brand: string): FingerprintMemo {
  let value: ApkDiscovery | null = store?.read(brand) ?? null;
  let pending: Promise<ApkDiscovery | null> | null = null;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
    resolve: (loader) => {
      // Android and iOS start together. Without this both would see an empty
      // memo and download the same 20-30 MB APK before either could set it.
      pending ??= loader().finally(() => {
        pending = null;
      });
      return pending;
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

function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function today(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Round control for the repeated `/api/evmess` fetch.
 *
 * The server answers the same `area` with a different landing host on each
 * request, so one pass over the route list only sees one host per route. The
 * settings below decide how many passes run before the pool stops growing.
 */
export interface RoundPolicy {
  max_iterations: number;
  min_iterations: number;
  plateau_limit: number;
  max_runtime_seconds: number;
}

export function resolveRoundPolicy(source: { max_iterations?: number; min_iterations?: number; plateau_limit?: number; max_runtime_seconds?: number }): RoundPolicy {
  const maxIterations = Math.max(1, Math.trunc(numberOrDefault(source.max_iterations, 1)));
  const configuredMin = Math.max(0, Math.trunc(numberOrDefault(source.min_iterations, 0)));
  return {
    max_iterations: maxIterations,
    // A minimum above the maximum would otherwise make the cap unreachable.
    min_iterations: Math.min(configuredMin, maxIterations),
    plateau_limit: Math.max(1, Math.trunc(numberOrDefault(source.plateau_limit, 2))),
    max_runtime_seconds: Math.max(0, numberOrDefault(source.max_runtime_seconds, 0))
  };
}

/** The floor always runs; past it, the runtime budget can stop the loop. */
export function shouldStartRound(round: number, policy: RoundPolicy, elapsedSeconds: number): boolean {
  if (round > policy.max_iterations) {
    return false;
  }
  if (policy.max_runtime_seconds <= 0 || round <= policy.min_iterations) {
    return true;
  }
  return elapsedSeconds < policy.max_runtime_seconds;
}

/** Stops only once the floor has run and the pool has plateaued. */
export function shouldStopOnPlateau(round: number, plateau: number, policy: RoundPolicy): boolean {
  return plateau >= policy.plateau_limit && round >= policy.min_iterations;
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

/**
 * Egress settings shared by every request the credential flow makes.
 *
 * A TLS-intercepting network or a configured upstream proxy breaks plain
 * `fetch`, and the url mode already falls back to curl for exactly that case;
 * both modes must agree, so the settings travel with the context.
 */
interface Egress {
  env?: NodeJS.ProcessEnv;
  curlFetch?: (url: string, proxyUrl: string) => Promise<string>;
}

function isEnabled(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function upstreamProxyUrl(env: NodeJS.ProcessEnv | undefined): string {
  if (!env || !isEnabled(env.VPN_AUTOMATION_USE_UPSTREAM_PROXY)) {
    return '';
  }
  const value = String(env.VPN_AUTOMATION_UPSTREAM_PROXY ?? 'http://127.0.0.1:7897').trim();
  return ['', 'off', 'none', 'false', '0'].includes(value.toLowerCase()) ? '' : value;
}

async function fetchText(
  fetchImpl: CredentialTextFetch,
  url: string,
  timeoutMs: number,
  egress?: Egress
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
    // Same fallback the url mode applies: curl handles a proxy or a
    // self-signed/intercepted TLS chain that Node's fetch rejects.
    const proxyUrl = upstreamProxyUrl(egress?.env);
    if (!egress?.curlFetch) {
      return { text: '', url, ok: false };
    }
    try {
      const text = await egress.curlFetch(url, proxyUrl);
      return text.trim() ? { text, url, ok: true } : { text: '', url, ok: false };
    } catch {
      return { text: '', url, ok: false };
    }
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
  fetchImpl: CredentialTextFetch;
  timeoutMs: number;
  egress?: Egress;
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
    const response = await fetchText(ctx.fetchImpl, url, ctx.timeoutMs, ctx.egress);
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
    const response = await fetchText(ctx.fetchImpl, url, ctx.timeoutMs, ctx.egress);
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
  /** Every route table the vendor advertises; 旋风 ships two. */
  api_lines: string[];
  payload: Record<string, unknown>;
}

/**
 * `/api/eversion` is the one endpoint that must succeed without a session, and
 * its response reveals the AES key: the key is the one that turns the body into
 * JSON. Candidates come from the configured value and the two known constants.
 */
export async function resolveEversion(
  fetchImpl: CredentialTextFetch,
  seedDomains: string[],
  comm: (ts: number) => string,
  keyCandidates: string[],
  timeoutMs: number,
  egress?: Egress
): Promise<EversionResult | null> {
  for (const base of seedDomains) {
    const url = buildUrl(`${base.replace(/\/+$/, '')}/api/eversion`, comm(Date.now()));
    const response = await fetchText(fetchImpl, url, timeoutMs, egress);
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
          api_lines: apiLineValues(payload.api_lines),
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
 *
 * Every entry is returned. 旋风 ships two tables (黄金/白金) whose area ids
 * overlap but do not coincide, so taking only the first silently dropped half
 * its routes; the caller merges them and dedupes by area.
 */
export function apiLineValues(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return raw.trim() ? [raw.trim()] : [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      if (!out.includes(item.trim())) out.push(item.trim());
      continue;
    }
    if (item && typeof item === 'object') {
      const value = (item as Record<string, unknown>).value;
      if (typeof value === 'string' && value.trim() && !out.includes(value.trim())) {
        out.push(value.trim());
      }
    }
  }
  return out;
}

function eversionStrings(payload: Record<string, unknown>): { apiLinks: string[]; apiLines: string[] } {
  return {
    apiLinks: apiLinkValues(payload.api_links),
    apiLines: apiLineValues(payload.api_lines)
  };
}

function event(options: CredentialExtractOptions, type: string, payload: Record<string, unknown>): void {
  options.eventCallback?.(type, payload);
}

/**
 * A real APK is 20-30 MB. The download host is scraped from vendor JS rather
 * than pinned, so an oversized body (or a redirect to one) must be refused
 * instead of buffered into memory.
 */
const MAX_APK_BYTES = 96 * 1024 * 1024;

/** Refuses a response whose declared size already exceeds the cap. */
function declaredSizeTooLarge(response: unknown): boolean {
  const raw = (response as { headers?: { get?(name: string): string | null } })?.headers?.get?.('content-length');
  if (!raw) {
    return false;
  }
  const length = Number(raw);
  return Number.isFinite(length) && length > MAX_APK_BYTES;
}

async function defaultLoadApk(
  source: BrandCredentialSource,
  fetchImpl: CredentialFetchLike,
  timeoutMs: number,
  now: Date,
  log: (message: string) => void,
  brandName = '',
  egress?: Egress
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
      if (!response.ok || typeof response.arrayBuffer !== 'function') {
        return null;
      }
      if (declaredSizeTooLarge(response)) {
        log(`[extract] apk at ${source.apk_url} exceeds ${MAX_APK_BYTES} bytes; refusing`);
        return null;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length > MAX_APK_BYTES ? null : bytes;
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
  const home = await fetchText(fetchImpl, `${site}/`, timeoutMs, egress);
  if (!home.text) {
    log(`[extract] official site unreachable: ${site}`);
    return null;
  }
  const hosts: string[] = [];
  let interval = 0;
  let prefix = '';

  const consumeChunk = async (chunkText: string, chunkUrl: string): Promise<void> => {
    // Some brands hardcode the download origin and slot formula in the chunk.
    // The helper keeps the published scheme and port, so nothing is rewritten.
    const inline = inlineDownloadSpec(chunkText);
    if (inline) {
      hosts.push(inline.host);
      prefix = prefix || inline.prefix;
      if (inline.interval_minutes > 0) {
        interval = interval || inline.interval_minutes;
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
      const cdn = await fetchText(fetchImpl, cdnUrl, timeoutMs, egress);
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
    const chunk = await fetchText(fetchImpl, chunkUrl, timeoutMs, egress);
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
      const cdn = await fetchText(fetchImpl, cdnUrl, timeoutMs, egress);
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
      if (!response.ok || typeof response.arrayBuffer !== 'function') {
        continue;
      }
      if (declaredSizeTooLarge(response)) {
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_APK_BYTES) {
        continue;
      }
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

export function resolveCredentialPlatforms(source: Pick<BrandCredentialSource, 'platforms'>): Platform[] {
  const requested = Array.isArray(source.platforms) ? source.platforms : [];
  const unique = [...new Set(requested.filter((value): value is Platform => value === 'android' || value === 'ios'))];
  // The product contract is both client channels, concurrently. A legacy
  // `platform = "ios"` row is not a choice any more; only the internal
  // `platforms` override can narrow a run for tests or protocol debugging.
  return unique.length > 0 ? unique : ['android', 'ios'];
}

/** A transport failure or stale signing cert must not retire a good account. */
/**
 * Throttling and session wording, which mentions the account without meaning
 * the password is wrong.
 *
 * A vendor rate limit reads `账号登录过于频繁`; retiring the account for that
 * burns a healthy credential and moves to the next one, which is then also
 * throttled, until the whole brand's pool is marked invalid.
 */
const TRANSIENT_LOGIN_PATTERN =
  /频繁|頻繁|过于|過於|稍后|稍後|稍候|重试|重試|too\s*many|rate\s*limit|frequency|try\s*(again|later)|timeout|超时|超時|繁忙|busy|服务器|服務器|server\s*error|network|网络|網絡/i;

/**
 * True only when the vendor said the credential itself is wrong.
 *
 * Conservative on purpose: a wrong classification retires a working account,
 * while a missed one merely fails the run, which the retry path already covers.
 */
export function isCredentialLoginRejection(message: string): boolean {
  const text = String(message ?? '');
  if (!text.trim()) return false;
  if (TRANSIENT_LOGIN_PATTERN.test(text)) return false;
  return /密码错误|密碼錯誤|密码不正确|密碼不正確|账号不存在|帳號不存在|账户不存在|账户或密码|账号或密码|账号已被|帳號已被|密码已|被封禁|已被禁用|登录失败|登錄失敗|does\s*not\s*exist|not\s*(found|exist)|invalid\s*(password|account|credential|user)|incorrect\s*password|wrong\s*password|unauthorized/i.test(text);
}

export function membershipDate(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) {
    // A bare number too short to be an epoch is a placeholder, not a date:
    // `new Date('0')` would otherwise read as the year 2000.
    return /^\d{10,13}$/.test(text) ? membershipDate(Number(text)) : '';
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function credentialRejectionMessage(payload: Record<string, unknown>): string {
  return String(payload.msg ?? payload.message ?? '');
}

/**
 * Pool-backed brand extraction. Android and iOS run concurrently against the
 * same leased account; their links merge into the one source stream the rest of
 * the pipeline already consumes.
 */
export async function fetchCredentialSourceLinks(
  input: ExtractInput,
  options: CredentialExtractOptions = {}
): Promise<CredentialExtractResult> {
  const source = input.source as SourceConfigInput & BrandCredentialSource;
  const platforms = resolveCredentialPlatforms(source);
  const policy = resolveRoundPolicy(source);
  const errors: string[] = [];
  const diagnostics: CredentialDiagnostics = {
    brand: input.source_name,
    platform: platforms.length === 1 ? platforms[0] : 'android+ios',
    platforms,
    apk_url: '',
    package_name: '',
    version_name: '',
    seed_domains: [],
    api_domain: '',
    route_count: 0,
    node_count: 0,
    placeholder_count: 0,
    rounds: 0,
    requests: 0,
    errors
  };
  const empty: CredentialExtractResult = {
    source_name: input.source_name,
    requested_iterations: policy.max_iterations,
    successful_iterations: 0,
    failed_iterations: 0,
    links: [],
    diagnostics
  };
  event(options, 'extract_source_started', {
    source_name: input.source_name,
    requested_iterations: policy.max_iterations,
    min_iterations: policy.min_iterations,
    resume_from_iteration: 1,
    platforms
  });

  const explicitAccount = String(source.account ?? '').trim();
  const explicitPassword = String(source.password ?? '').trim();
  const brand = normalizeBrand(input.source_name)
    ?? brandFromSite(source.official_site)
    ?? normalizeBrand(credentialBrandKey(input.source_name, source));
  let store = options.accountStore ?? null;
  let ownsStore = false;
  let leased: StoredAccount | null = null;
  let account = explicitAccount;
  let password = explicitPassword;
  if (!account || !password) {
    if (!brand) {
      errors.push('account pool brand could not be resolved');
    } else {
      store = options.accountStore ?? new AccountStore({ env: options.env, now: options.now });
      ownsStore = !options.accountStore;
      leased = store.lease(brand);
      if (leased) {
        account = leased.account;
        password = leased.password;
      } else {
        errors.push(`account pool has no active ${brand} account`);
      }
    }
  }
  if (!account || !password) {
    if (ownsStore) store?.close();
    event(options, 'extract_source_completed', {
      source_name: input.source_name,
      requested_iterations: policy.max_iterations,
      successful_iterations: 0,
      failed_iterations: 1,
      raw_links: 0
    });
    return { ...empty, failed_iterations: 1 };
  }

  const memo = options.memo ?? createFingerprintMemo(options.fingerprintStore ?? null, credentialBrandKey(input.source_name, source));
  let linkQueue = Promise.resolve();
  // A non-numeric retry limit (a hand-edited `account_retry_limit = "three"`)
  // must not turn the attempt loop into zero passes, which reported the source
  // as successful with no links and no error.
  const retryLimit = Math.trunc(Number(source.account_retry_limit ?? 3));
  const attempts = explicitAccount && explicitPassword ? 1 : (Number.isFinite(retryLimit) && retryLimit >= 1 ? retryLimit : 3);
  let results: CredentialExtractResult[] = [];
  let callbackFailure: Error | null = null;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      results = await Promise.all(platforms.map((platform) => {
        const scoped: CredentialExtractOptions = {
          ...options,
          memo,
          eventCallback: (type, payload) => {
            if (type === 'extract_source_started') {
              event(options, 'extract_platform_started', { ...payload, platform });
              return;
            }
            if (type === 'extract_source_completed') {
              event(options, 'extract_platform_completed', { ...payload, platform });
              return;
            }
            if (type === 'log') {
              // Four brands × two channels run at once; a bare `[extract]`
              // line is unattributable in the log center.
              event(options, 'log', {
                message: String(payload.message ?? '').replace(/^\[extract\]/, `[extract][${input.source_name}][${platform}]`)
              });
              return;
            }
            event(options, type, { ...payload, platform });
          },
          linksCallback: (links) => {
            // SQLite writes are synchronous, but the downstream speed-test
            // submission is async. Serialize callbacks so two platforms cannot
            // interleave a partially processed batch. A downstream failure is
            // recorded and re-raised at the end instead of swallowed: the run
            // must not report a batch as delivered when the speed pool rejected
            // it, and the remaining rounds must stop feeding a dead chain.
            linkQueue = linkQueue.then(async () => {
              if (callbackFailure) return;
              try {
                await options.linksCallback?.(links);
              } catch (error) {
                callbackFailure = error instanceof Error ? error : new Error(String(error));
              }
            });
            return linkQueue;
          }
        };
        return fetchCredentialPlatformLinks({
          source_name: input.source_name,
          source: { ...source, account, password, platform, platforms: [platform] } as SourceConfigInput
        }, scoped);
      }));

      const loginOk = results.some((result) => result.diagnostics.login_ok);
      if (loginOk) {
        if (store && leased) {
          store.markSuccess(leased.id);
          const expires = results.map((result) => result.diagnostics.membership_expires_at ?? '').find(Boolean);
          if (expires) store.setExpiry(leased.brand, leased.account, expires);
          const level = results.map((result) => result.diagnostics.membership_level).find((value) => value !== undefined);
          const linked = results.some((result) => result.links.length > 0);
          // A free-tier account (level 0/1) only ever produces placeholders.
          // Retire it, but only when it actually produced nothing: a paid
          // account misreported as level 1 must not lose its row.
          if (level !== undefined && level < 2 && !linked) store.markInvalid(leased.id, 'no paid membership');
        }
        break;
      }
      const credentialRejected = results.length > 0 && results.every((result) => result.diagnostics.credential_rejected);
      if (store && leased && credentialRejected) {
        store.markInvalid(leased.id, 'login rejected');
        if (attempt < attempts && brand) {
          leased = store.lease(brand);
          if (leased) {
            account = leased.account;
            password = leased.password;
            continue;
          }
        }
      }
      break;
    }
  } finally {
    if (ownsStore) store?.close();
  }
  await linkQueue;

  const links: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    for (const link of result.links) {
      if (!seen.has(link)) {
        seen.add(link);
        links.push(link);
      }
    }
    for (const error of result.diagnostics.errors) {
      errors.push(`[${result.diagnostics.platform}] ${error}`);
    }
  }
  const first = results[0]?.diagnostics;
  if (first) {
    diagnostics.apk_url = first.apk_url;
    diagnostics.package_name = first.package_name;
    diagnostics.version_name = first.version_name;
    diagnostics.seed_domains = first.seed_domains;
    diagnostics.api_domain = first.api_domain;
  }
  diagnostics.route_count = Math.max(0, ...results.map((result) => result.diagnostics.route_count));
  diagnostics.route_tables = Math.max(0, ...results.map((result) => result.diagnostics.route_tables ?? 0));
  diagnostics.node_count = links.length;
  diagnostics.placeholder_count = results.reduce((total, result) => total + result.diagnostics.placeholder_count, 0);
  diagnostics.rounds = Math.max(0, ...results.map((result) => result.diagnostics.rounds));
  diagnostics.requests = results.reduce((total, result) => total + result.diagnostics.requests, 0);
  diagnostics.platform_results = results.map((result) => ({
    platform: result.diagnostics.platform as Platform,
    links: result.links.length,
    rounds: result.diagnostics.rounds,
    requests: result.diagnostics.requests,
    errors: result.diagnostics.errors
  }));
  const successful = Math.max(0, ...results.map((result) => result.successful_iterations));
  const failed = results.length === 0 ? 1 : Math.max(0, ...results.map((result) => result.failed_iterations));
  if (callbackFailure) {
    // Surfaced rather than logged: the orchestrator treats a thrown extract as
    // a failed source, which is the truth — its downstream already died.
    throw callbackFailure;
  }
  event(options, 'extract_source_completed', {
    source_name: input.source_name,
    requested_iterations: policy.max_iterations,
    successful_iterations: successful,
    failed_iterations: failed,
    raw_links: links.length,
    platforms
  });
  return {
    source_name: input.source_name,
    requested_iterations: policy.max_iterations,
    successful_iterations: successful,
    failed_iterations: failed,
    links,
    diagnostics
  };
}

/** One client channel. The public wrapper runs both and merges the results. */
export async function fetchCredentialPlatformLinks(
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
    rounds: 0,
    requests: 0,
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
  const brandKey = credentialBrandKey(input.source_name, source);
  const store = options.fingerprintStore ?? null;
  const memo = options.memo ?? createFingerprintMemo(store, brandKey);
  // A fingerprint past its trust window is still used when its seeds answer,
  // but it is re-verified against the APK rather than trusted indefinitely: a
  // vendor can rotate the signing certificate while the old seeds still serve
  // `/api/eversion`, and then every login fails on a stale certificate.
  const fresh = store?.readFresh(brandKey) ?? null;
  const storedEntry = store?.read(brandKey) ?? null;
  const staleButUsable = Boolean(storedEntry) && !fresh;
  const cached = staleButUsable ? storedEntry : memo.get();
  const egress: Egress = { env: options.env, curlFetch: options.curlFetch };

  const inspectApk = async (): Promise<ApkDiscovery | null> => {
    let apkBytes: Buffer | null = null;
    try {
      apkBytes = options.loadApk
        ? await options.loadApk(source)
        : await defaultLoadApk(source, fetchImpl as CredentialFetchLike, timeoutMs, now, log, input.source_name, egress);
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
  const inspectSharedApk = (): Promise<ApkDiscovery | null> => (
    memo.resolve ? memo.resolve(inspectApk) : inspectApk()
  );

  // `apk_url` / `apk_path` are an explicit override: when either is set the
  // caller is asserting a specific build, so a cached fingerprint must not
  // shadow it. Otherwise the cache would make the override a no-op.
  const hasApkOverride = Boolean(String(source.apk_url ?? '').trim() || String(source.apk_path ?? '').trim());
  let discovery: ApkDiscovery | null = hasApkOverride ? null : cached;
  let keyCandidates = credentialKeyCandidates(source, discovery ?? undefined);
  let eversion: EversionResult | null = null;
  let cachedInUse = false;

  if (discovery) {
    log(`[extract] cached fingerprint ${discovery.package_name} ${discovery.version_name}`);
    eversion = await tryEversion(discovery, keyCandidates);
    if (eversion) {
      // An entry past its trust window is re-verified against the APK even
      // though its seeds answered: the vendor can rotate the signing
      // certificate while the old seeds keep serving `/api/eversion`, and a
      // stale certificate fails every login with no other signal.
      if (staleButUsable) {
        log('[extract] cached fingerprint is past its trust window; re-inspecting the APK');
        const refreshed = await inspectSharedApk();
        if (refreshed) {
          const refreshedEversion = await tryEversion(refreshed, credentialKeyCandidates(source, refreshed));
          if (refreshedEversion) {
            discovery = refreshed;
            eversion = refreshedEversion;
            keyCandidates = credentialKeyCandidates(source, refreshed);
            memo.set(refreshed);
            store?.write(brandKey, refreshed);
          }
        }
        if (discovery === cached) {
          store?.touch(brandKey);
        }
        cachedInUse = true;
      } else {
        store?.touch(brandKey);
        cachedInUse = true;
      }
    } else {
      log('[extract] cached seeds stopped answering; re-inspecting the APK');
      discovery = null;
    }
  }

  if (!discovery) {
    discovery = await inspectSharedApk();
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
    store?.write(brandKey, discovery);
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
  // Event lines are not passed through the text redactor, so nothing derived
  // from the key may reach them — not even a prefix.
  log(`[extract] eversion ok key=<redacted> api_links=${eversion.api_links.length}`);

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
      const message = credentialRejectionMessage(payload);
      diagnostics.login_rejected = true;
      diagnostics.credential_rejected = isCredentialLoginRejection(message);
      errors.push(`login rejected: code=${String(payload.code)}`);
      // A cached fingerprint whose seeds answer eversion but whose signing
      // cert the vendor rotated keeps failing here on every run. Drop the
      // cache so the next run re-inspects the APK instead of repeating this.
      if (cachedInUse) {
        store?.clear(brandKey);
      }
      return { ...empty, failed_iterations: 1 };
    }
    token = String(payload.token ?? '');
    diagnostics.membership_expires_at = membershipDate(payload.endtime ?? payload.expire_time);
    diagnostics.membership_level = Number.isFinite(Number(payload.level)) ? Number(payload.level) : undefined;
  } catch {
    errors.push('login response was not JSON');
    return { ...empty, failed_iterations: 1 };
  }
  if (!token) {
    errors.push('login returned no token');
    return { ...empty, failed_iterations: 1 };
  }
  diagnostics.login_ok = true;
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
      // An omitted `level` means "not reported", not "free tier": reading it as
      // 0 sent isvip=0 and then retired a paid account as having no membership.
      // Only a field the vendor actually sent counts as evidence, so the paid
      // defaults survive an older build or a proxy that strips `info`.
      const levelRaw = detail.level ?? info.level;
      const level = levelRaw === undefined || levelRaw === null || String(levelRaw).trim() === ''
        ? undefined
        : Number(levelRaw);
      const unlimit = String(codeInfo.unlimit ?? '').trim();
      if (level !== undefined && Number.isFinite(level)) {
        ctx.isVip = level >= 2;
        diagnostics.membership_level = level;
      }
      if (unlimit) ctx.isUnlimited = unlimit === '1';
      const expires = membershipDate(detail.endtime ?? detail.expire_time ?? info.endtime ?? info.expire_time);
      if (expires) diagnostics.membership_expires_at = expires;
    }
  } catch {
    // Defaults keep isvip/unlimit enabled, matching a paid account.
  }

  // 4) `/myapi/apinodelist`: the clickable route ids.
  //
  // Every advertised table is fetched and merged. 旋风 publishes two (黄金 and
  // 白金); the others publish one. Area ids repeat across tables, so the merge
  // dedupes by id — the same route asked twice in a round is a wasted request,
  // not a second node.
  const collected: RouteNode[] = [];
  for (const table of eversionFields.apiLines) {
    const groups = parseRouteGroups(
      await getRawCommStr(
        ctx, eversionFields.apiLinks, apiDomain, pathAndQuery(table), '', discovery.seed_domains
      )
    );
    collected.push(...flattenRouteGroups(groups));
  }
  // Free-tier rows issue placeholders and mainland rows are the wrong
  // direction, so neither is worth a request per round.
  const selection = selectForeignRoutes(collected, {
    includeFree: source.include_free_routes === true,
    includeChina: source.include_china_routes === true
  });
  let routes: RouteNode[] = selection.routes;
  if (source.max_areas && source.max_areas > 0) {
    routes = routes.slice(0, source.max_areas);
  }
  diagnostics.route_count = routes.length;
  diagnostics.route_tables = eversionFields.apiLines.length;
  diagnostics.routes_dropped = {
    free: selection.dropped_free,
    china: selection.dropped_china,
    disabled: selection.dropped_disabled,
    duplicate: selection.dropped_duplicate
  };
  if (!routes.length) {
    errors.push(collected.length ? 'node list had no foreign paid routes' : 'node list was empty');
    return { ...empty, failed_iterations: 1 };
  }
  log(
    `[extract] routes=${routes.length} tables=${eversionFields.apiLines.length}` +
    ` dropped(free=${selection.dropped_free} china=${selection.dropped_china}` +
    ` disabled=${selection.dropped_disabled} dup=${selection.dropped_duplicate})`
  );

  // 5) `/api/evmess?area=ID`, repeated.
  //
  // The server picks a landing host per request, so asking the same `area` again
  // usually returns a different machine: the route id chooses the region, not
  // the host. A single pass therefore sees only one host per route, and the
  // rounds below are what turn a handful of routes into a full node pool.
  //
  // Round control mirrors the URL mode's iteration semantics:
  //   max_iterations   upper bound on rounds (default 1)
  //   min_iterations   rounds that always run before early stopping is allowed
  //   plateau_limit    consecutive rounds with no new link that stop the run
  const links: string[] = [];
  const seen = new Set<string>();
  let placeholders = 0;
  let requests = 0;
  const activeRoutes = routes.filter((route) => route.enabled);

  const policy = resolveRoundPolicy(source);
  const maxIterations = policy.max_iterations;
  const minIterations = policy.min_iterations;
  const plateauLimit = policy.plateau_limit;
  const startedAt = Date.now();
  let plateau = 0;
  let rounds = 0;
  let successfulRounds = 0;
  let failedRounds = 0;

  for (let round = 1; round <= maxIterations; round += 1) {
    if (!shouldStartRound(round, policy, (Date.now() - startedAt) / 1000)) {
      break;
    }
    let newInRound = 0;
    let answeredInRound = 0;
    for (const route of activeRoutes) {
      const plain = await getCommStr(
        ctx, eversionFields.apiLinks, apiDomain, '/api/evmess', `&area=${route.area}`, discovery.seed_domains
      );
      requests += 1;
      if (!plain) {
        continue;
      }
      answeredInRound += 1;
      // A malformed body must cost this route, not the run: the URL mode wraps
      // the identical call per iteration for the same reason.
      let decoded: string[] = [];
      try {
        decoded = extractLinksFromPlaintext(`${route.region}-${route.name}`, plain);
      } catch (error) {
        errors.push(`route ${route.area}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const link of decoded) {
        if (isPlaceholderLink(link)) {
          placeholders += 1;
          continue;
        }
        if (!seen.has(link)) {
          seen.add(link);
          links.push(link);
          newInRound += 1;
        }
      }
    }
    rounds = round;
    if (answeredInRound > 0) {
      successfulRounds += 1;
    } else {
      failedRounds += 1;
    }
    if (newInRound > 0) {
      await options.linksCallback?.(links.slice(-newInRound));
    }
    log(`[extract] round ${round}/${maxIterations} +${newInRound} new (total ${links.length})`);

    plateau = newInRound === 0 ? plateau + 1 : 0;
    if (shouldStopOnPlateau(round, plateau, policy)) {
      break;
    }
  }
  diagnostics.placeholder_count = placeholders;
  diagnostics.node_count = links.length;
  diagnostics.rounds = rounds;
  diagnostics.requests = requests;

  event(options, 'extract_source_completed', {
    source_name: input.source_name,
    requested_iterations: maxIterations,
    successful_iterations: successfulRounds,
    failed_iterations: failedRounds,
    raw_links: links.length
  });

  return {
    source_name: input.source_name,
    requested_iterations: maxIterations,
    successful_iterations: successfulRounds,
    failed_iterations: failedRounds,
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
