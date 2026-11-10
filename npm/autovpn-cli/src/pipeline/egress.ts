/**
 * One egress authority for the crawl stages (credential + url extraction).
 *
 * Before this module the two stages disagreed: each had its own env-only,
 * default-off proxy switch, the credential flow built its CommContext without
 * the egress object so its curl/TLS fallback was dead code, and neither stage
 * noticed that the vendor had started answering with a block page.
 *
 * Policy, in the order the operator asked for it:
 *   - `proxy` (the default) crawls through the upstream proxy. When the proxy
 *     is not listening the run drops to direct rather than failing every
 *     request, and a later block on direct switches back to the proxy.
 *   - `auto` starts direct and pins the proxy for the rest of the run the
 *     first time a response looks like an IP block.
 *   - `direct` never uses a proxy. It is the explicit override.
 *
 * Per-node measurement (speedtest/availability) deliberately does NOT use this
 * module: those transports must reach the node itself, not the crawl proxy.
 */

import net from 'node:net';
import { spawn as nodeSpawn } from 'node:child_process';
import { fetch as upstreamFetch, ProxyAgent } from 'undici';

export type ProxyMode = 'proxy' | 'direct' | 'auto';
export type EgressTransport = 'proxy' | 'direct';

export interface EgressPolicy {
  mode: ProxyMode;
  /** Configured upstream proxy; '' when the operator disabled it. */
  proxyUrl: string;
}

export const DEFAULT_PROXY_URL = 'http://127.0.0.1:7897';

const DISABLED_VALUES = new Set(['', 'off', 'none', 'false', '0', 'no', 'direct']);
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

function normalizeMode(value: unknown): ProxyMode | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'proxy' || text === 'upstream') return 'proxy';
  if (text === 'auto' || text === 'fallback') return 'auto';
  if (text === 'direct' || text === 'off' || text === 'none') return 'direct';
  return null;
}

/**
 * Resolve the crawl egress policy.
 *
 * `VPN_AUTOMATION_PROXY_MODE` is the current knob. The older
 * `VPN_AUTOMATION_USE_UPSTREAM_PROXY` boolean still works: an explicit false
 * means direct, an explicit true means proxy. The standard proxy variables are
 * a URL fallback only, so a shell that exports HTTPS_PROXY for unrelated tools
 * does not silently change the crawl's transport mode.
 */
export function resolveEgressPolicy(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  const explicit = normalizeMode(env.VPN_AUTOMATION_PROXY_MODE);
  const legacyRaw = String(env.VPN_AUTOMATION_USE_UPSTREAM_PROXY ?? '').trim().toLowerCase();
  const legacy = legacyRaw
    ? (ENABLED_VALUES.has(legacyRaw) ? 'proxy' : (DISABLED_VALUES.has(legacyRaw) ? 'direct' : null))
    : null;
  const configured = String(env.VPN_AUTOMATION_UPSTREAM_PROXY ?? '').trim();
  const standard = String(
    env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? ''
  ).trim();
  const candidate = configured || standard;
  // An UNSET candidate falls back to the default proxy; only an explicit
  // disable token ('off', 'none', '0', ...) turns the proxy off. Treating ''
  // as disabled would make the default mode direct.
  const proxyUrl = candidate && DISABLED_VALUES.has(candidate.toLowerCase())
    ? ''
    : (candidate || DEFAULT_PROXY_URL);
  // An explicitly disabled proxy URL cannot serve any mode that needs one.
  const mode = explicit ?? legacy ?? 'proxy';
  if (!proxyUrl) return { mode: 'direct', proxyUrl: '' };
  return { mode, proxyUrl };
}

/** Status codes a vendor or its CDN uses when it stops serving this client. */
const BLOCK_STATUS = new Set([403, 407, 429, 451, 503]);

const BLOCK_BODY_PATTERN =
  /封禁|封鎖|封锁|禁止访问|禁止訪問|访问受限|訪問受限|您的IP|你的IP|IP\s*被|异常访问|異常訪問|请求过于频繁|請求過於頻繁|操作频繁|操作頻繁|too\s*many\s*requests|rate\s*limit|access\s*denied|forbidden|blocked|cf-browser-verification|just\s*a\s*moment|attention\s*required|captcha/i;

export type EgressFailureKind = 'blocked' | 'transient' | 'fatal';

/** Classify a response or transport error for the switch decision. */
export function classifyEgressFailure(input: { status?: number; body?: string; error?: unknown }): EgressFailureKind {
  const status = Number(input.status ?? 0);
  if (BLOCK_STATUS.has(status)) return 'blocked';
  if (input.body && BLOCK_BODY_PATTERN.test(input.body.slice(0, 4096))) return 'blocked';
  if (input.error !== undefined) {
    const text = errorText(input.error);
    if (/econnreset|econnrefused|etimedout|enotfound|ehostunreach|enetunreach|socket\s*hang\s*up|fetch\s*failed|abort|timeout|und_err_/i.test(text)) {
      return 'transient';
    }
    return 'fatal';
  }
  // A 2xx with no usable body is not a block on its own: the vendor answers an
  // empty body for a blank `code` parameter too. The round-level empty sweep
  // is what escalates that into a switch.
  return status >= 400 ? 'transient' : 'fatal';
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return `${error.name}: ${error.message}${cause ? ` ${errorText(cause)}` : ''}`.toLowerCase();
  }
  return String(error ?? '').toLowerCase();
}

/**
 * True when the failure is the proxy itself refusing the connection, not the
 * target host. Only then may the run fall back to direct.
 */
export function isProxyUnreachable(error: unknown): boolean {
  return /econnrefused|enotfound|ehostunreach|enetunreach|proxy\s*(connection|connect|tunnel)|und_err_proxy|err_proxy/i.test(errorText(error));
}

function isTlsFailure(error: unknown): boolean {
  return /ssl|tls|certificate|handshake/i.test(errorText(error));
}

export interface EgressResponse {
  ok?: boolean;
  status?: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  body?: { cancel?(): Promise<void> | void } | null;
}

export type EgressFetch = (url: string, init?: Record<string, unknown>) => Promise<EgressResponse>;

export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] }
) => {
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
  stdin?: { write(data: string): unknown; end(): unknown } | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
};

const defaultSpawn = nodeSpawn as unknown as SpawnLike;

/**
 * curl handles a proxy or an intercepted TLS chain that Node's fetch rejects.
 * The URL travels through stdin so it never lands in a process argument list.
 */
export function defaultCurlFetch(
  url: string,
  proxyUrl: string,
  spawn?: SpawnLike,
  timeoutSeconds = 20
): Promise<string> {
  const run = spawn ?? defaultSpawn;
  const args = [
    '--fail', '--silent', '--show-error', '--location',
    '--max-time', String(Math.max(1, Math.trunc(timeoutSeconds))),
    '--connect-timeout', '10',
    '--insecure', '--http1.1', '--config', '-'
  ];
  if (proxyUrl) args.push('--proxy', proxyUrl);
  else args.push('--noproxy', '*');

  const child = run('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const completion = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || 'curl TLS fallback failed').trim()));
    });
  });
  child.stdin?.write(`url = ${JSON.stringify(url)}\n`);
  child.stdin?.end();
  return completion;
}

/** A TCP connect is enough to know whether a local proxy is listening. */
export function probeProxy(proxyUrl: string, timeoutMs = 1500): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(proxyUrl);
  } catch {
    return Promise.resolve(false);
  }
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = net.connect({ host: target.hostname, port });
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export interface EgressSwitch {
  from: EgressTransport;
  to: EgressTransport;
  reason: string;
}

export interface EgressTextResult {
  text: string;
  url: string;
  ok: boolean;
  status: number;
  transport: EgressTransport;
  /** The response looks like an IP block rather than a missing resource. */
  blocked: boolean;
}

export interface EgressSessionOptions {
  /** Injected for tests; production uses undici with a ProxyAgent. */
  fetchImpl?: EgressFetch;
  curlFetch?: (url: string, proxyUrl: string) => Promise<string>;
  probe?: (proxyUrl: string) => Promise<boolean>;
  onSwitch?: (switched: EgressSwitch) => void;
}

const FAILED_TEXT = (url: string, transport: EgressTransport, status = 0, blocked = false): EgressTextResult =>
  ({ text: '', url, ok: false, status, transport, blocked });

/**
 * A run-scoped transport choice. One session per source: the switch is sticky
 * so a blocked run does not oscillate between transports on every request.
 */
export class EgressSession {
  readonly policy: EgressPolicy;
  readonly switches: EgressSwitch[] = [];
  /** HTTP attempts actually issued, including retries and fallbacks. */
  attempts = 0;
  private current: EgressTransport;
  private dispatcher: ProxyAgent | null = null;
  private readonly fetchImpl?: EgressFetch;
  private readonly curlFetch?: (url: string, proxyUrl: string) => Promise<string>;
  private readonly onSwitch?: (switched: EgressSwitch) => void;
  private proxyEverReachable: boolean;
  /** A request has already been routed through the proxy this run. */
  private proxyAttempted = false;
  private closed = false;

  private constructor(policy: EgressPolicy, current: EgressTransport, proxyReachable: boolean, options: EgressSessionOptions) {
    this.policy = policy;
    this.current = current;
    this.proxyEverReachable = proxyReachable;
    this.fetchImpl = options.fetchImpl;
    this.curlFetch = options.curlFetch;
    this.onSwitch = options.onSwitch;
  }

  static async open(env: NodeJS.ProcessEnv | undefined, options: EgressSessionOptions = {}): Promise<EgressSession> {
    const policy = resolveEgressPolicy(env ?? {});
    if (policy.mode === 'direct' || !policy.proxyUrl) {
      return new EgressSession(policy, 'direct', false, options);
    }
    if (policy.mode === 'auto') {
      // Direct first; the first blocked response pins the proxy.
      return new EgressSession(policy, 'direct', false, options);
    }
    const probe = options.probe ?? ((url: string) => probeProxy(url));
    // An injected fetch is a test seam: probing a real socket would make every
    // unit test depend on whether a local proxy happens to be listening. The
    // injected impl decides the bytes; `probe` can still be injected to drive
    // the unreachable-proxy fallback.
    let reachable = Boolean(options.fetchImpl) && !options.probe;
    if (!reachable) {
      try {
        reachable = await probe(policy.proxyUrl);
      } catch {
        reachable = false;
      }
    }
    // When the proxy is not listening the run starts direct. `proxyReachable`
    // stays false so the first blocked response may still try the proxy once
    // (a local client often starts a moment later), and a failed proxy attempt
    // is not retried after that.
    return new EgressSession(policy, reachable ? 'proxy' : 'direct', reachable, options);
  }

  get transport(): EgressTransport {
    return this.current;
  }

  /**
   * The transport-bound fetch, for the binary (APK) downloads that need
   * `arrayBuffer` rather than text. It carries the same proxy dispatcher as
   * `text()`, so a configured proxy serves the APK bytes too.
   */
  rawFetch(): EgressFetch {
    return this.impl();
  }

  get proxyAvailable(): boolean {
    return Boolean(this.policy.proxyUrl) && this.policy.mode !== 'direct';
  }

  get proxyReachable(): boolean {
    return this.proxyEverReachable;
  }

  private switchTo(next: EgressTransport, reason: string): boolean {
    if (this.current === next) return false;
    // A proxy the probe found unreachable gets exactly one more chance (it may
    // have just started listening). After that a blocked response does not
    // bounce the run back onto a transport that already refused it.
    if (next === 'proxy' && !this.proxyEverReachable && this.proxyAttempted) return false;
    const record: EgressSwitch = { from: this.current, to: next, reason };
    this.current = next;
    this.switches.push(record);
    this.onSwitch?.(record);
    return true;
  }

  /**
   * Escalate a silent failure sweep. The vendor can answer an empty body to a
   * banned IP instead of a 403, so a whole round with no answer is the signal.
   */
  reportEmptySweep(reason = 'empty_responses'): boolean {
    if (this.current !== 'direct' || !this.proxyAvailable) return false;
    return this.switchTo('proxy', reason);
  }

  private impl(): EgressFetch {
    if (this.fetchImpl) return this.fetchImpl;
    if (this.current === 'proxy' && this.policy.proxyUrl) {
      this.dispatcher ??= new ProxyAgent({ uri: this.policy.proxyUrl, proxyTunnel: false });
      const dispatcher = this.dispatcher;
      return (url, init) => upstreamFetch(url, { ...init, dispatcher }) as unknown as Promise<EgressResponse>;
    }
    return (url, init) => upstreamFetch(url, { ...init }) as unknown as Promise<EgressResponse>;
  }

  private async attempt(url: string, timeoutMs: number, transport: EgressTransport): Promise<EgressTextResult & { retryWith?: EgressTransport; reason?: string }> {
    if (transport === 'proxy') this.proxyAttempted = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const fetchImpl = this.impl();
    this.attempts += 1;
    let response: EgressResponse | null = null;
    try {
      response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
      const status = Number(response.status ?? (response.ok === false ? 500 : 200));
      const ok = response.ok !== false && status < 400;
      if (!ok) {
        // An abandoned body pins its keep-alive socket until GC; at thousands
        // of route requests per run that exhausts the pool.
        const body = await this.drain(response, 2048);
        await this.cancel(response);
        const blocked = classifyEgressFailure({ status, body }) === 'blocked';
        if (blocked && transport === 'direct' && this.proxyAvailable) {
          return { ...FAILED_TEXT(url, transport, status, true), retryWith: 'proxy', reason: `blocked_direct_${status}` };
        }
        return FAILED_TEXT(url, transport, status, blocked);
      }
      const text = await response.text();
      const blocked = classifyEgressFailure({ status, body: text }) === 'blocked';
      if (blocked && transport === 'direct' && this.proxyAvailable) {
        return { ...FAILED_TEXT(url, transport, status, true), retryWith: 'proxy', reason: 'blocked_direct_body' };
      }
      return { text: blocked ? '' : text, url, ok: !blocked, status, transport, blocked };
    } catch (error) {
      await this.cancel(response);
      if (transport === 'proxy' && isProxyUnreachable(error)) {
        this.proxyEverReachable = false;
        return { ...FAILED_TEXT(url, transport), retryWith: 'direct', reason: 'proxy_unreachable' };
      }
      // Same fallback the url mode has always applied: curl handles a proxy or
      // a self-signed/intercepted TLS chain that Node's fetch rejects.
      if (this.curlFetch && (isTlsFailure(error) || classifyEgressFailure({ error }) === 'transient')) {
        this.attempts += 1;
        try {
          const text = await this.curlFetch(url, transport === 'proxy' ? this.policy.proxyUrl : '');
          if (text.trim()) {
            return { text, url, ok: true, status: 200, transport, blocked: false };
          }
        } catch {
          // Fall through to the failure result below.
        }
      }
      return FAILED_TEXT(url, transport);
    } finally {
      clearTimeout(timer);
    }
  }

  private async drain(response: EgressResponse | null, limit: number): Promise<string> {
    if (!response) return '';
    try {
      const text = await response.text();
      return text.slice(0, limit);
    } catch {
      return '';
    }
  }

  private async cancel(response: EgressResponse | null): Promise<void> {
    try {
      await response?.body?.cancel?.();
    } catch {
      // Already consumed or already closed.
    }
  }

  /** Fetch a URL as text under the current transport, switching once if needed. */
  async text(url: string, timeoutMs: number): Promise<EgressTextResult> {
    if (this.closed) throw new Error('egress session is closed');
    const first = await this.attempt(url, timeoutMs, this.current);
    if (!first.retryWith) return first;
    this.switchTo(first.retryWith, first.reason ?? 'retry');
    const second = await this.attempt(url, timeoutMs, this.current);
    const { retryWith: _ignored, reason: _reason, ...rest } = second;
    return rest;
  }

  async close(): Promise<void> {
    this.closed = true;
    const dispatcher = this.dispatcher;
    this.dispatcher = null;
    if (dispatcher) {
      try {
        await dispatcher.destroy();
      } catch {
        // Destroy is best-effort; a dead proxy must not fail the run.
      }
    }
  }
}
