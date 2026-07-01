import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { mergeProjectEnv } from '../runtime/env.js';
import {
  openMihomoRuntime as defaultOpenMihomoRuntime,
  probeMihomoProxyDelay as defaultProbeMihomoProxyDelay,
  MihomoRuntime,
  OpenMihomoRuntimeOptions
} from './proxy-runtime.js';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;
type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok?: boolean;
  status?: number;
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

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
  spawn?: SpawnLike;
  fetch?: FetchLike;
  now?: () => number;
  resolvePythonCli?: () => ResolvedPythonCli | Promise<ResolvedPythonCli>;
  openMihomoRuntime?: (link: string, options: OpenMihomoRuntimeOptions) => Promise<Pick<MihomoRuntime, 'controllerUrl' | 'proxyName' | 'close'>>;
  probeMihomoProxyDelay?: (controllerUrl: string, proxyName: string, probeUrl: string, timeoutSeconds: number) => Promise<number>;
  probeLinks?: (links: string[], config: Required<SpeedTestConfigInput>, options: { runtime_path: string }) => ProbeResult[] | Promise<ProbeResult[]>;
  testLink?: (link: string, config: Required<SpeedTestConfigInput>, options: { runtime_path: string }) => SpeedTestResult | Promise<SpeedTestResult>;
  pythonSpeedtest?: (input: SpeedTestInput) => SpeedTestResult[] | Promise<SpeedTestResult[]>;
  progressCallback?: (message: string) => void;
  eventCallback?: (eventType: string, payload: Record<string, unknown>) => void;
}

const PYTHON_SPEEDTEST_HELPER = `
import json
import sys
from vpn_automation.config.models import SpeedTestConfig
from vpn_automation.pipeline.speedtest import speedtest_links

payload = json.load(sys.stdin)
output = [
    item.__dict__
    for item in speedtest_links(
        payload.get("links", []),
        SpeedTestConfig(**payload["config"]),
        runtime_path=payload.get("runtime_path", ""),
    )
]
json.dump(output, sys.stdout, ensure_ascii=False)
sys.stdout.write("\\n")
`;

export function aggregateSpeedMeasurements(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(3));
}

function normalizeConfig(config: SpeedTestConfigInput): Required<SpeedTestConfigInput> {
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

function defaultNow(): number {
  return performance.now();
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

async function readResponseBytes(response: Awaited<ReturnType<FetchLike>>, maxBytes: number): Promise<number> {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += Math.min(value.byteLength, maxBytes - total);
      }
    } finally {
      reader.releaseLock();
    }
    return total;
  }
  if (response.arrayBuffer) {
    return Math.min((await response.arrayBuffer()).byteLength, maxBytes);
  }
  return 0;
}

function requireOkResponse(response: Awaited<ReturnType<FetchLike>>, allowedStatuses: Set<number>): void {
  const status = Number(response.status ?? 200);
  if (response.ok === false || !allowedStatuses.has(status)) {
    throw new Error(`unexpected status ${status}`);
  }
}

async function probeLinksDirect(
  links: string[],
  config: Required<SpeedTestConfigInput>,
  options: SpeedTestBackendOptions
): Promise<ProbeResult[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error('Node speedtest backend requires fetch support');
  }
  const now = options.now ?? defaultNow;
  const timeoutMs = Math.max(1, Number(config.timeout_seconds)) * 1000;
  const results: ProbeResult[] = [];
  for (const link of links) {
    const started = now();
    try {
      const response = await fetchWithTimeout(fetchImpl, config.probe_url, timeoutMs);
      const elapsed = Math.max(now() - started, 1);
      requireOkResponse(response, new Set([200, 204]));
      results.push({ link, reachable: true, latency_ms: Math.max(Math.round(elapsed), 1), error: '' });
    } catch (error) {
      results.push({ link, reachable: false, latency_ms: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

async function probeLinksMihomo(
  links: string[],
  config: Required<SpeedTestConfigInput>,
  runtimePath: string,
  options: SpeedTestBackendOptions
): Promise<ProbeResult[]> {
  const openRuntime = options.openMihomoRuntime ?? defaultOpenMihomoRuntime;
  const probeDelay = options.probeMihomoProxyDelay ?? defaultProbeMihomoProxyDelay;
  const results: ProbeResult[] = [];
  for (const link of links) {
    let runtime: Pick<MihomoRuntime, 'controllerUrl' | 'proxyName' | 'close'> | undefined;
    try {
      runtime = await openRuntime(link, {
        runtimePath,
        startupWaitSeconds: config.startup_wait_seconds,
        env: options.env
      });
      const latencyMs = await probeDelay(runtime.controllerUrl, runtime.proxyName, config.probe_url, config.timeout_seconds);
      results.push({ link, reachable: true, latency_ms: latencyMs, error: '' });
    } catch (error) {
      results.push({ link, reachable: false, latency_ms: 0, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await runtime?.close();
    }
  }
  return results;
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
      const total = await readResponseBytes(response, Math.max(1, Number(config.max_download_bytes)));
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

async function speedtestInNode(input: SpeedTestInput, options: SpeedTestBackendOptions): Promise<SpeedTestResult[]> {
  if (input.links.length === 0) {
    return [];
  }

  const config = normalizeConfig(input.config);
  const runtimePath = input.runtime_path ?? '';
  const requestedRuntime = String((options.env ?? process.env).AUTOVPN_SPEEDTEST_RUNTIME ?? '').trim().toLowerCase();
  const useMihomoRuntime = requestedRuntime === 'mihomo';
  const probeLinks = options.probeLinks ?? ((links: string[]) => (
    useMihomoRuntime
      ? probeLinksMihomo(links, config, runtimePath, options)
      : probeLinksDirect(links, config, options)
  ));
  const testLink = options.testLink ?? ((link: string) => testLinkDirect(link, config, options));
  const runtimeCore = useMihomoRuntime || options.probeLinks || options.testLink ? 'mihomo' : 'direct';
  options.progressCallback?.(`[speedtest] runtime_core=${runtimeCore} probe_url=${config.probe_url}`);
  emitEvent(options.eventCallback, 'speedtest_runtime', {
    runtime_core: runtimeCore,
    probe_url: config.probe_url,
    urls: [...config.urls]
  });

  const probes = await probeLinks(input.links, config, { runtime_path: runtimePath });
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

  for (let index = 0; index < candidateLinks.length; index += 1) {
    const result = await testLink(candidateLinks[index], config, { runtime_path: runtimePath });
    if (result.reachable && result.latency_ms <= 0) {
      result.latency_ms = probeByLink.get(result.link)?.latency_ms ?? 0;
    }
    results.push(result);
    const completed = index + 1;
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
  }
  return results;
}

export function selectPipelineStageBackend(stage: string, env: NodeJS.ProcessEnv = process.env): PipelineStageBackend {
  const stageKey = `AUTOVPN_STAGE_BACKEND_${stage.toUpperCase()}`;
  const stageOverride = String(env[stageKey] ?? '').trim().toLowerCase();
  const pipelineOverride = String(env.AUTOVPN_PIPELINE_BACKEND ?? '').trim().toLowerCase();
  const selected = stageOverride || pipelineOverride || 'node';
  return selected === 'python' ? 'python' : 'node';
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

async function speedtestWithPython(input: SpeedTestInput, options: SpeedTestBackendOptions): Promise<SpeedTestResult[]> {
  const env = mergeProjectEnv(options.cwd ?? process.cwd(), options.env ?? process.env);
  const resolved = options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(env);
  const child = (options.spawn ?? defaultSpawn)(pythonCommandFor(resolved), ['-c', PYTHON_SPEEDTEST_HELPER], {
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
  const completion = new Promise<SpeedTestResult[]>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python speedtest backend failed with exit code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as SpeedTestResult[]);
      } catch (error) {
        reject(new Error(`Python speedtest backend returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
  child.stdin?.write(JSON.stringify(input));
  child.stdin?.end();
  return completion;
}

export async function speedtestLinksWithBackend(input: SpeedTestInput, options: SpeedTestBackendOptions = {}): Promise<SpeedTestResult[]> {
  if (selectPipelineStageBackend('speedtest', options.env ?? process.env) === 'python') {
    return options.pythonSpeedtest ? options.pythonSpeedtest(input) : speedtestWithPython(input, options);
  }
  return speedtestInNode(input, options);
}
