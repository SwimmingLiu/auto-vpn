import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { mergeProjectEnv } from '../runtime/env.js';
import {
  openMihomoRuntime as defaultOpenMihomoRuntime,
  MihomoRuntime,
  OpenMihomoRuntimeOptions
} from './proxy-runtime.js';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;
type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok?: boolean;
  status?: number;
  url?: string;
  text(): Promise<string>;
}>;

export interface ProxiedFetchResponse {
  final_url: string;
  status_code: number;
  body: string;
}

interface ProxiedHttpResponse extends ProxiedFetchResponse {
  headers: Record<string, string | string[] | undefined>;
}

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

export interface ProviderTarget {
  name: string;
  url: string;
  allowed_hosts: string[];
  negative_phrases: string[];
}

export interface AvailabilityTargetConfig {
  url?: string;
  enabled?: boolean;
  allowed_hosts?: string[];
  negative_phrases?: string[];
}

export interface ProviderCheckResult {
  provider: string;
  passed: boolean;
  reason: string;
  status_code?: number;
  final_url?: string;
  matched_phrase?: string;
}

export interface SpeedTestResult {
  link: string;
  reachable: boolean;
  average_download_mb_s: number;
  latency_ms: number;
  error?: string;
}

export interface AvailabilityResult {
  speed_result: SpeedTestResult;
  provider_results: Record<string, ProviderCheckResult>;
}

export interface AvailabilityResultDict extends SpeedTestResult {
  all_passed: boolean;
  provider_results: Record<string, Required<ProviderCheckResult>>;
}

export interface AvailabilityBatchInput {
  results: SpeedTestResult[];
  config: Record<string, unknown>;
  runtime_path?: string;
  targets?: Record<string, AvailabilityTargetConfig> | ProviderTarget[] | null;
}

export interface AvailabilityBackendOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  fetch?: FetchLike;
  resolvePythonCli?: () => ResolvedPythonCli | Promise<ResolvedPythonCli>;
  openMihomoRuntime?: (link: string, options: OpenMihomoRuntimeOptions) => Promise<Pick<MihomoRuntime, 'proxies' | 'close'>>;
  fetchUrlViaHttpProxy?: (url: string, proxyUrl: string, timeoutSeconds: number) => Promise<ProxiedFetchResponse>;
  checkLinkAvailability?: (speedResult: SpeedTestResult, config: Record<string, unknown>, options: { runtime_path: string; targets: ProviderTarget[] }) => AvailabilityResult | Promise<AvailabilityResult>;
  pythonAvailability?: (input: AvailabilityBatchInput) => AvailabilityResultDict[] | Promise<AvailabilityResultDict[]>;
  progressCallback?: (message: string) => void;
  eventCallback?: (eventType: string, payload: Record<string, unknown>) => void;
}

const PROVIDER_TARGETS: ProviderTarget[] = [
  { name: 'gemini', url: 'https://gemini.google.com', allowed_hosts: ['gemini.google.com'], negative_phrases: [] },
  { name: 'chatgpt_ios', url: 'https://ios.chat.openai.com/', allowed_hosts: ['ios.chat.openai.com'], negative_phrases: [] },
  { name: 'chatgpt_web', url: 'https://api.openai.com/compliance/cookie_requirements', allowed_hosts: ['api.openai.com'], negative_phrases: [] },
  { name: 'claude', url: 'https://claude.ai/cdn-cgi/trace', allowed_hosts: ['claude.ai'], negative_phrases: [] }
];

const CHALLENGE_PHRASES = [
  'just a moment',
  'checking your browser',
  'verify you are human',
  'enable javascript and cookies'
];

const PYTHON_AVAILABILITY_HELPER = `
import json
import sys
from vpn_automation.config.models import AvailabilityTargetConfig, SpeedTestConfig
from vpn_automation.pipeline.availability import ProviderTarget, check_link_availability_batch
from vpn_automation.pipeline.speedtest import SpeedTestResult

payload = json.load(sys.stdin)
config = SpeedTestConfig(**payload["config"])
results = [SpeedTestResult(**item) for item in payload.get("results", [])]
raw_targets = payload.get("targets", None)
targets = None
if isinstance(raw_targets, list):
    targets = tuple(
        ProviderTarget(
            name=str(item["name"]),
            url=str(item["url"]),
            allowed_hosts=tuple(item.get("allowed_hosts") or []),
            negative_phrases=tuple(item.get("negative_phrases") or []),
        )
        for item in raw_targets
    )
elif isinstance(raw_targets, dict):
    targets = {name: AvailabilityTargetConfig(**value) for name, value in raw_targets.items()}
output = [
    item.to_dict()
    for item in check_link_availability_batch(
        results,
        config,
        runtime_path=payload.get("runtime_path", ""),
        targets=targets,
    )
]
json.dump(output, sys.stdout, ensure_ascii=False)
sys.stdout.write("\\n")
`;

function providerResultWithDefaults(result: ProviderCheckResult): Required<ProviderCheckResult> {
  return {
    provider: result.provider,
    passed: result.passed,
    reason: result.reason,
    status_code: result.status_code ?? 0,
    final_url: result.final_url ?? '',
    matched_phrase: result.matched_phrase ?? ''
  };
}

function hostIsAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function hostnameFor(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function normalizeProviderTargets(
  targets?: Record<string, AvailabilityTargetConfig> | ProviderTarget[] | null
): ProviderTarget[] {
  if (targets == null) {
    return PROVIDER_TARGETS.map((target) => ({ ...target, allowed_hosts: [...target.allowed_hosts], negative_phrases: [...target.negative_phrases] }));
  }
  if (Array.isArray(targets)) {
    return targets.map((target) => ({
      name: String(target.name),
      url: String(target.url),
      allowed_hosts: (target.allowed_hosts ?? []).map((host) => String(host)),
      negative_phrases: (target.negative_phrases ?? []).map((phrase) => String(phrase))
    }));
  }

  const normalized: ProviderTarget[] = [];
  for (const [name, config] of Object.entries(targets)) {
    if (config.enabled === false) {
      continue;
    }
    const url = String(config.url ?? '').trim();
    if (!url) {
      continue;
    }
    let allowedHosts = (config.allowed_hosts ?? [])
      .map((host) => String(host).trim().toLowerCase())
      .filter(Boolean);
    if (allowedHosts.length === 0) {
      const host = hostnameFor(url).toLowerCase();
      allowedHosts = host ? [host] : [];
    }
    normalized.push({
      name: String(name),
      url,
      allowed_hosts: allowedHosts,
      negative_phrases: []
    });
  }
  return normalized;
}

export function evaluateProviderResponse(
  target: ProviderTarget,
  response: { final_url: string; status_code: number; title: string; body: string }
): Required<ProviderCheckResult> {
  const finalUrl = response.final_url;
  const statusCode = Number(response.status_code || 0);
  const host = hostnameFor(finalUrl);
  if (!host || !hostIsAllowed(host, target.allowed_hosts)) {
    return {
      provider: target.name,
      passed: false,
      reason: 'unexpected_host',
      status_code: statusCode,
      final_url: finalUrl,
      matched_phrase: ''
    };
  }

  if (target.name.trim().toLowerCase().replaceAll('-', '_') === 'chatgpt_ios') {
    const body = response.body.toLowerCase();
    if (body.includes('you may be connected to a disallowed isp')) {
      return {
        provider: target.name,
        passed: false,
        reason: 'disallowed_isp',
        status_code: statusCode,
        final_url: finalUrl,
        matched_phrase: ''
      };
    }
    if (body.includes('request is not allowed. please try again later.')) {
      return {
        provider: target.name,
        passed: true,
        reason: 'ok',
        status_code: statusCode,
        final_url: finalUrl,
        matched_phrase: ''
      };
    }
    if (body.includes('sorry, you have been blocked')) {
      return {
        provider: target.name,
        passed: false,
        reason: 'blocked',
        status_code: statusCode,
        final_url: finalUrl,
        matched_phrase: ''
      };
    }
    return {
      provider: target.name,
      passed: false,
      reason: 'unlock_failed',
      status_code: statusCode,
      final_url: finalUrl,
      matched_phrase: ''
    };
  }

  if (statusCode >= 400) {
    return {
      provider: target.name,
      passed: false,
      reason: 'http_error',
      status_code: statusCode,
      final_url: finalUrl,
      matched_phrase: ''
    };
  }

  const content = `${response.title}\n${response.body}`.toLowerCase();
  for (const phrase of CHALLENGE_PHRASES) {
    if (content.includes(phrase)) {
      return {
        provider: target.name,
        passed: false,
        reason: 'challenge_page',
        status_code: statusCode,
        final_url: finalUrl,
        matched_phrase: phrase
      };
    }
  }

  for (const phrase of target.negative_phrases) {
    if (content.includes(String(phrase).toLowerCase())) {
      return {
        provider: target.name,
        passed: false,
        reason: 'negative_phrase',
        status_code: statusCode,
        final_url: finalUrl,
        matched_phrase: phrase
      };
    }
  }

  return {
    provider: target.name,
    passed: true,
    reason: 'ok',
    status_code: statusCode,
    final_url: finalUrl,
    matched_phrase: ''
  };
}

export function availabilityResultToDict(result: AvailabilityResult): AvailabilityResultDict {
  const providerResults = Object.fromEntries(
    Object.entries(result.provider_results).map(([name, provider]) => [name, providerResultWithDefaults(provider)])
  );
  return {
    link: result.speed_result.link,
    reachable: result.speed_result.reachable,
    average_download_mb_s: result.speed_result.average_download_mb_s,
    latency_ms: result.speed_result.latency_ms,
    all_passed: Object.values(providerResults).every((provider) => provider.passed),
    provider_results: providerResults
  };
}

function buildRuntimeErrorResult(speedResult: SpeedTestResult, reason: string, targets: ProviderTarget[]): AvailabilityResultDict {
  return availabilityResultToDict({
    speed_result: speedResult,
    provider_results: Object.fromEntries(targets.map((target) => [target.name, {
      provider: target.name,
      passed: false,
      reason: 'runtime_error',
      final_url: target.url,
      matched_phrase: reason,
      status_code: 0
    }]))
  });
}

function emitEvent(callback: AvailabilityBackendOptions['eventCallback'], eventType: string, payload: Record<string, unknown>): void {
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<Awaited<ReturnType<FetchLike>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractTitle(html: string): string {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
}

async function checkLinkAvailabilityDirect(
  speedResult: SpeedTestResult,
  config: Record<string, unknown>,
  options: { targets: ProviderTarget[]; fetch?: FetchLike }
): Promise<AvailabilityResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error('Node availability backend requires fetch support');
  }
  const timeoutMs = Math.max(1, numberOrDefault(config.timeout_seconds, 20)) * 1000;
  const providerResults: Record<string, ProviderCheckResult> = {};
  for (const target of options.targets) {
    try {
      const response = await fetchWithTimeout(fetchImpl, target.url, timeoutMs);
      const body = await response.text();
      providerResults[target.name] = evaluateProviderResponse(target, {
        final_url: String(response.url ?? target.url),
        status_code: Number(response.status ?? 200),
        title: extractTitle(body),
        body
      });
    } catch (error) {
      providerResults[target.name] = {
        provider: target.name,
        passed: false,
        reason: 'runtime_error',
        status_code: 0,
        final_url: target.url,
        matched_phrase: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return {
    speed_result: speedResult,
    provider_results: providerResults
  };
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
    head: buffer.subarray(0, marker),
    body: buffer.subarray(marker + 4)
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

function parseHttpHeaders(head: Buffer): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const line of head.toString('latin1').split('\r\n').slice(1)) {
    const separator = line.indexOf(':');
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const existing = headers[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing) {
      headers[key] = [existing, value];
    } else {
      headers[key] = value;
    }
  }
  return headers;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function redirectTarget(current: URL, response: ProxiedHttpResponse): URL | undefined {
  if (response.status_code < 300 || response.status_code >= 400) {
    return undefined;
  }
  const location = headerValue(response.headers, 'location');
  return location ? new URL(location, current) : undefined;
}

function fetchHttpUrlViaHttpProxy(target: URL, proxy: URL, timeoutMs: number): Promise<ProxiedHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'GET',
      path: target.toString(),
      headers: {
        Host: target.host,
        Connection: 'close'
      },
      agent: false,
      timeout: timeoutMs
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => {
        resolve({
          final_url: target.toString(),
          status_code: Number(response.statusCode ?? 0),
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers
        });
      });
    });
    request.once('timeout', () => {
      request.destroy(new Error(`proxy fetch timed out after ${timeoutMs}ms`));
    });
    request.once('error', reject);
    request.end();
  });
}

function readHttpResponse(socket: net.Socket | tls.TLSSocket, timeoutMs: number): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let headersParsed = false;
    let status = 0;
    let headers: Record<string, string | string[] | undefined> = {};
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`proxy fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      cleanup();
      if (!headersParsed) {
        reject(new Error('proxy response ended before HTTP headers were received'));
        return;
      }
      resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8') });
    };
    const onData = (chunk: Buffer): void => {
      if (!headersParsed) {
        buffered = Buffer.concat([buffered, chunk]);
        const split = splitHttpHeaders(buffered);
        if (!split) {
          return;
        }
        status = parseHttpStatus(split.head);
        headers = parseHttpHeaders(split.head);
        headersParsed = true;
        if (split.body.byteLength > 0) {
          chunks.push(split.body);
        }
        return;
      }
      chunks.push(chunk);
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

function waitForSecureConnect(socket: tls.TLSSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`proxy TLS handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('secureConnect', onSecureConnect);
      socket.off('error', onError);
    };
    const onSecureConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.once('secureConnect', onSecureConnect);
    socket.once('error', onError);
  });
}

async function fetchUrlViaHttpProxyTarget(
  target: URL,
  proxy: URL,
  timeoutMs: number,
  redirectsRemaining: number
): Promise<ProxiedFetchResponse> {
  if (target.protocol === 'http:') {
    const response = await fetchHttpUrlViaHttpProxy(target, proxy, timeoutMs);
    const next = redirectTarget(target, response);
    if (next) {
      if (redirectsRemaining <= 0) {
        throw new Error(`too many redirects while fetching ${target.toString()}`);
      }
      return fetchUrlViaHttpProxyTarget(next, proxy, timeoutMs, redirectsRemaining - 1);
    }
    return {
      final_url: response.final_url,
      status_code: response.status_code,
      body: response.body
    };
  }

  if (target.protocol !== 'https:') {
    throw new Error(`unsupported availability URL protocol: ${target.protocol}`);
  }

  const proxyPort = Number(proxy.port || 80);
  const socket = await socketConnect(proxy.hostname, proxyPort, timeoutMs);
  const targetPort = Number(target.port || 443);
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
    rejectUnauthorized: true
  });
  await waitForSecureConnect(secureSocket, timeoutMs);
  secureSocket.write([
    `GET ${target.pathname || '/'}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    'Connection: close',
    '',
    ''
  ].join('\r\n'));
  const response = await readHttpResponse(secureSocket, timeoutMs);
  const proxiedResponse: ProxiedHttpResponse = {
    final_url: target.toString(),
    status_code: response.status,
    body: response.body,
    headers: response.headers
  };
  const next = redirectTarget(target, proxiedResponse);
  if (next) {
    if (redirectsRemaining <= 0) {
      throw new Error(`too many redirects while fetching ${target.toString()}`);
    }
    return fetchUrlViaHttpProxyTarget(next, proxy, timeoutMs, redirectsRemaining - 1);
  }
  return {
    final_url: target.toString(),
    status_code: response.status,
    body: response.body
  };
}

export async function fetchUrlViaHttpProxy(
  url: string,
  proxyUrl: string,
  timeoutSeconds: number
): Promise<ProxiedFetchResponse> {
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  return fetchUrlViaHttpProxyTarget(new URL(url), new URL(proxyUrl), timeoutMs, 5);
}

async function checkLinkAvailabilityMihomo(
  speedResult: SpeedTestResult,
  config: Record<string, unknown>,
  options: AvailabilityBackendOptions & { targets: ProviderTarget[]; runtimePath: string }
): Promise<AvailabilityResult> {
  const openRuntime = options.openMihomoRuntime ?? defaultOpenMihomoRuntime;
  const fetchViaProxy = options.fetchUrlViaHttpProxy ?? fetchUrlViaHttpProxy;
  let runtime: Pick<MihomoRuntime, 'proxies' | 'close'> | undefined;
  try {
    runtime = await openRuntime(speedResult.link, {
      runtimePath: options.runtimePath,
      startupWaitSeconds: numberOrDefault(config.startup_wait_seconds, 1),
      env: options.env
    });
    const providerResults: Record<string, ProviderCheckResult> = {};
    const timeoutSeconds = Math.max(1, numberOrDefault(config.timeout_seconds, 20));
    for (const target of options.targets) {
      try {
        const response = await fetchViaProxy(target.url, runtime.proxies.http, timeoutSeconds);
        providerResults[target.name] = evaluateProviderResponse(target, {
          final_url: response.final_url,
          status_code: response.status_code,
          title: extractTitle(response.body),
          body: response.body
        });
      } catch (error) {
        providerResults[target.name] = {
          provider: target.name,
          passed: false,
          reason: 'runtime_error',
          status_code: 0,
          final_url: target.url,
          matched_phrase: error instanceof Error ? error.message : String(error)
        };
      }
    }
    return {
      speed_result: speedResult,
      provider_results: providerResults
    };
  } finally {
    await runtime?.close();
  }
}

async function checkBatchInNode(input: AvailabilityBatchInput, options: AvailabilityBackendOptions): Promise<AvailabilityResultDict[]> {
  if (input.results.length === 0) {
    return [];
  }
  const targets = normalizeProviderTargets(input.targets);
  const requestedRuntime = String((options.env ?? process.env).AUTOVPN_AVAILABILITY_RUNTIME ?? '').trim().toLowerCase();
  const useMihomoRuntime = requestedRuntime !== 'direct';
  const checkLinkAvailability = options.checkLinkAvailability ?? ((speedResult: SpeedTestResult, config: Record<string, unknown>) => (
    useMihomoRuntime
      ? checkLinkAvailabilityMihomo(speedResult, config, {
        ...options,
        targets,
        runtimePath: input.runtime_path ?? ''
      })
      : checkLinkAvailabilityDirect(speedResult, config, { targets, fetch: options.fetch })
  ));
  return mapWithConcurrency(input.results, numberOrDefault(input.config.concurrency, 1), async (speedResult) => {
    let availability: AvailabilityResultDict;
    try {
      availability = availabilityResultToDict(await checkLinkAvailability(speedResult, input.config, {
        runtime_path: input.runtime_path ?? '',
        targets
      }));
    } catch (error) {
      availability = buildRuntimeErrorResult(speedResult, error instanceof Error ? error.message : String(error), targets);
    }
    return availability;
  }, (availability, _index, completed) => {
    if (options.progressCallback) {
      const statuses = Object.entries(availability.provider_results)
        .map(([name, provider]) => `${name}=${provider.passed ? 'ok' : provider.reason}`)
        .join(' ');
      options.progressCallback(`[availability] ${completed}/${input.results.length} ${statuses}`);
    }
    emitEvent(options.eventCallback, 'availability_link_result', {
      completed,
      total: input.results.length,
      link: availability.link,
      all_passed: availability.all_passed,
      provider_results: availability.provider_results
    });
  });
}

export function selectPipelineStageBackend(stage: string, env: NodeJS.ProcessEnv = process.env): PipelineStageBackend {
  void stage;
  void env;
  return 'node';
}

async function defaultResolvePythonCli(env: NodeJS.ProcessEnv): Promise<ResolvedPythonCli> {
  // @ts-expect-error Phase 1 runner remains plain ESM JavaScript.
  const runner = await import('../../lib/runner.mjs');
  return runner.resolveOrInstallPythonCli({ env });
}

function pythonCommandFor(resolved: ResolvedPythonCli): string {
  const command = resolved.command;
  const name = path.basename(command).toLowerCase();
  if (['autovpn', 'autovpn.exe'].includes(name)) {
    const executable = process.platform === 'win32' ? 'python.exe' : 'python';
    return path.join(path.dirname(command), executable);
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

async function availabilityWithPython(input: AvailabilityBatchInput, options: AvailabilityBackendOptions): Promise<AvailabilityResultDict[]> {
  const env = mergeProjectEnv(options.cwd ?? process.cwd(), options.env ?? process.env);
  const resolved = options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(env);
  const child = (options.spawn ?? defaultSpawn)(pythonCommandFor(resolved), ['-c', PYTHON_AVAILABILITY_HELPER], {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const completion = new Promise<AvailabilityResultDict[]>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python availability backend failed with exit code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as AvailabilityResultDict[]);
      } catch (error) {
        reject(new Error(`Python availability backend returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
  child.stdin?.write(JSON.stringify(input));
  child.stdin?.end();
  return completion;
}

export async function checkLinkAvailabilityBatchWithBackend(
  input: AvailabilityBatchInput,
  options: AvailabilityBackendOptions = {}
): Promise<AvailabilityResultDict[]> {
  if (selectPipelineStageBackend('availability', options.env ?? process.env) === 'python') {
    return options.pythonAvailability ? options.pythonAvailability(input) : availabilityWithPython(input, options);
  }
  return checkBatchInNode(input, options);
}
