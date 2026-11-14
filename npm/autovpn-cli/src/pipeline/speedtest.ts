import net from 'node:net';
import tls from 'node:tls';
import {
  openMihomoRuntime as defaultOpenMihomoRuntime,
  probeMihomoProxyDelay as defaultProbeMihomoProxyDelay,
  MihomoRuntime,
  OpenMihomoRuntimeOptions
} from './proxy-runtime.js';
import { mapWithCompletion } from './concurrency.js';
import {
  HTTP_HEAD_LIMIT_BYTES,
  connectProxySocket,
  httpStatusLine,
  parseProxyEndpoint,
  safeParseHttpStatus,
  splitHttpResponseHead
} from './http-transport.js';
import { retryTransientNetwork } from './network-retry.js';

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok?: boolean;
  status?: number;
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

const PROBE_MAX_ATTEMPTS = 2;

export interface SpeedTestConfigInput {
  min_download_mb_s: number;
  timeout_seconds: number;
  concurrency: number;
  urls?: string[];
  probe_url?: string;
  max_download_bytes?: number;
  startup_wait_seconds?: number;
  max_download_candidates?: number;
  /**
   * Cap on how many links reach the probe stage.
   *
   * `max_download_candidates` bounds only the full download test, which runs
   * after every candidate has already been probed: a run that extracts 10,790
   * links pays 10,790 probes either way. At 8 concurrent and up to 60 s each,
   * that is hours of wall-clock for a night whose useful output is 40-60 links,
   * and the run is killed by the platform long before it publishes.
   *
   * The cap is applied before probing, and the links are taken in artifact
   * order — extraction already writes them in the order it found them, so the
   * cut keeps the earliest finds rather than an arbitrary subset. 0 keeps the
   * old behaviour of probing everything, which is right on a small sweep.
   */
  max_probe_candidates?: number;
}

export interface ProbeResult {
  link: string;
  reachable: boolean;
  latency_ms: number;
  error?: string;
}

export interface SpeedTestResult {
  link: string;
  reachable: boolean;
  average_download_mb_s: number;
  latency_ms: number;
  error?: string;
}

export interface SpeedTestInput {
  links: string[];
  config: SpeedTestConfigInput;
  runtime_path?: string;
}

export interface SpeedTestBackendOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: () => number;
  openMihomoRuntime?: (link: string, options: OpenMihomoRuntimeOptions) => Promise<Pick<MihomoRuntime, 'controllerUrl' | 'proxyName' | 'proxies' | 'close'>>;
  probeMihomoProxyDelay?: (controllerUrl: string, proxyName: string, probeUrl: string, timeoutSeconds: number) => Promise<number>;
  downloadUrlViaHttpProxy?: (url: string, proxyUrl: string, maxBytes: number, timeoutSeconds: number) => Promise<number>;
  probeLinks?: (links: string[], config: Required<SpeedTestConfigInput>, options: { runtime_path: string }) => ProbeResult[] | Promise<ProbeResult[]>;
  testLink?: (link: string, config: Required<SpeedTestConfigInput>, options: { runtime_path: string }) => SpeedTestResult | Promise<SpeedTestResult>;
  progressCallback?: (message: string) => void;
  eventCallback?: (eventType: string, payload: Record<string, unknown>) => void;
}

export function aggregateSpeedMeasurements(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(3));
}

export function normalizeSpeedTestConfig(config: SpeedTestConfigInput): Required<SpeedTestConfigInput> {
  return {
    min_download_mb_s: Number(config.min_download_mb_s),
    timeout_seconds: Number(config.timeout_seconds),
    concurrency: Number(config.concurrency),
    urls: config.urls ?? [],
    probe_url: config.probe_url ?? 'https://www.gstatic.com/generate_204',
    max_download_bytes: Number(config.max_download_bytes ?? 5_000_000),
    startup_wait_seconds: Number(config.startup_wait_seconds ?? 1.0),
    max_download_candidates: Number(config.max_download_candidates ?? 50),
    // 0 = probe everything, the behaviour before this option existed.
    max_probe_candidates: Number(config.max_probe_candidates ?? 0)
  };
}

/**
 * Take `limit` links spread evenly across the artifact rather than the first
 * `limit` of it.
 *
 * The artifact is written source by source, so a prefix is not a sample: one
 * night produced 9 heidong, 230 mifeng, 164 leiting and 10,387 xuanfeng links,
 * and the first 600 were three whole sources plus **1.9% of the fourth**. The
 * vendor whose links were cut is the one the operator may most want, and the
 * cut is invisible in the yield — it looks like that vendor performed badly.
 *
 * An even stride over the whole list keeps every source in proportion. Ties go
 * to the earlier index, so the result is a deterministic function of the input
 * and the same artifact always probes the same links.
 */
export function sampleAcrossArtifact(links: string[], limit: number): string[] {
  if (limit <= 0 || links.length <= limit) {
    return links;
  }
  const picked: string[] = [];
  // Position of the i-th pick in a list of `total` taking `limit` evenly.
  for (let index = 0; index < limit; index += 1) {
    const position = Math.floor((index * links.length) / limit);
    picked.push(links[position]);
  }
  return picked;
}

export function selectSpeedtestCandidates(probes: ProbeResult[], limit: number): string[] {
  const reachable = probes
    .filter((probe) => probe.reachable)
    .sort((left, right) => {
      const leftInvalidLatency = left.latency_ms <= 0 ? 1 : 0;
      const rightInvalidLatency = right.latency_ms <= 0 ? 1 : 0;
      if (leftInvalidLatency !== rightInvalidLatency) {
        return leftInvalidLatency - rightInvalidLatency;
      }
      if (left.latency_ms !== right.latency_ms) {
        return left.latency_ms - right.latency_ms;
      }
      if (left.link < right.link) {
        return -1;
      }
      if (left.link > right.link) {
        return 1;
      }
      return 0;
    });
  const links = reachable.map((probe) => probe.link);
  if (limit <= 0) {
    return links;
  }
  return links.slice(0, limit);
}

function emitEvent(callback: SpeedTestBackendOptions['eventCallback'], eventType: string, payload: Record<string, unknown>): void {
  if (callback) {
    callback(eventType, payload);
  }
}

function defaultNow(): number {
  return performance.now();
}

/** Shared-concurrency loop plus the progress hook speedtest emits per finished link. */

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<Awaited<ReturnType<FetchLike>>> {
  const controller = new AbortController();
  let internallyTimedOut = false;
  const timer = setTimeout(() => {
    internallyTimedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (internallyTimedOut) {
      // The headers arrived after we gave up: release the body/socket too.
      const cancellation = response.body?.cancel?.();
      void Promise.resolve(cancellation).catch(() => {});
      const error = new Error(`request timed out after ${timeoutMs}ms`) as Error & { code?: string };
      error.code = 'AUTOVPN_INTERNAL_TIMEOUT';
      throw error;
    }
    return response;
  } catch (error) {
    if (internallyTimedOut && !(error instanceof Error && (error as Error & { code?: string }).code === 'AUTOVPN_INTERNAL_TIMEOUT')) {
      const timeoutError = new Error(`request timed out after ${timeoutMs}ms`, { cause: error }) as Error & { code?: string };
      timeoutError.code = 'AUTOVPN_INTERNAL_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withBodyTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`response body timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function readResponseBytes(response: Awaited<ReturnType<FetchLike>>, maxBytes: number, timeoutMs: number): Promise<number> {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    let timedOut = false;
    let reachedCap = false;
    let failed = false;
    try {
      return await withBodyTimeout(async () => {
        let total = 0;
        while (total < maxBytes) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          total += Math.min(value.byteLength, maxBytes - total);
          if (total >= maxBytes) {
            reachedCap = true;
          }
        }
        return total;
      }, timeoutMs);
    } catch (error) {
      failed = true;
      timedOut = error instanceof Error && error.message.includes('response body timed out');
      throw error;
    } finally {
      // Any exit that did not drain the body naturally must release the
      // keep-alive connection instead of leaving the reader locked.
      if (failed || timedOut || reachedCap) {
        await reader.cancel().catch(() => {});
      }
      reader.releaseLock();
    }
  }
  throw new Error('streaming response body required for bounded speed test downloads');
}

function requireOkResponse(response: Awaited<ReturnType<FetchLike>>, allowedStatuses: Set<number>): void {
  const status = Number(response.status ?? 200);
  if (response.ok === false || !allowedStatuses.has(status)) {
    // Release the keep-alive socket for a body we are about to abandon.
    const cancellation = response.body?.cancel?.();
    void Promise.resolve(cancellation).catch(() => {});
    throw new Error(`unexpected status ${status}`);
  }
}

async function retryTransientProbe<T>(operation: () => Promise<T>): Promise<T> {
  return retryTransientNetwork(operation, { maxAttempts: PROBE_MAX_ATTEMPTS, delayMs: 0 });
}

function waitForHandshake(socket: tls.TLSSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('secureConnect', onSecureConnect);
      socket.off('error', onError);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      const error = new Error(`TLS handshake timed out after ${timeoutMs}ms`) as Error & { code?: string };
      error.code = 'AUTOVPN_INTERNAL_TIMEOUT';
      fail(error);
    }, timeoutMs);
    function onSecureConnect(): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }
    function onError(error: Error): void {
      fail(error);
    }
    socket.once('secureConnect', onSecureConnect);
    socket.once('error', onError);
  });
}

function readHttpBodyBytes(socket: net.Socket | tls.TLSSocket, maxBytes: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let headersParsed = false;
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    // Single terminal point: stop listening, close the handle, then settle once.
    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      action();
    };
    const fail = (error: Error): void => settle(() => reject(error));
    const timer = setTimeout(() => fail(new Error(`proxy download timed out after ${timeoutMs}ms`)), timeoutMs);
    function onError(error: Error): void {
      fail(error);
    }
    function onEnd(): void {
      if (!headersParsed) {
        // A captive portal / block page that closes before a parseable head:
        // fail this link instead of reporting a zero-byte download.
        fail(buffered.byteLength > 0
          ? new Error(`invalid HTTP response: ${httpStatusLine(buffered)}`)
          : new Error('proxy response ended before HTTP headers were received'));
        return;
      }
      settle(() => resolve(total));
    }
    const countBody = (chunk: Buffer): void => {
      total += Math.min(chunk.byteLength, Math.max(maxBytes - total, 0));
      if (total >= maxBytes) {
        settle(() => resolve(maxBytes));
      }
    };
    function onData(chunk: Buffer): void {
      if (settled) {
        return;
      }
      try {
        if (!headersParsed) {
          buffered = Buffer.concat([buffered, chunk]);
          const split = splitHttpResponseHead(buffered);
          if (!split) {
            if (buffered.byteLength > HTTP_HEAD_LIMIT_BYTES) {
              fail(new Error(`invalid HTTP response: ${httpStatusLine(buffered)}`));
            }
            return;
          }
          const status = safeParseHttpStatus(split.head);
          if (status === null) {
            fail(new Error(`invalid HTTP response: ${httpStatusLine(split.head)}`));
            return;
          }
          if (status < 200 || status >= 300) {
            fail(new Error(`unexpected status ${status}`));
            return;
          }
          headersParsed = true;
          buffered = Buffer.alloc(0);
          if (split.body.byteLength > 0) {
            countBody(split.body);
          }
          return;
        }
        countBody(chunk);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

function readConnectResponse(socket: net.Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`proxy CONNECT timed out after ${timeoutMs}ms`)), timeoutMs);
    function onError(error: Error): void {
      fail(error);
    }
    function onEnd(): void {
      fail(new Error('proxy CONNECT response ended before HTTP headers were received'));
    }
    function onData(chunk: Buffer): void {
      if (settled) {
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const split = splitHttpResponseHead(buffered);
      if (!split) {
        if (buffered.byteLength > HTTP_HEAD_LIMIT_BYTES) {
          fail(new Error(`invalid HTTP response: ${httpStatusLine(buffered)}`));
        }
        return;
      }
      const status = safeParseHttpStatus(split.head);
      if (status === null) {
        fail(new Error(`invalid HTTP response: ${httpStatusLine(split.head)}`));
        return;
      }
      if (status < 200 || status >= 300) {
        fail(new Error(`proxy CONNECT failed with status ${status}`));
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

export async function downloadUrlViaHttpProxy(
  url: string,
  proxyUrl: string,
  maxBytes: number,
  timeoutSeconds: number
): Promise<number> {
  const target = new URL(url);
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`unsupported speedtest URL protocol: ${target.protocol}`);
  }
  const endpoint = parseProxyEndpoint(proxyUrl);
  const socket = await connectProxySocket(endpoint, timeoutMs);
  const requestPath = `${target.pathname || '/'}${target.search}`;
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const proxyAuthorization = endpoint.authorization ? [`Proxy-Authorization: ${endpoint.authorization}`] : [];
  let secureSocket: tls.TLSSocket | undefined;

  try {
    if (target.protocol === 'http:') {
      socket.write([
        `GET ${target.toString()} HTTP/1.1`,
        `Host: ${target.host}`,
        ...proxyAuthorization,
        'Connection: close',
        '',
        ''
      ].join('\r\n'));
      return await readHttpBodyBytes(socket, Math.max(1, maxBytes), timeoutMs);
    }

    socket.write([
      `CONNECT ${target.hostname}:${targetPort} HTTP/1.1`,
      `Host: ${target.hostname}:${targetPort}`,
      ...proxyAuthorization,
      'Connection: keep-alive',
      '',
      ''
    ].join('\r\n'));
    await readConnectResponse(socket, timeoutMs);
    secureSocket = tls.connect({
      socket,
      servername: target.hostname,
      rejectUnauthorized: false
    });
    // Destroying a TLSSocket after the request-scoped listeners are removed
    // must not surface as an uncaught 'error'.
    secureSocket.on('error', () => {});
    await waitForHandshake(secureSocket, timeoutMs);
    secureSocket.write([
      `GET ${requestPath} HTTP/1.1`,
      `Host: ${target.host}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    return await readHttpBodyBytes(secureSocket, Math.max(1, maxBytes), timeoutMs);
  } finally {
    // Every terminal branch (success, non-2xx, parse failure, timeout, handshake
    // failure) releases both handles. destroy() is idempotent.
    secureSocket?.destroy();
    socket.destroy();
  }
}

async function probeLinksDirect(
  links: string[],
  config: Required<SpeedTestConfigInput>,
  options: SpeedTestBackendOptions,
  onComplete?: (result: ProbeResult, completed: number) => void
): Promise<ProbeResult[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error('Node speedtest backend requires fetch support');
  }
  const now = options.now ?? defaultNow;
  const timeoutMs = Math.max(1, Number(config.timeout_seconds)) * 1000;
  return mapWithCompletion(links, config.concurrency, async (link) => {
    try {
      return await retryTransientProbe(async () => {
        const started = now();
        const response = await fetchWithTimeout(fetchImpl, config.probe_url, timeoutMs);
        const elapsed = Math.max(now() - started, 1);
        requireOkResponse(response, new Set([200, 204]));
        // A reachability probe never reads the body; cancel it so the
        // keep-alive connection goes back to the pool instead of leaking.
        const cancellation = response.body?.cancel?.();
        void Promise.resolve(cancellation).catch(() => {});
        return { link, reachable: true, latency_ms: Math.max(Math.round(elapsed), 1), error: '' };
      });
    } catch (error) {
      return { link, reachable: false, latency_ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }, (result, _index, completed) => onComplete?.(result, completed));
}

async function probeLinksMihomo(
  links: string[],
  config: Required<SpeedTestConfigInput>,
  runtimePath: string,
  options: SpeedTestBackendOptions,
  onComplete?: (result: ProbeResult, completed: number) => void
): Promise<ProbeResult[]> {
  const openRuntime = options.openMihomoRuntime ?? defaultOpenMihomoRuntime;
  const probeDelay = options.probeMihomoProxyDelay ?? defaultProbeMihomoProxyDelay;
  return mapWithCompletion(links, config.concurrency, async (link) => {
    try {
      return await retryTransientProbe(async () => {
        let runtime: Pick<MihomoRuntime, 'controllerUrl' | 'proxyName' | 'close'> | undefined;
        try {
          runtime = await openRuntime(link, {
            runtimePath,
            startupWaitSeconds: config.startup_wait_seconds,
            env: options.env
          });
          const latencyMs = await probeDelay(runtime.controllerUrl, runtime.proxyName, config.probe_url, config.timeout_seconds);
          return { link, reachable: true, latency_ms: latencyMs, error: '' };
        } finally {
          await runtime?.close();
        }
      });
    } catch (error) {
      return { link, reachable: false, latency_ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }, (result, _index, completed) => onComplete?.(result, completed));
}

async function testLinkDirect(
  link: string,
  config: Required<SpeedTestConfigInput>,
  options: SpeedTestBackendOptions
): Promise<SpeedTestResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error('Node speedtest backend requires fetch support');
  }
  const now = options.now ?? defaultNow;
  const timeoutMs = Math.max(1, Number(config.timeout_seconds)) * 1000;
  const speedValues: number[] = [];
  const failures: string[] = [];
  for (const url of config.urls) {
    const started = now();
    try {
      const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
      requireOkResponse(response, new Set([200]));
      const total = await readResponseBytes(response, Math.max(1, Number(config.max_download_bytes)), timeoutMs);
      const elapsedSeconds = Math.max((now() - started) / 1000, 0.001);
      speedValues.push(total / elapsedSeconds / 1024 / 1024);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (speedValues.length === 0) {
    return {
      link,
      reachable: false,
      average_download_mb_s: 0,
      latency_ms: 0,
      error: failures.join('; ') || 'all speed test urls failed'
    };
  }
  return {
    link,
    reachable: true,
    average_download_mb_s: aggregateSpeedMeasurements(speedValues),
    latency_ms: 0,
    error: failures.join('; ')
  };
}

async function testLinkMihomo(
  link: string,
  config: Required<SpeedTestConfigInput>,
  runtimePath: string,
  options: SpeedTestBackendOptions
): Promise<SpeedTestResult> {
  const openRuntime = options.openMihomoRuntime ?? defaultOpenMihomoRuntime;
  const downloadViaProxy = options.downloadUrlViaHttpProxy ?? downloadUrlViaHttpProxy;
  try {
    return await retryTransientNetwork(async () => {
      let runtime: Pick<MihomoRuntime, 'proxies' | 'close'> | undefined;
      try {
        runtime = await openRuntime(link, {
          runtimePath,
          startupWaitSeconds: config.startup_wait_seconds,
          env: options.env
        });
        const now = options.now ?? defaultNow;
        const speedValues: number[] = [];
        const failures: string[] = [];
        let lastFailure: unknown;
        for (const url of config.urls) {
          try {
            const measurement = await retryTransientNetwork(async () => {
              const started = now();
              const total = await downloadViaProxy(url, runtime!.proxies.http, Math.max(1, Number(config.max_download_bytes)), config.timeout_seconds);
              return { total, elapsedSeconds: Math.max((now() - started) / 1000, 0.001) };
            });
            speedValues.push(measurement.total / measurement.elapsedSeconds / 1024 / 1024);
          } catch (error) {
            lastFailure = error;
            failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (speedValues.length === 0) {
          if (lastFailure) throw lastFailure;
          return { link, reachable: false, average_download_mb_s: 0, latency_ms: 0, error: failures.join('; ') || 'all speed test urls failed' };
        }
        return { link, reachable: true, average_download_mb_s: aggregateSpeedMeasurements(speedValues), latency_ms: 0, error: failures.join('; ') };
      } finally {
        await runtime?.close();
      }
    });
  } catch (error) {
    return {
      link,
      reachable: false,
      average_download_mb_s: 0,
      latency_ms: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function speedtestInNode(input: SpeedTestInput, options: SpeedTestBackendOptions): Promise<SpeedTestResult[]> {
  if (input.links.length === 0) {
    return [];
  }

  const config = normalizeSpeedTestConfig(input.config);
  const runtimePath = input.runtime_path ?? '';
  const requestedRuntime = String((options.env ?? process.env).AUTOVPN_SPEEDTEST_RUNTIME ?? '').trim().toLowerCase();
  const useMihomoRuntime = requestedRuntime !== 'direct';
  const probeLinks = options.probeLinks ?? ((links: string[]) => (
    useMihomoRuntime
      ? probeLinksMihomo(links, config, runtimePath, options)
      : probeLinksDirect(links, config, options)
  ));
  const testLink = options.testLink ?? ((link: string) => (
    useMihomoRuntime
      ? testLinkMihomo(link, config, runtimePath, options)
      : testLinkDirect(link, config, options)
  ));
  const runtimeCore = useMihomoRuntime || options.probeLinks || options.testLink ? 'mihomo' : 'direct';
  options.progressCallback?.(`[speedtest] runtime_core=${runtimeCore} probe_url=${config.probe_url}`);
  emitEvent(options.eventCallback, 'speedtest_runtime', {
    runtime_core: runtimeCore,
    probe_url: config.probe_url,
    urls: [...config.urls]
  });

  // Probe the whole set unless the profile bounds it. The cap goes here rather
  // than at `max_download_candidates` because probing happens first: a sweep
  // that extracts 10,790 links pays for 10,790 probes before a single download
  // is measured, and the job is killed long before it publishes.
  const probeInput = config.max_probe_candidates > 0
    ? sampleAcrossArtifact(input.links, config.max_probe_candidates)
    : input.links;
  if (probeInput.length < input.links.length) {
    options.progressCallback?.(
      `[speedtest] probing ${probeInput.length}/${input.links.length} links (max_probe_candidates)`
    );
  }

  const probes = await probeLinks(probeInput, config, { runtime_path: runtimePath });
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index];
    emitEvent(options.eventCallback, 'speedtest_probe_result', {
      completed: index + 1,
      total: probeInput.length,
      link: probe.link,
      reachable: probe.reachable,
      latency_ms: probe.latency_ms,
      error: probe.error ?? ''
    });
  }
  const candidateLinks = selectSpeedtestCandidates(probes, config.max_download_candidates);
  const probeByLink = new Map(probes.map((probe) => [probe.link, probe]));
  const candidateSet = new Set(candidateLinks);
  const reachableCount = probes.filter((probe) => probe.reachable).length;
  options.progressCallback?.(`[speedtest] selected ${candidateLinks.length}/${reachableCount} reachable links for full download test`);
  emitEvent(options.eventCallback, 'speedtest_selected', {
    total_links: input.links.length,
    reachable_count: reachableCount,
    candidate_count: candidateLinks.length
  });

  const results: SpeedTestResult[] = probes
    .filter((probe) => !probe.reachable)
    .map((probe) => ({
      link: probe.link,
      reachable: false,
      average_download_mb_s: 0,
      latency_ms: probe.latency_ms,
      error: probe.error ?? ''
    }));

  const testedResults = await mapWithCompletion(candidateLinks, config.concurrency, async (link) => (
    testLink(link, config, { runtime_path: runtimePath })
  ), (result, _index, completed) => {
    if (result.reachable && result.latency_ms <= 0) {
      result.latency_ms = probeByLink.get(result.link)?.latency_ms ?? 0;
    }
    options.progressCallback?.(`[speedtest] ${completed}/${candidateSet.size} reachable=${result.reachable} speed=${result.average_download_mb_s}MB/s`);
    emitEvent(options.eventCallback, 'speedtest_result', {
      completed,
      total: candidateSet.size,
      link: result.link,
      reachable: result.reachable,
      average_download_mb_s: result.average_download_mb_s,
      latency_ms: result.latency_ms,
      passed_threshold: result.reachable && result.average_download_mb_s >= config.min_download_mb_s,
      error: result.error ?? ''
    });
  });
  results.push(...testedResults);
  return results;
}

export async function speedtestLinksWithBackend(input: SpeedTestInput, options: SpeedTestBackendOptions = {}): Promise<SpeedTestResult[]> {
  return speedtestInNode(input, options);
}

export async function probeSpeedtestLinksInNode(input: SpeedTestInput, options: SpeedTestBackendOptions = {}): Promise<ProbeResult[]> {
  const config = normalizeSpeedTestConfig(input.config);
  const runtimePath = input.runtime_path ?? '';
  const requestedRuntime = String((options.env ?? process.env).AUTOVPN_SPEEDTEST_RUNTIME ?? '').trim().toLowerCase();
  const useMihomoRuntime = requestedRuntime !== 'direct';
  // Same cap as the full speed test: a caller that bounds probing must not pay
  // for a sweep the run would have cut anyway.
  const links = config.max_probe_candidates > 0
    ? sampleAcrossArtifact(input.links, config.max_probe_candidates)
    : input.links;
  const emitProbe = (result: ProbeResult, completed: number): void => {
    options.progressCallback?.(`[speedtest:probe] ${completed}/${links.length} reachable=${result.reachable} latency=${result.latency_ms}ms`);
    emitEvent(options.eventCallback, 'speedtest_probe_result', {
      completed,
      total: links.length,
      link: result.link,
      reachable: result.reachable,
      latency_ms: result.latency_ms,
      error: result.error ?? ''
    });
  };
  if (options.probeLinks) {
    const results = await options.probeLinks(links, config, { runtime_path: runtimePath });
    results.forEach((result, index) => emitProbe(result, index + 1));
    return results;
  }
  return useMihomoRuntime
    ? probeLinksMihomo(links, config, runtimePath, options, emitProbe)
    : probeLinksDirect(links, config, options, emitProbe);
}

export async function testSpeedtestLinkInNode(input: { link: string; config: SpeedTestConfigInput; runtime_path?: string }, options: SpeedTestBackendOptions = {}): Promise<SpeedTestResult> {
  const config = normalizeSpeedTestConfig(input.config);
  const runtimePath = input.runtime_path ?? '';
  const requestedRuntime = String((options.env ?? process.env).AUTOVPN_SPEEDTEST_RUNTIME ?? '').trim().toLowerCase();
  const useMihomoRuntime = requestedRuntime !== 'direct';
  const testLink = options.testLink ?? ((link: string) => (
    useMihomoRuntime
      ? testLinkMihomo(link, config, runtimePath, options)
      : testLinkDirect(link, config, options)
  ));
  return testLink(input.link, config, { runtime_path: runtimePath });
}
