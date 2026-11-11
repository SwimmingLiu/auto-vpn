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
import { decryptPayload, extractLinksFromPlaintext, linkDigest, linkFingerprint } from './extract.js';
import { mapWithConcurrency, resolveConcurrency } from './concurrency.js';
import {
  EgressSession,
  defaultCurlFetch,
  resolveEgressPolicy,
  type EgressFetch,
  type EgressSwitch
} from './egress.js';
import { AccountStore, maskAccount, type StoredAccount } from '../pool/account-store.js';
import { BRANDS, brandFromSite, brandSite, normalizeBrand, type BrandKey } from '../pool/brands.js';
import { FingerprintStore, resolveFingerprintCacheDir } from './brand-cache.js';
import { resolveUserRuntimeRoot } from '../runtime/paths.js';
import { redactText } from '../runtime/redaction.js';
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
  /**
   * Data plane to talk to, when it is not the row's own brand.
   *
   * Some vendors keep one account system behind several storefronts, and the
   * storefront that sells an account is not always the one whose node API
   * serves it. 黑洞 is the case: its own `/api/evmess` answers the vendor's
   * `1.1.1.1:443` template for `platform=android` on every account, and its iOS
   * channel maps 31 advertised areas onto only 8 landing hosts, so a full run
   * saturates at 8 nodes no matter how many laps it spends. The same pooled
   * 黑洞 account logs in on the 雷霆 backend and receives one machine per area
   * there — 105 unique nodes over three laps in the 2026-11-12 measurement.
   *
   * Setting this keeps the row's own brand for the account pool (accounts are
   * still leased as 黑洞) and takes the APK, official site, request layout and
   * backend protocol from the named brand instead. Omitted means the row's own
   * brand, i.e. no change for every other vendor.
   */
  backend_brand?: string;
  /**
   * Set by the extractor itself when `backend_brand` redirects the data plane.
   *
   * Profile authors write `backend_brand`; this field only carries the resolved
   * value to `resolveBrandLayout`, which otherwise keys off the row name.
   */
  brand_override?: string;
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
  /**
   * Upper bound on rounds PER PLATFORM. Android and iOS each run this many;
   * the budget is never split or summed across the two channels.
   */
  max_iterations?: number;
  /** Rounds that always run before a plateau may stop the run. */
  min_iterations?: number;
  /**
   * Consecutive rounds with no genuinely new node that stop the run. Novelty
   * is the canonical node fingerprint, deduped across both platforms, so a
   * relabelled duplicate does not reset the counter.
   */
  plateau_limit?: number;
  /**
   * How many areas each round takes from the fixed area list. The list is
   * built once (all regions, China and free removed, deduped, vendor order)
   * and never mutated; a cursor walks it and wraps. Default 8.
   */
  areas_per_round?: number;
  /** Concurrent `/api/evmess` requests within one round. Default 4, max 16. */
  area_concurrency?: number;
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
  body?: { cancel?(): Promise<void> | void } | null;
}>;

/**
 * The extract backend's own fetch shape, which does not promise `arrayBuffer`.
 * The APK download needs it; the text calls do not.
 */
export type CredentialTextFetch = (url: string, init?: Record<string, unknown>) => Promise<{
  ok?: boolean;
  status?: number;
  text(): Promise<string>;
  body?: { cancel?(): Promise<void> | void } | null;
}>;

/**
 * How many pooled accounts one source may try before it reports failure.
 *
 * A redirected row leases from a foreign vendor's list, and only a minority of
 * those accounts exist on the backend: measured against the deployed pool, 2 of
 * 40 黑洞 accounts log in on the 雷霆 backend. Each rejected attempt retires that
 * account and leases the next by least-recent use, so the width decides whether
 * the run ever reaches a usable credential. A row without a redirect keeps the
 * tighter default.
 */
export function credentialAccountAttempts(
  source: { account_retry_limit?: number; backend_brand?: string },
  brand: string | null | undefined
): number {
  const backend = normalizeBrand(String(source.backend_brand ?? '').trim());
  const redirected = Boolean(backend && brand && backend !== brand);
  const fallback = redirected ? 24 : 3;
  const parsed = Math.trunc(Number(source.account_retry_limit ?? fallback));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

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
  /**
   * Internal: the wrapper opens one session per source and shares it with both
   * platforms so the proxy dispatcher has a single owner and a single close.
   */
  egressSession?: EgressSession;
  /**
   * Internal: the canonical fingerprint union of this attempt, shared by both
   * platforms. A node the other channel already produced is not a meaningful
   * new node, so it must not reset this channel's early-stop counter.
   */
  sharedFingerprints?: Set<string>;
}

export interface CredentialDiagnostics {
  brand: string;
  /** Data plane actually used, when `backend_brand` redirected it. */
  backend_brand?: string;
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
  /** The vendor said the membership itself lapsed; retire as expired. */
  membership_expired?: boolean;
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
  /** Rounds actually executed on this platform (its own full budget). */
  rounds: number;
  /** Sum of the per-platform rounds; the merged result reports both. */
  rounds_total?: number;
  /** Total `/api/evmess` route requests issued. */
  requests: number;
  /** HTTP attempts actually made, including the domain walk and retries. */
  request_attempts?: number;
  /** Areas taken from the fixed list each round. */
  areas_per_round?: number;
  /** Concurrent requests within a round. */
  area_concurrency?: number;
  /** Transport the crawl ended on, and every switch that got it there. */
  egress_transport?: 'proxy' | 'direct';
  egress_switches?: EgressSwitch[];
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
  // A redirected data plane speaks the backend's parameter order, not the
  // storefront's: the backend decides which flag block it recognises.
  const brand = String(source.brand_override ?? source.brand ?? '').trim();
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
export const BRAND_APK_PREFIXES: Record<string, string> = {
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
  const maxIterations = Math.max(1, Math.trunc(numberOrDefault(source.max_iterations, DEFAULT_MAX_ITERATIONS)));
  const configuredMin = Math.max(0, Math.trunc(numberOrDefault(source.min_iterations, 0)));
  return {
    max_iterations: maxIterations,
    // A minimum above the maximum would otherwise make the cap unreachable.
    min_iterations: Math.min(configuredMin, maxIterations),
    plateau_limit: Math.max(1, Math.trunc(numberOrDefault(source.plateau_limit, DEFAULT_PLATEAU_LIMIT))),
    max_runtime_seconds: Math.max(0, numberOrDefault(source.max_runtime_seconds, 0))
  };
}

/**
 * A round is one cursor step over the fixed area list, not a full sweep.
 * 200 rounds × the default 8 areas covers the whole list many times over, and
 * the plateau stop ends a channel the moment the server has nothing new left.
 */
export const DEFAULT_MAX_ITERATIONS = 200;
export const DEFAULT_PLATEAU_LIMIT = 50;
export const DEFAULT_AREAS_PER_ROUND = 8;
export const DEFAULT_AREA_CONCURRENCY = 4;
/**
 * Consecutive rounds where every candidate host failed before the channel
 * gives up. `getCommStr` already walks the whole domain list, so one empty
 * round is a real outage; five in a row is not a transient blip.
 */
export const MAX_EMPTY_ROUNDS = 5;
/**
 * Consecutive rounds that answered with the placeholder template and nothing
 * else, after which the channel is treated as downgraded and stopped.
 *
 * 黑洞's Android channel answers `1.1.1.1:443` for every area on every account
 * (verified against the decompiled client's exact parameters, with and without
 * `kbox`). Left alone it burns the whole round budget and half the run's
 * concurrency producing nothing, so a channel that has never produced a real
 * node is stopped explicitly and reported.
 */
export const PLACEHOLDER_ONLY_ROUNDS = 8;

/** How many areas one round takes from the immutable list. */
export function resolveAreasPerRound(value: unknown, areaCount: number): number {
  const parsed = Math.trunc(Number(value));
  const requested = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_AREAS_PER_ROUND;
  // Asking for more areas than exist would repeat the same id inside one round.
  return Math.max(1, Math.min(requested, Math.max(1, areaCount)));
}

/**
 * A cursor over a frozen area list.
 *
 * The list and its order are decided once per run; the cursor only moves. That
 * is what keeps later-listed regions reachable when a run is cut short by the
 * round cap, the runtime budget or an early stop — the old loop re-asked the
 * same full list in vendor order every round, so the tail was starved.
 */
export class AreaCursor<T> {
  private readonly items: readonly T[];
  private index = 0;

  constructor(items: readonly T[]) {
    this.items = Object.freeze([...items]);
  }

  get length(): number {
    return this.items.length;
  }

  get position(): number {
    return this.index;
  }

  /** Take the next `count` entries, wrapping. Never mutates the list. */
  take(count: number): T[] {
    if (this.items.length === 0) return [];
    const width = Math.max(1, Math.min(Math.trunc(count) || 1, this.items.length));
    const out: T[] = [];
    for (let step = 0; step < width; step += 1) {
      out.push(this.items[this.index]);
      this.index = (this.index + 1) % this.items.length;
    }
    return out;
  }
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
  /** Run-scoped transport choice; owns the proxy dispatcher and its lifetime. */
  session?: EgressSession;
  curlFetch?: (url: string, proxyUrl: string) => Promise<string>;
}

async function fetchText(
  fetchImpl: CredentialTextFetch,
  url: string,
  timeoutMs: number,
  egress?: Egress
): Promise<FetchTextResult> {
  // The session is the single egress authority: transport choice, block
  // detection, body cancellation and the curl TLS fallback all live there.
  if (egress?.session) {
    const result = await egress.session.text(url, timeoutMs);
    return { text: result.text, url: result.url, ok: result.ok };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Awaited<ReturnType<CredentialTextFetch>> | null = null;
  try {
    response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (response.ok === false) {
      // An unread body pins its keep-alive socket until GC.
      await cancelBody(response);
      return { text: '', url, ok: false };
    }
    return { text: await response.text(), url, ok: true };
  } catch {
    await cancelBody(response);
    if (!egress?.curlFetch) {
      return { text: '', url, ok: false };
    }
    try {
      const text = await egress.curlFetch(url, '');
      return text.trim() ? { text, url, ok: true } : { text: '', url, ok: false };
    } catch {
      return { text: '', url, ok: false };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function cancelBody(response: { body?: { cancel?(): Promise<void> | void } | null } | null): Promise<void> {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Already consumed or already closed.
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

/**
 * Test seam: `defaultLoadApk` with the brand name spelled out.
 *
 * The archive prefix is chosen from this name, and a redirected row must pass
 * its backend's name rather than the row's. Exported so a test can prove which
 * name reaches the loader without standing up a whole extraction.
 */
export async function loadApkWithBrand(
  source: BrandCredentialSource,
  fetchImpl: CredentialFetchLike,
  timeoutMs: number,
  now: Date,
  log: (message: string) => void,
  brandName: string,
  egress?: Egress
): Promise<Buffer | null> {
  return defaultLoadApk(source, fetchImpl, timeoutMs, now, log, brandName, egress);
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
  // The binary download must use the same transport as the text calls, or a
  // configured proxy serves the homepage but the APK bytes go direct.
  const binaryFetch = egress?.session
    ? (egress.session.rawFetch() as unknown as CredentialFetchLike)
    : fetchImpl;
  if (source.apk_url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 120_000));
    try {
      const response = await binaryFetch(source.apk_url, { signal: controller.signal });
      if (!response.ok || typeof response.arrayBuffer !== 'function') {
        await cancelBody(response);
        return null;
      }
      if (declaredSizeTooLarge(response)) {
        await cancelBody(response);
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
      const response = await binaryFetch(candidate, { signal: controller.signal });
      if (!response.ok || typeof response.arrayBuffer !== 'function') {
        await cancelBody(response);
        continue;
      }
      if (declaredSizeTooLarge(response)) {
        await cancelBody(response);
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

/**
 * Local calendar day, matching the account store's `isoDay`.
 *
 * `toISOString().slice(0, 10)` is the UTC day: under Asia/Shanghai a vendor
 * date of `2027-01-01 00:00:00` became `2026-12-31`, and the pool's local-day
 * comparison then retired the account a day early. One formatter for both the
 * "today" comparisons and the dates learned from the vendor.
 */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function membershipDate(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : localDay(date);
  }
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) {
    // A bare number too short to be an epoch is a placeholder, not a date:
    // `new Date('0')` would otherwise read as the year 2000.
    return /^\d{10,13}$/.test(text) ? membershipDate(Number(text)) : '';
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : localDay(parsed);
}

/** Pick the first field that actually parses to a date; `0` is not a date. */
function firstMembershipDate(...values: unknown[]): string {
  for (const value of values) {
    const parsed = membershipDate(value);
    if (parsed) return parsed;
  }
  return '';
}

/**
 * A rejection that means the membership lapsed, not that the password is wrong.
 *
 * Checked before `isCredentialLoginRejection`: filing an expired membership as
 * "invalid" hides the one fact the operator needs, and the row would otherwise
 * stay active forever because neither classifier matched the wording.
 */
export function isMembershipExpiredMessage(message: string): boolean {
  const text = String(message ?? '');
  if (!text.trim()) return false;
  if (TRANSIENT_LOGIN_PATTERN.test(text)) return false;
  return /会员.*?(过期|到期|已到期)|會員.*?(過期|到期)|账号.*?(到期|过期)|帳號.*?(到期|過期)|账户.*?(到期|过期)|vip.*?(expired|expired)|membership.*?(expired|lapsed)|subscription.*?expired|已过期|已過期|expired/i.test(text);
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
  const policy = resolveEgressPolicy(options.env ?? {});
  if (policy.proxyUrl) {
    let proxy: URL;
    try {
      proxy = new URL(policy.proxyUrl);
    } catch {
      throw new Error('The configured upstream proxy URL is invalid');
    }
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
      throw new Error('Credential sources require an HTTP or HTTPS upstream proxy');
    }
  }

  // One session per source: it owns the proxy dispatcher, decides the
  // transport, and switches direct -> proxy when the vendor starts blocking.
  // Both platforms share it, so the choice is made once and closed once.
  const session = options.egressSession ?? await EgressSession.open(options.env, {
    fetchImpl: options.fetchImpl as EgressFetch | undefined,
    curlFetch: options.curlFetch ?? ((url, proxyUrl) => defaultCurlFetch(url, proxyUrl)),
    onSwitch: (switched) => event(options, 'log', {
      message: `[extract][${input.source_name}] egress ${switched.from} -> ${switched.to} (${switched.reason})`
    })
  });
  const ownsSession = !options.egressSession;
  if (session.policy.mode === 'proxy' && session.transport === 'direct' && !session.proxyReachable) {
    event(options, 'log', {
      message: `[extract][${input.source_name}] upstream proxy ${session.policy.proxyUrl} is not reachable; crawling direct`
    });
  }
  try {
    return await fetchCredentialSourceLinksWithTransport(input, {
      ...options,
      egressSession: session,
      curlFetch: options.curlFetch ?? ((url, proxyUrl) => defaultCurlFetch(url, proxyUrl))
    });
  } finally {
    if (ownsSession) await session.close();
  }
}

async function fetchCredentialSourceLinksWithTransport(
  input: ExtractInput,
  options: CredentialExtractOptions
): Promise<CredentialExtractResult> {
  // A copy: a redirected data plane rewrites the site and the layout marker,
  // and the caller's config object must not carry that into later stages.
  const source = { ...(input.source as SourceConfigInput & BrandCredentialSource) };
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
  // The account is always leased as the row's own brand; only the data plane
  // can be redirected. See `backend_brand` for why 黑洞 needs this.
  const backendBrand = normalizeBrand(String(source.backend_brand ?? '').trim()) ?? brand;
  if (backendBrand && brand && backendBrand !== brand) {
    const redirected = brandSite(backendBrand);
    if (redirected) {
      // A pinned `apk_path` / `apk_url` is the operator's explicit choice of
      // build and stays as given: it may already be the backend's own APK, and
      // discarding it turned a working pinned profile into "APK could not be
      // located". Only the site moves.
      if (!source.apk_path && !source.apk_url) {
        source.official_site = redirected;
      }
      // The layout is picked from `brand` at every call site; carrying the row
      // name through would keep sending the storefront's own flag block.
      source.brand_override = backendBrand;
    }
    // Informational, not an error: the row is expected to work this way.
    diagnostics.backend_brand = backendBrand;
    event(options, 'log', {
      message: `[extract][${input.source_name}] data plane ${brand} -> ${backendBrand}`
    });
  }
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

  // Keyed by the data plane, not the storefront: a redirected row downloads and
  // inspects the backend's APK, so it must share that brand's cached entry.
  //
  // A caller-supplied memo cannot be trusted here. The orchestrator builds one
  // per row name before the redirect exists, so `options.memo` for a `heidong`
  // row is seeded from 黑洞's entry while every read and write below goes to the
  // 雷霆 one. That pairing sends the 黑洞 APK's package and seeds to the 雷霆
  // backend on a cached run, and it hides the 雷霆 entry the next run should
  // reuse. A redirect therefore always gets a memo of its own key; the shared
  // one is used only when the two brands agree.
  const memoBrandKey = source.brand_override ?? credentialBrandKey(input.source_name, source);
  const memo = source.brand_override
    ? createFingerprintMemo(options.fingerprintStore ?? null, memoBrandKey)
    : (options.memo ?? createFingerprintMemo(options.fingerprintStore ?? null, memoBrandKey));
  let linkQueue = Promise.resolve();
  // A non-numeric retry limit (a hand-edited `account_retry_limit = "three"`)
  // must not turn the attempt loop into zero passes, which reported the source
  // as successful with no links and no error.
  const attempts = explicitAccount && explicitPassword ? 1 : credentialAccountAttempts(source, brand);
  let results: CredentialExtractResult[] = [];
  let callbackFailure: Error | null = null;
  // The dashboard reads per-source totals from one `extract_iteration` stream.
  // Both platforms emit their own, so they are merged here. Raw links use the
  // exact-string identity each platform already dedupes with: summing the
  // per-platform counts would report the same link twice and leave the card
  // above the final union for the rest of the run. Dedupe keeps the canonical
  // fingerprint union, the same identity the global dedupe card counts.
  const liveLinkIds = new Set<string>();
  const liveFingerprints = new Set<string>();
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      liveLinkIds.clear();
      liveFingerprints.clear();
      // Both channels judge "a genuinely new node" against this one union, so
      // a node iOS already produced cannot reset Android's early-stop counter.
      const sharedFingerprints = new Set<string>();
      results = await Promise.all(platforms.map((platform) => {
        const scoped: CredentialExtractOptions = {
          ...options,
          memo,
          sharedFingerprints,
          eventCallback: (type, payload) => {
            if (type === 'extract_source_started') {
              // The per-platform start used to hardcode 0; the budget is the
              // same full policy on each channel, never a split of it.
              event(options, 'extract_platform_started', {
                ...payload,
                platform,
                requested_iterations: policy.max_iterations,
                min_iterations: policy.min_iterations
              });
              return;
            }
            if (type === 'extract_source_completed') {
              event(options, 'extract_platform_completed', { ...payload, platform });
              return;
            }
            if (type === 'extract_iteration') {
              const fingerprints = Array.isArray(payload.new_item_fingerprints)
                ? payload.new_item_fingerprints.map((value) => String(value)).filter(Boolean)
                : [];
              for (const fingerprint of fingerprints) liveFingerprints.add(fingerprint);
              const linkIds = Array.isArray(payload.new_item_link_ids)
                ? payload.new_item_link_ids.map((value) => String(value)).filter(Boolean)
                : [];
              for (const id of linkIds) liveLinkIds.add(id);
              event(options, 'extract_iteration', {
                source_name: input.source_name,
                // Two channels emit the same round number; without the tag the
                // log shows two identical `#N` lines and reads like one shared
                // counter.
                platform,
                iteration: Number(payload.iteration ?? 0),
                requested_iterations: policy.max_iterations,
                new_items: Number(payload.new_items ?? 0),
                new_meaningful_items: Number(payload.new_meaningful_items ?? 0),
                extracted_links: Number(payload.extracted_links ?? 0),
                total_links: liveLinkIds.size,
                deduped_links: liveFingerprints.size,
                new_item_fingerprints: fingerprints,
                new_item_link_ids: Array.isArray(payload.new_item_link_ids)
                  ? payload.new_item_link_ids.map((value) => String(value)).filter(Boolean)
                  : []
              });
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
          // A login can succeed while the membership it reports has already
          // lapsed. File that as expired, not as "no paid membership": the
          // reason is different and the operator acts on it differently.
          const lapsed = Boolean(expires) && (expires ?? '') < localDay((options.now ?? (() => new Date()))());
          const level = results.map((result) => result.diagnostics.membership_level).find((value) => value !== undefined);
          const linked = results.some((result) => result.links.length > 0);
          if (lapsed) {
            store.markExpired(leased.id, 'membership expired');
          } else if (level !== undefined && level < 2 && !linked && !source.brand_override) {
            // A free-tier account (level 0/1) only ever produces placeholders.
            // Retire it, but only when it actually produced nothing: a paid
            // account misreported as level 1 must not lose its row.
            //
            // A redirected row is exempt: the level it reports is the *row*
            // brand's backend grading it, not the backend it now reads, so a
            // low level there says nothing about whether the account works.
            // Retiring on it would discard exactly the accounts the rotation
            // below is trying to find.
            store.markInvalid(leased.id, 'no paid membership');
          }
        }
        // A login is not proof the account is usable. On a backend that gates
        // routes by membership, a free-tier account logs in fine and then sees
        // every paid row disabled, so the vendor filter leaves nothing to ask.
        // Publishing that as a finished source was the bug; rotate instead.
        // The account itself is valid, so it is not retired — only skipped.
        const producedRoutes = results.some((result) => result.diagnostics.route_count > 0);
        const producedLinks = results.some((result) => result.links.length > 0);
        if (!producedRoutes && !producedLinks && store && leased && attempt < attempts && brand) {
          const next = store.lease(brand);
          if (next) {
            leased = next;
            account = next.account;
            password = next.password;
            continue;
          }
        }
        break;
      }
      const membershipExpired = results.length > 0
        && results.every((result) => result.diagnostics.login_rejected)
        && results.some((result) => result.diagnostics.membership_expired);
      const credentialRejected = results.length > 0 && results.every((result) => result.diagnostics.credential_rejected);
      if (store && leased && (membershipExpired || credentialRejected)) {
        if (membershipExpired) store.markExpired(leased.id, 'membership expired');
        else store.markInvalid(leased.id, 'login rejected');
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
    // The session facts are per-account, not per-platform: both channels log
    // the same pooled credential in. Without this copy the merged result looked
    // like a run that never logged in, and `accounts refresh-expiry` (which
    // reads the merged diagnostics) reported every account as failed.
    diagnostics.login_ok = results.some((result) => result.diagnostics.login_ok);
    diagnostics.login_rejected = results.length > 0 && results.every((result) => result.diagnostics.login_rejected);
    diagnostics.credential_rejected = results.length > 0 && results.every((result) => result.diagnostics.credential_rejected);
    diagnostics.membership_expired = results.some((result) => result.diagnostics.membership_expired);
    diagnostics.membership_expires_at = results
      .map((result) => result.diagnostics.membership_expires_at ?? '')
      .find(Boolean);
    diagnostics.membership_level = results
      .map((result) => result.diagnostics.membership_level)
      .find((value) => value !== undefined);
  }
  diagnostics.route_count = Math.max(0, ...results.map((result) => result.diagnostics.route_count));
  diagnostics.route_tables = Math.max(0, ...results.map((result) => result.diagnostics.route_tables ?? 0));
  diagnostics.node_count = links.length;
  diagnostics.placeholder_count = results.reduce((total, result) => total + result.diagnostics.placeholder_count, 0);
  // Each platform runs the full budget on its own. `rounds` stays the
  // per-platform figure (the cap semantics), `rounds_total` is the work done
  // across channels, and platform_results carries the breakdown.
  diagnostics.rounds = Math.max(0, ...results.map((result) => result.diagnostics.rounds));
  diagnostics.rounds_total = results.reduce((total, result) => total + result.diagnostics.rounds, 0);
  diagnostics.requests = results.reduce((total, result) => total + result.diagnostics.requests, 0);
  diagnostics.areas_per_round = results[0]?.diagnostics.areas_per_round;
  diagnostics.area_concurrency = results[0]?.diagnostics.area_concurrency;
  if (options.egressSession) {
    diagnostics.request_attempts = options.egressSession.attempts;
    diagnostics.egress_transport = options.egressSession.transport;
    diagnostics.egress_switches = [...options.egressSession.switches];
  }
  diagnostics.platform_results = results.map((result) => ({
    platform: result.diagnostics.platform as Platform,
    links: result.links.length,
    rounds: result.diagnostics.rounds,
    requests: result.diagnostics.requests,
    errors: result.diagnostics.errors
  }));
  const successful = results.reduce((total, result) => total + result.successful_iterations, 0);
  const failed = results.length === 0 ? 1 : results.reduce((total, result) => total + result.failed_iterations, 0);
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

/**
 * One client channel. The public wrapper runs both and merges the results.
 *
 * The session is opened here so every early return path still closes it; the
 * inner worker assumes a live session and never owns one.
 */
export async function fetchCredentialPlatformLinks(
  input: ExtractInput,
  options: CredentialExtractOptions = {}
): Promise<CredentialExtractResult> {
  if (options.egressSession) {
    return runCredentialPlatform(input, options);
  }
  const session = await EgressSession.open(options.env, {
    fetchImpl: (options.fetchImpl ?? globalThis.fetch?.bind(globalThis)) as EgressFetch | undefined,
    curlFetch: options.curlFetch ?? ((url, proxyUrl) => defaultCurlFetch(url, proxyUrl))
  });
  try {
    return await runCredentialPlatform(input, { ...options, egressSession: session });
  } finally {
    await session.close();
  }
}

async function runCredentialPlatform(
  input: ExtractInput,
  options: CredentialExtractOptions
): Promise<CredentialExtractResult> {
  const source = input.source as SourceConfigInput & BrandCredentialSource;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const now = (options.now ?? (() => new Date()))();
  const timeoutMs = Number(source.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  const platform: Platform = source.platform === 'ios' ? 'ios' : 'android';
  const device: DeviceIdentity = {
    device_id: source.device_id ?? DEFAULT_DEVICE_ID,
    install_date: source.install_date ?? localDay(now)
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

  const startPolicy = resolveRoundPolicy(source);
  event(options, 'extract_source_started', {
    source_name: input.source_name,
    requested_iterations: startPolicy.max_iterations,
    min_iterations: startPolicy.min_iterations,
    resume_from_iteration: 1,
    platform
  });

  // 1) Brand fingerprint: package, version, certificate and seed domains.
  //
  // These only change when the vendor publishes a new build, so a cached entry
  // is used first and the APK is inspected only when the cached seeds all stop
  // answering. That keeps a normal run to a handful of HTTP calls.
  // Keyed by the data plane, not the storefront: a redirected row downloads and
  // inspects the backend's APK, so it must share that brand's cached entry.
  const brandKey = source.brand_override ?? credentialBrandKey(input.source_name, source);
  const store = options.fingerprintStore ?? null;
  // Same rule as the outer memo: a caller-supplied memo is keyed by the row
  // name, so a redirected row must not read or write through it.
  const memo = source.brand_override
    ? createFingerprintMemo(store, brandKey)
    : (options.memo ?? createFingerprintMemo(store, brandKey));
  // A fingerprint past its trust window is still used when its seeds answer,
  // but it is re-verified against the APK rather than trusted indefinitely: a
  // vendor can rotate the signing certificate while the old seeds still serve
  // `/api/eversion`, and then every login fails on a stale certificate.
  const fresh = store?.readFresh(brandKey) ?? null;
  const storedEntry = store?.read(brandKey) ?? null;
  const staleButUsable = Boolean(storedEntry) && !fresh;
  const cached = staleButUsable ? storedEntry : memo.get();
  const session = options.egressSession as EgressSession;
  const egress: Egress = {
    session,
    curlFetch: options.curlFetch ?? ((url, proxyUrl) => defaultCurlFetch(url, proxyUrl))
  };

  // Report real extraction work instead of making the UI infer APK/domain
  // activity from text logs. Cache reuse remains distinct from executed work.
  const substage = (
    name: 'apk_download' | 'apk_analysis' | 'domain_discovery',
    status: 'running' | 'success' | 'failed' | 'cached'
  ): void => event(options, 'extract_substage', { source_name: input.source_name, platform, substage: name, status });

  const inspectApk = async (): Promise<ApkDiscovery | null> => {
    substage('apk_download', 'running');
    let apkBytes: Buffer | null = null;
    try {
      apkBytes = options.loadApk
        ? await options.loadApk(source)
        : await defaultLoadApk(
          source,
          fetchImpl as CredentialFetchLike,
          timeoutMs,
          now,
          log,
          // The archive prefix names the *backend's* build (`_lt`, not `_hd`):
          // a redirected row downloads from the backend's CDN, which publishes
          // only the backend's own archives. Passing the row name here made
          // every candidate `_hd<N>.apk` against a 雷霆 host, so all lookback
          // slots missed and the run failed with "APK could not be located".
          source.brand_override ?? input.source_name,
          egress
        );
    } catch (error) {
      errors.push(`apk: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!apkBytes) {
      substage('apk_download', 'failed');
      errors.push('APK could not be located');
      return null;
    }
    substage('apk_download', 'success');
    substage('apk_analysis', 'running');
    let discovered: ApkDiscovery;
    try {
      discovered = apkDiscoveryFromBytes(apkBytes, source.apk_url ?? '');
    } catch (error) {
      substage('apk_analysis', 'failed');
      throw error;
    }
    substage('apk_analysis', discovered.seed_domains.length > 0 ? 'success' : 'failed');
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
    substage('apk_download', 'cached');
    substage('apk_analysis', 'cached');
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
    substage('domain_discovery', 'running');
    const resolved = await resolveEversion(
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
      }, resolveBrandLayout({ ...source, brand: source.brand_override ?? input.source_name })),
      keys,
      timeoutMs,
      egress
    );
    substage('domain_discovery', resolved ? 'success' : 'failed');
    return resolved;
  }
  // Event lines are not passed through the text redactor, so nothing derived
  // from the key may reach them — not even a prefix.
  log(`[extract] eversion ok key=<redacted> api_links=${eversion.api_links.length}`);

  const ctx: CommContext = {
    identity,
    device,
    platform,
    layout: resolveBrandLayout({ ...source, brand: source.brand_override ?? input.source_name }),
    token: '',
    // Before login the app's local KV has no `code`, so the request carries an
    // empty one; `&code=` only holds a value once the account has one.
    code: '',
    lastActiveDomain: eversion.domain,
    key: eversion.key,
    fetchImpl,
    timeoutMs,
    // Without this the curl/TLS fallback never reached login, apinodelist or
    // evmess: every control-plane call saw `ctx.egress === undefined`.
    egress
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
      diagnostics.membership_expired = isMembershipExpiredMessage(message);
      diagnostics.credential_rejected = !diagnostics.membership_expired && isCredentialLoginRejection(message);
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
    // `endtime ?? expire_time` does not fall through on 0, so a valid
    // expire_time was silently dropped and the row never got a date.
    diagnostics.membership_expires_at = firstMembershipDate(payload.endtime, payload.expire_time);
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
      const expires = firstMembershipDate(detail.endtime, detail.expire_time, info.endtime, info.expire_time);
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
  // The server picks a landing host per request, so asking the same `area`
  // again usually returns a different machine: the route id chooses the
  // region, not the host.
  //
  // The area list is the one built above: every region the node list
  // advertised, China and free rows removed, duplicates collapsed, vendor
  // order preserved. It is frozen for the whole run. A cursor walks it and
  // takes `areas_per_round` entries each round, wrapping at the end — so a run
  // cut short by the round cap or an early stop still reaches the tail of the
  // list instead of re-asking the same head forever.
  //
  // Round control:
  //   max_iterations   rounds PER PLATFORM. Android and iOS each run the full
  //                    budget concurrently; it is never split or summed.
  //   min_iterations   rounds that always run before early stopping is allowed
  //   plateau_limit    consecutive rounds with no genuinely new node. Novelty
  //                    is the canonical fingerprint, deduped across platforms.
  const links: string[] = [];
  const seen = new Set<string>();
  let placeholders = 0;
  let requests = 0;
  const activeRoutes = routes.filter((route) => route.enabled);
  // The dashboard's dedupe card counts distinct fingerprints, not raw links.
  const fingerprints = new Set<string>();
  // Meaningful novelty is judged against the union both platforms share, so a
  // node the other channel already produced cannot reset this one's plateau.
  const novelty = options.sharedFingerprints ?? new Set<string>();
  // Raw totals use the exact-string identity the pipeline dedupes with, so the
  // live number and `extract_source_completed.raw_links` agree.
  const linkIds = new Set<string>();
  const policy = resolveRoundPolicy(source);
  const maxIterations = policy.max_iterations;
  const areasPerRound = resolveAreasPerRound(source.areas_per_round, activeRoutes.length);
  const areaConcurrency = resolveConcurrency(source.area_concurrency, DEFAULT_AREA_CONCURRENCY);
  const cursor = new AreaCursor(activeRoutes);
  const startedAt = Date.now();
  let plateau = 0;
  let rounds = 0;
  let successfulRounds = 0;
  let failedRounds = 0;
  let emptySweep = 0;
  let placeholderStreak = 0;
  diagnostics.route_count = activeRoutes.length;
  diagnostics.areas_per_round = areasPerRound;
  diagnostics.area_concurrency = areaConcurrency;
  log(
    `[extract] area list frozen: ${activeRoutes.length} areas,` +
    ` ${areasPerRound}/round, concurrency ${areaConcurrency}, egress ${session.transport}`
  );

  for (let round = 1; round <= maxIterations; round += 1) {
    if (!shouldStartRound(round, policy, (Date.now() - startedAt) / 1000)) {
      break;
    }
    const batch = cursor.take(areasPerRound);
    requests += batch.length;
    // Fan the round out. `getCommStr` builds its own candidate list before the
    // first await, so workers share no iteration state; `lastActiveDomain` is
    // only a routing hint and last-writer-wins is safe.
    const answers = await mapWithConcurrency(batch, areaConcurrency, async (route) => ({
      route,
      plain: await getCommStr(
        ctx, eversionFields.apiLinks, apiDomain, '/api/evmess', `&area=${route.area}`, discovery.seed_domains
      )
    }));
    // Delivery and early stop are deliberately separate counters. Every new
    // raw link is still delivered downstream; only a new node identity resets
    // the plateau, so a relabelled duplicate cannot keep the run alive.
    let appendedInRound = 0;
    let meaningfulInRound = 0;
    let answeredInRound = 0;
    let placeholderInRound = 0;
    const newFingerprints: string[] = [];
    const newLinkIds: string[] = [];
    for (const { route, plain } of answers) {
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
          placeholderInRound += 1;
          continue;
        }
        const fingerprint = linkFingerprint(link);
        if (!novelty.has(fingerprint)) {
          novelty.add(fingerprint);
          meaningfulInRound += 1;
          newFingerprints.push(fingerprint);
        }
        fingerprints.add(fingerprint);
        if (!seen.has(link)) {
          seen.add(link);
          links.push(link);
          appendedInRound += 1;
          const digest = linkDigest(link);
          linkIds.add(digest);
          newLinkIds.push(digest);
        }
      }
    }
    rounds = round;
    if (answeredInRound > 0) {
      successfulRounds += 1;
      emptySweep = 0;
      plateau = meaningfulInRound === 0 ? plateau + 1 : 0;
      // A whole round of placeholders and not one real node is a downgraded
      // channel, not an exhausted pool: it would otherwise spend the entire
      // budget (and half the run's concurrency) producing nothing.
      if (placeholderInRound > 0 && appendedInRound === 0 && links.length === 0) {
        placeholderStreak += 1;
      } else {
        placeholderStreak = 0;
      }
    } else {
      failedRounds += 1;
      emptySweep += 1;
      // A round where every candidate failed is a network problem, not "the
      // pool is exhausted", so it must not advance the plateau. Escalate to
      // the proxy (a banned IP often gets an empty body rather than a 403)
      // and stop after a short run of them instead of burning the budget.
      if (session.reportEmptySweep()) {
        log('[extract] no route answered; switching to the upstream proxy');
      }
      if (emptySweep >= MAX_EMPTY_ROUNDS) {
        errors.push(`no route answered for ${emptySweep} consecutive rounds`);
        break;
      }
    }
    if (appendedInRound > 0) {
      await options.linksCallback?.(links.slice(-appendedInRound));
    }
    // The dashboard's raw/dedupe cards read these numbers while the run is in
    // flight. Without a per-round event a credential source stays at 0 until
    // it finishes, which reads as a stalled run.
    event(options, 'extract_iteration', {
      source_name: input.source_name,
      platform,
      iteration: round,
      requested_iterations: maxIterations,
      new_items: appendedInRound,
      new_meaningful_items: meaningfulInRound,
      extracted_links: appendedInRound,
      total_links: links.length,
      deduped_links: fingerprints.size,
      new_item_fingerprints: newFingerprints,
      new_item_link_ids: newLinkIds
    });
    log(
      `[extract] round ${round}/${maxIterations} area=${batch.map((route) => route.area).join(',')}` +
      ` +${appendedInRound} new (+${meaningfulInRound} meaningful, total ${links.length},` +
      ` plateau ${plateau}/${policy.plateau_limit})`
    );

    if (shouldStopOnPlateau(round, plateau, policy)) {
      log(`[extract] early stop: ${plateau} consecutive rounds without a meaningful new node`);
      break;
    }
    if (placeholderStreak >= PLACEHOLDER_ONLY_ROUNDS) {
      errors.push(
        `channel produced only placeholder nodes for ${placeholderStreak} rounds; stopping it` +
        ' (this brand does not serve real nodes on this platform)'
      );
      log(
        `[extract] ${platform} channel stopped: ${placeholderStreak} rounds of placeholder nodes only.` +
        ' The other channel still runs; this platform is not serving real nodes for this brand.'
      );
      break;
    }
  }
  diagnostics.placeholder_count = placeholders;
  diagnostics.node_count = links.length;
  diagnostics.rounds = rounds;
  diagnostics.requests = requests;
  diagnostics.egress_transport = session.transport;
  diagnostics.egress_switches = [...session.switches];

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

export interface ExpiryRefreshEntry {
  brand: string;
  account_masked: string;
  expires_at: string;
  status: 'updated' | 'expired' | 'failed';
  error?: string;
}

export interface ExpiryRefreshOutcome {
  checked: number;
  updated: number;
  expired: number;
  failed: number;
  results: ExpiryRefreshEntry[];
}

/**
 * Learn every pooled account's real membership expiry by logging in.
 *
 * The date is only written by a successful pooled login, and LRU leasing means
 * one account per brand per run — so a freshly imported pool stays blank
 * indefinitely and the UI shows an em dash for almost every row. This walks the
 * active rows deliberately, reusing the normal credential flow (cached
 * fingerprint, one node request) so the login path is the same one a run uses.
 */
export async function refreshAccountExpiry(input: {
  brand?: string;
  limit?: number;
  concurrency?: number;
  env?: NodeJS.ProcessEnv;
  store?: AccountStore;
  now?: () => Date;
  onProgress?: (event: ExpiryRefreshEntry) => void;
} = {}): Promise<ExpiryRefreshOutcome> {
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date());
  const store = input.store ?? new AccountStore({ env, now });
  const ownsStore = !input.store;
  const concurrency = resolveConcurrency(input.concurrency, 3, 8);
  const limit = Math.max(0, Math.trunc(Number(input.limit ?? 0)) || 0);
  const fingerprintStore = new FingerprintStore({
    cacheDir: resolveFingerprintCacheDir(resolveUserRuntimeRoot(env)),
    now
  });
  const outcome: ExpiryRefreshOutcome = { checked: 0, updated: 0, expired: 0, failed: 0, results: [] };
  const todayText = localDay(now());
  const requested = input.brand ? normalizeBrand(input.brand) : null;
  // Every brand the pool knows, from the registry rather than a second list.
  const brands: BrandKey[] = requested ? [requested] : BRANDS.map((brand) => brand.key);
  try {
    for (const brand of brands) {
      let accounts = store.leaseAll(brand);
      if (limit > 0) accounts = accounts.slice(0, limit);
      if (accounts.length === 0) continue;
      // One memo per brand: the APK is inspected at most once for the whole
      // sweep, not once per account. The cache key is the short brand key the
      // normal run writes (`mf`, not `mifeng`); using the long name missed the
      // cache on every sweep and re-downloaded the APK per account.
      const brandKey = credentialBrandKey(brand, { official_site: brandSite(brand) });
      const memo = createFingerprintMemo(fingerprintStore, brandKey);
      await mapWithConcurrency(accounts, concurrency, async (leased) => {
        const entry: ExpiryRefreshEntry = {
          brand,
          account_masked: maskAccount(leased.account),
          expires_at: '',
          status: 'failed'
        };
        outcome.checked += 1;
        try {
          const result = await fetchCredentialSourceLinks({
            source_name: brand,
            source: {
              mode: 'credential',
              official_site: brandSite(brand),
              account: leased.account,
              password: leased.password,
              platforms: ['android'],
              max_iterations: 1,
              areas_per_round: 1,
              plateau_limit: 1
            } as SourceConfigInput
          }, { env, now, memo, fingerprintStore });
          const expires = result.diagnostics.membership_expires_at ?? '';
          entry.expires_at = expires;
          if (result.diagnostics.login_ok && expires) {
            store.setExpiry(brand, leased.account, expires);
            if (expires < todayText) {
              store.markExpired(leased.id, 'membership expired');
              entry.status = 'expired';
              outcome.expired += 1;
            } else {
              entry.status = 'updated';
              outcome.updated += 1;
            }
          } else if (result.diagnostics.membership_expired) {
            store.markExpired(leased.id, 'membership expired');
            entry.status = 'expired';
            outcome.expired += 1;
          } else {
            entry.status = 'failed';
            // The CLI prints this line, so nothing that can carry a credential
            // or a request URL may reach it.
            entry.error = redactText(result.diagnostics.errors.join('; ')) || 'login did not report an expiry';
            outcome.failed += 1;
          }
        } catch (error) {
          entry.status = 'failed';
          entry.error = redactText(error instanceof Error ? error.message : String(error));
          outcome.failed += 1;
        }
        outcome.results.push(entry);
        input.onProgress?.(entry);
      });
    }
  } finally {
    if (ownsStore) store.close();
  }
  return outcome;
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
