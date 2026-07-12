import net from 'node:net';
import tls from 'node:tls';
import {
  openMihomoRuntime as defaultOpenMihomoRuntime,
  probeMihomoProxyDelay as defaultProbeMihomoProxyDelay,
  MihomoRuntime,
  OpenMihomoRuntimeOptions
} from './proxy-runtime.js';
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
    max_download_candidates: Number(config.max_download_candidates ?? 50)
  };
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onComplete?: (result: R, index: number, completed: number) => void
): Promise<R[]> {
  const limit = Math.max(1, Math.trunc(Number(concurrency) || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let completed = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const result = await worker(items[index], index);
      results[index] = result;
      completed += 1;
      onComplete?.(result, index, completed);
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  const failed = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
  return results;
}

function defaultNow(): number {
  return performance.now();
}

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
      timedOut = error instanceof Error && error.message.includes('response body timed out');
      throw error;
    } finally {
      if (timedOut || reachedCap) {
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
    throw new Error(`unexpected status ${status}`);
  }
}

async function retryTransientProbe<T>(operation: () => Promise<T>): Promise<T> {
  return retryTransientNetwork(operation, { maxAttempts: PROBE_MAX_ATTEMPTS, delayMs: 0 });
}

function socketConnect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`proxy connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function splitHttpHeaders(buffer: Buffer): { head: Buffer; body: Buffer } | undefined {
  const marker = buffer.indexOf('\r\n\r\n');
  if (marker < 0) {
    return undefined;
  }
  return {
    head: buffer.subarray(0, marker).subarray(0),
    body: buffer.subarray(marker + 4).subarray(0)
  };
}

function parseHttpStatus(head: Buffer): number {
  const firstLine = head.toString('latin1').split('\r\n')[0] ?? '';
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)/i.exec(firstLine);
  if (!match) {
    throw new Error(`invalid HTTP response: ${firstLine}`);
  }
  return Number(match[1]);
}

function readHttpBodyBytes(socket: net.Socket | tls.TLSSocket, maxBytes: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let headersParsed = false;
    let total = 0;
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`proxy download timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const finish = (bytes: number): void => {
      cleanup();
      socket.destroy();
      resolve(bytes);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(total);
    };
    const countBody = (chunk: Buffer): void => {
      total += Math.min(chunk.byteLength, Math.max(maxBytes - total, 0));
      if (total >= maxBytes) {
        finish(maxBytes);
      }
    };
    const onData = (chunk: Buffer): void => {
      if (!headersParsed) {
        buffered = Buffer.concat([buffered, chunk]);
        const split = splitHttpHeaders(buffered);
        if (!split) {
          return;
        }
        const status = parseHttpStatus(split.head);
        if (status < 200 || status >= 300) {
          cleanup();
          socket.destroy();
          reject(new Error(`unexpected status ${status}`));
          return;
        }
        headersParsed = true;
        if (split.body.byteLength > 0) {
          countBody(split.body);
        }
        return;
      }
      countBody(chunk);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

function readConnectResponse(socket: net.Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`proxy CONNECT timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const split = splitHttpHeaders(buffered);
      if (!split) {
        return;
      }
      const status = parseHttpStatus(split.head);
      cleanup();
      if (status < 200 || status >= 300) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed with status ${status}`));
        return;
      }
      resolve();
    };
    socket.on('data', onData);
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
  const proxy = new URL(proxyUrl);
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const proxyPort = Number(proxy.port || 80);
  const socket = await socketConnect(proxy.hostname, proxyPort, timeoutMs);
  const requestPath = `${target.pathname || '/'}${target.search}`;
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));

  if (target.protocol === 'http:') {
    socket.write([
      `GET ${target.toString()} HTTP/1.1`,
      `Host: ${target.host}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    return await readHttpBodyBytes(socket, Math.max(1, maxBytes), timeoutMs);
  }

  if (target.protocol !== 'https:') {
    socket.destroy();
    throw new Error(`unsupported speedtest URL protocol: ${target.protocol}`);
  }

  socket.write([
    `CONNECT ${target.hostname}:${targetPort} HTTP/1.1`,
    `Host: ${target.hostname}:${targetPort}`,
    'Connection: keep-alive',
    '',
    ''
  ].join('\r\n'));
  await readConnectResponse(socket, timeoutMs);
  const secureSocket = tls.connect({
    socket,
    servername: target.hostname,
    rejectUnauthorized: false
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      secureSocket.destroy();
      const error = new Error(`TLS handshake timed out after ${timeoutMs}ms`) as Error & { code?: string };
      error.code = 'AUTOVPN_INTERNAL_TIMEOUT';
      reject(error);
    }, timeoutMs);
    secureSocket.once('secureConnect', () => { clearTimeout(timer); resolve(); });
    secureSocket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  secureSocket.write([
    `GET ${requestPath} HTTP/1.1`,
    `Host: ${target.host}`,
    'Connection: close',
    '',
    ''
  ].join('\r\n'));
  return await readHttpBodyBytes(secureSocket, Math.max(1, maxBytes), timeoutMs);
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
  return mapWithConcurrency(links, config.concurrency, async (link) => {
    try {
      return await retryTransientProbe(async () => {
        const started = now();
        const response = await fetchWithTimeout(fetchImpl, config.probe_url, timeoutMs);
        const elapsed = Math.max(now() - started, 1);
        requireOkResponse(response, new Set([200, 204]));
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
  return mapWithConcurrency(links, config.concurrency, async (link) => {
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

  const probes = await probeLinks(input.links, config, { runtime_path: runtimePath });
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index];
    emitEvent(options.eventCallback, 'speedtest_probe_result', {
      completed: index + 1,
      total: input.links.length,
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

  const testedResults = await mapWithConcurrency(candidateLinks, config.concurrency, async (link) => (
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
  const emitProbe = (result: ProbeResult, completed: number): void => {
    options.progressCallback?.(`[speedtest:probe] ${completed}/${input.links.length} reachable=${result.reachable} latency=${result.latency_ms}ms`);
    emitEvent(options.eventCallback, 'speedtest_probe_result', {
      completed,
      total: input.links.length,
      link: result.link,
      reachable: result.reachable,
      latency_ms: result.latency_ms,
      error: result.error ?? ''
    });
  };
  if (options.probeLinks) {
    const results = await options.probeLinks(input.links, config, { runtime_path: runtimePath });
    results.forEach((result, index) => emitProbe(result, index + 1));
    return results;
  }
  return useMihomoRuntime
    ? probeLinksMihomo(input.links, config, runtimePath, options, emitProbe)
    : probeLinksDirect(input.links, config, options, emitProbe);
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
