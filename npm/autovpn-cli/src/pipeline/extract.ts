import crypto from 'node:crypto';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;
type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok?: boolean;
  status?: number;
  text(): Promise<string>;
}>;
type CurlFetchLike = (url: string, proxyUrl: string) => Promise<string>;
type ExtractEventCallback = (type: string, payload: Record<string, unknown>) => void;

export interface SourceConfigInput {
  url: string;
  key: string;
  enabled?: boolean;
  max_iterations?: number;
  min_iterations?: number;
  plateau_limit?: number;
  use_random_area?: boolean;
  area_min?: number;
  area_max?: number;
  failure_limit?: number;
  max_runtime_seconds?: number;
  resume_from_iteration?: number;
}

export interface ExtractInput {
  source_name: string;
  source: SourceConfigInput;
}

export interface ExtractedSourceResult {
  source_name: string;
  requested_iterations: number;
  successful_iterations: number;
  failed_iterations: number;
  links: string[];
}

export interface ExtractBackendOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  fetch?: FetchLike;
  curlFetch?: CurlFetchLike;
  eventCallback?: ExtractEventCallback;
  linksCallback?: (links: string[]) => void | Promise<void>;
  fetchSourceLinks?: (input: ExtractInput) => ExtractedSourceResult | Promise<ExtractedSourceResult>;
}

export interface RuntimeSourceUrlOptions {
  randomInt?: (start: number, end: number) => number;
  timeNow?: () => number;
}

function defaultRandomInt(start: number, end: number): number {
  return Math.floor(Math.random() * (end - start + 1)) + start;
}

export function buildRuntimeSourceUrl(source: SourceConfigInput, iteration = 0, options: RuntimeSourceUrlOptions = {}): string {
  const url = new URL(source.url);
  if (source.use_random_area && iteration > 0) {
    let areaMin = Number(source.area_min ?? 0);
    let areaMax = Number(source.area_max ?? 100);
    if (areaMin > areaMax) {
      [areaMin, areaMax] = [areaMax, areaMin];
    }
    url.searchParams.set('area', String((options.randomInt ?? defaultRandomInt)(areaMin, areaMax)));
  }
  if (url.searchParams.has('t')) {
    url.searchParams.set('t', (options.timeNow ?? (() => Date.now() / 1000))().toFixed(6));
  }
  return url.toString();
}

export function decryptPayload(cipherText: string, key: string): string {
  const keyBuffer = Buffer.from(key, 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuffer, keyBuffer);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64')), decipher.final()]);
  return plain.toString('utf8').replace(/\0+$/g, '');
}

export function transformNodeId(original: string): string {
  return String(original).split('-').map((part) => {
    const chunks = [];
    for (let index = 0; index < part.length; index += 4) {
      const chunk = part.slice(index, index + 4);
      if (chunk) {
        chunks.push(`${chunk.slice(2)}${chunk.slice(0, 2)}`);
      }
    }
    return chunks.join('');
  }).join('-');
}

function generateVmessLink(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  return `vmess://${encoded}`;
}

function linkFingerprint(link: string): string {
  try {
    const encoded = String(link).replace(/^vmess:\/\//, '');
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>;
    const canonical = JSON.stringify([
      payload.add ?? '',
      payload.port ?? '',
      payload.id ?? '',
      payload.net ?? '',
      payload.host ?? '',
      payload.path ?? '',
      payload.tls ?? '',
      payload.sni ?? ''
    ].map((value) => String(value)));
    return crypto.createHash('sha256').update(canonical).digest('hex');
  } catch {
    return crypto.createHash('sha256').update(String(link)).digest('hex');
  }
}

function payloadFromOutboundConfig(psName: string, jsonText: string): Record<string, unknown> {
  const config = JSON.parse(jsonText) as Record<string, any>;
  const outbound = (config.outbounds ?? []).find((item: Record<string, unknown>) => item.protocol === 'vmess');
  const vnext = outbound.settings.vnext[0];
  const user = vnext.users[0];
  const streamSettings = outbound.streamSettings ?? {};
  const wsSettings = streamSettings.wsSettings ?? {};
  const headers = wsSettings.headers ?? {};
  const host = wsSettings.host || headers.Host || vnext.address;
  const psValue = typeof config.ps === 'string' ? config.ps.trim() : (config.ps ?? psName);
  return {
    v: 2,
    ps: psValue,
    add: vnext.address,
    port: String(vnext.port),
    id: transformNodeId(user.id),
    aid: String(user.alterId ?? 0),
    scy: user.security ?? 'auto',
    net: streamSettings.network ?? 'ws',
    type: 'dtls',
    host,
    path: wsSettings.path ?? '',
    tls: streamSettings.security ?? '',
    sni: streamSettings.tlsSettings?.serverName ?? ''
  };
}

export function extractLinksFromPlaintext(sourceName: string, plaintext: string): string[] {
  const cleaned = String(plaintext).trim();
  if (!cleaned) {
    return [];
  }
  if (cleaned.startsWith('vmess://')) {
    return [cleaned];
  }
  const parts = cleaned.split('|');
  if (parts.length < 2) {
    return [];
  }
  const psName = parts[0].trim() || sourceName;
  const jsonText = parts[1].trim();
  return [generateVmessLink(payloadFromOutboundConfig(psName, jsonText))];
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

function isEnabled(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function resolveUpstreamProxyUrl(env: NodeJS.ProcessEnv): string {
  if (!isEnabled(env.VPN_AUTOMATION_USE_UPSTREAM_PROXY)) {
    return '';
  }
  const value = String(env.VPN_AUTOMATION_UPSTREAM_PROXY ?? 'http://127.0.0.1:7897').trim();
  return ['', 'off', 'none', 'false', '0'].includes(value.toLowerCase()) ? '' : value;
}

function isTlsFailure(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.name}: ${error.message}`.toLowerCase()
    : String(error).toLowerCase();
  if (text.includes('ssl') || text.includes('tls') || text.includes('certificate')) {
    return true;
  }
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (cause) {
    return isTlsFailure(cause);
  }
  return false;
}

function defaultCurlFetch(url: string, proxyUrl: string, spawn: SpawnLike = defaultSpawn): Promise<string> {
  const args = [
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--max-time',
    '20',
    '--connect-timeout',
    '10',
    '--insecure',
    '--http1.1',
    '--config',
    '-'
  ];
  if (proxyUrl) {
    args.push('--proxy', proxyUrl);
  } else {
    args.push('--noproxy', '*');
  }

  const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const completion = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error((stderr || stdout || 'curl TLS fallback failed').trim()));
    });
  });
  child.stdin?.write(`url = ${JSON.stringify(url)}\n`);
  child.stdin?.end();
  return completion;
}

function emitExtractEvent(options: ExtractBackendOptions, type: string, payload: Record<string, unknown>): void {
  options.eventCallback?.(type, payload);
}

async function fetchSourceText(
  input: ExtractInput,
  url: string,
  attempt: number,
  fetchImpl: FetchLike,
  options: ExtractBackendOptions,
  upstreamProxy: string
): Promise<{ text: string; via: string }> {
  try {
    const response = await fetchWithTimeout(fetchImpl, url, 20_000);
    if (response.ok === false || Number(response.status ?? 200) >= 400) {
      throw new Error(`HTTP ${Number(response.status ?? 0)}`);
    }
    const text = await response.text();
    emitExtractEvent(options, 'extract_request_result', {
      source_name: input.source_name,
      iteration: attempt,
      success: true,
      via: 'direct'
    });
    return { text, via: 'direct' };
  } catch (error) {
    const shouldRetry = Boolean(upstreamProxy) || isTlsFailure(error);
    emitExtractEvent(options, 'extract_request_result', {
      source_name: input.source_name,
      iteration: attempt,
      success: false,
      via: 'direct',
      error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
      will_retry: shouldRetry
    });
    if (!shouldRetry) {
      throw error;
    }
    const curlFetch = options.curlFetch ?? ((targetUrl, proxyUrl) => defaultCurlFetch(targetUrl, proxyUrl, options.spawn));
    const text = await curlFetch(url, upstreamProxy);
    const via = upstreamProxy ? 'upstream_proxy_curl_tls_fallback' : 'direct_curl_tls_fallback';
    emitExtractEvent(options, 'extract_request_result', {
      source_name: input.source_name,
      iteration: attempt,
      success: true,
      via
    });
    return { text, via };
  }
}

async function fetchSourceLinksInNode(input: ExtractInput, options: ExtractBackendOptions): Promise<ExtractedSourceResult> {
  const source = input.source;
  const maxIterations = Math.max(0, Math.trunc(numberOrDefault(source.max_iterations, 0)));
  const configuredMinIterations = Math.max(0, Math.trunc(numberOrDefault(source.min_iterations, 0)));
  const minIterations = configuredMinIterations > maxIterations ? 0 : configuredMinIterations;
  const plateauLimit = Math.max(1, Math.trunc(numberOrDefault(source.plateau_limit, 20)));
  const failureLimit = Math.max(1, Math.trunc(numberOrDefault(source.failure_limit, 1)));
  const maxRuntimeSeconds = Math.max(0, numberOrDefault(source.max_runtime_seconds, 0));
  const startIteration = Math.max(1, Math.trunc(numberOrDefault(source.resume_from_iteration, 1)));
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);

  if (!fetchImpl) {
    throw new Error('Node extract backend requires fetch support');
  }
  if (!String(source.url ?? '').trim() || !String(source.key ?? '').trim()) {
    return {
      source_name: input.source_name,
      requested_iterations: maxIterations,
      successful_iterations: 0,
      failed_iterations: 0,
      links: []
    };
  }

  const links: string[] = [];
  const seen = new Set<string>();
  let plateau = 0;
  let successes = 0;
  let failures = 0;
  const startedAt = Date.now();
  const upstreamProxy = resolveUpstreamProxyUrl(options.env ?? process.env);

  emitExtractEvent(options, 'extract_source_started', {
    source_name: input.source_name,
    requested_iterations: maxIterations,
    min_iterations: minIterations,
    resume_from_iteration: startIteration
  });

  for (let iteration = startIteration - 1; iteration < maxIterations; iteration += 1) {
    const attempt = iteration + 1;
    if (maxRuntimeSeconds > 0 && attempt > minIterations && (Date.now() - startedAt) / 1000 >= maxRuntimeSeconds) {
      break;
    }

    try {
      const url = buildRuntimeSourceUrl(source, iteration);
      const response = await fetchSourceText(input, url, attempt, fetchImpl, options, upstreamProxy);
      let plaintext = '';
      try {
        plaintext = decryptPayload(response.text.trim(), source.key);
        emitExtractEvent(options, 'extract_decrypt_result', {
          source_name: input.source_name,
          iteration: attempt,
          success: true
        });
      } catch (decryptError) {
        emitExtractEvent(options, 'extract_decrypt_result', {
          source_name: input.source_name,
          iteration: attempt,
          success: false,
          error: decryptError instanceof Error ? `${decryptError.constructor.name}: ${decryptError.message}` : String(decryptError)
        });
        throw decryptError;
      }
      const extracted = extractLinksFromPlaintext(input.source_name, plaintext);
      successes += 1;
      failures = 0;
      let newItems = 0;
      const newLinks: string[] = [];
      const newItemFingerprints: string[] = [];
      for (const link of extracted) {
        if (seen.has(link)) {
          continue;
        }
        seen.add(link);
        links.push(link);
        newLinks.push(link);
        newItems += 1;
        newItemFingerprints.push(linkFingerprint(link));
      }
      emitExtractEvent(options, 'extract_iteration', {
        source_name: input.source_name,
        iteration: attempt,
        requested_iterations: maxIterations,
        new_items: newItems,
        extracted_links: extracted.length,
        total_links: links.length,
        deduped_links: links.length,
        new_item_fingerprints: newItemFingerprints
      });
      if (newItems > 0) {
        await options.linksCallback?.(newLinks);
      }
      plateau = newItems === 0 ? plateau + 1 : 0;
      if (plateau >= plateauLimit && attempt >= minIterations) {
        break;
      }
    } catch (error) {
      failures += 1;
      if (failures >= failureLimit) {
        break;
      }
      if (attempt >= maxIterations) {
        throw new Error(`Node extract request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  emitExtractEvent(options, 'extract_source_completed', {
    source_name: input.source_name,
    requested_iterations: maxIterations,
    successful_iterations: successes,
    failed_iterations: failures,
    raw_links: links.length
  });

  return {
    source_name: input.source_name,
    requested_iterations: maxIterations,
    successful_iterations: successes,
    failed_iterations: failures,
    links
  };
}

export async function fetchSourceLinksWithBackend(input: ExtractInput, options: ExtractBackendOptions = {}): Promise<ExtractedSourceResult> {
  return options.fetchSourceLinks ? options.fetchSourceLinks(input) : fetchSourceLinksInNode(input, options);
}
