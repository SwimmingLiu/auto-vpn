import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { mergeProjectEnv } from '../runtime/env.js';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

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
  resolvePythonCli?: () => ResolvedPythonCli | Promise<ResolvedPythonCli>;
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

async function checkBatchInNode(input: AvailabilityBatchInput, options: AvailabilityBackendOptions): Promise<AvailabilityResultDict[]> {
  if (input.results.length === 0) {
    return [];
  }
  if (!options.checkLinkAvailability) {
    throw new Error('Node availability backend requires a checkLinkAvailability implementation; use Python backend for runtime checks');
  }
  const targets = normalizeProviderTargets(input.targets);
  const output: AvailabilityResultDict[] = [];
  for (let index = 0; index < input.results.length; index += 1) {
    const speedResult = input.results[index];
    let availability: AvailabilityResultDict;
    try {
      availability = availabilityResultToDict(await options.checkLinkAvailability(speedResult, input.config, {
        runtime_path: input.runtime_path ?? '',
        targets
      }));
    } catch (error) {
      availability = buildRuntimeErrorResult(speedResult, error instanceof Error ? error.message : String(error), targets);
    }
    output.push(availability);
    const completed = index + 1;
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
  }
  return output;
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
