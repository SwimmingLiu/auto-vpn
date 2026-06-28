import crypto from 'node:crypto';
import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

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
  resolvePythonCli?: () => ResolvedPythonCli | Promise<ResolvedPythonCli>;
  fetchSourceLinks?: (input: ExtractInput) => ExtractedSourceResult | Promise<ExtractedSourceResult>;
  pythonExtract?: (input: ExtractInput) => ExtractedSourceResult | Promise<ExtractedSourceResult>;
}

export interface RuntimeSourceUrlOptions {
  randomInt?: (start: number, end: number) => number;
  timeNow?: () => number;
}

const PYTHON_EXTRACT_HELPER = `
import json
import sys
from vpn_automation.config.models import SourceConfig
from vpn_automation.pipeline.extract import fetch_source_links

payload = json.load(sys.stdin)
result = fetch_source_links(payload["source_name"], SourceConfig(**payload["source"]))
json.dump(
    {
        "source_name": result.source_name,
        "requested_iterations": result.requested_iterations,
        "successful_iterations": result.successful_iterations,
        "failed_iterations": result.failed_iterations,
        "links": result.links,
    },
    sys.stdout,
    ensure_ascii=False,
)
sys.stdout.write("\\n")
`;

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

async function extractWithPython(input: ExtractInput, options: ExtractBackendOptions): Promise<ExtractedSourceResult> {
  const env = options.env ?? process.env;
  const resolved = options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(env);
  const child = (options.spawn ?? defaultSpawn)(pythonCommandFor(resolved), ['-c', PYTHON_EXTRACT_HELPER], {
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
  const completion = new Promise<ExtractedSourceResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python extract backend failed with exit code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ExtractedSourceResult);
      } catch (error) {
        reject(new Error(`Python extract backend returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
  child.stdin?.write(JSON.stringify(input));
  child.stdin?.end();
  return completion;
}

export async function fetchSourceLinksWithBackend(input: ExtractInput, options: ExtractBackendOptions = {}): Promise<ExtractedSourceResult> {
  if (selectPipelineStageBackend('extract', options.env ?? process.env) === 'python') {
    return options.pythonExtract ? options.pythonExtract(input) : extractWithPython(input, options);
  }
  if (!options.fetchSourceLinks) {
    throw new Error('Node extract backend requires a fetchSourceLinks implementation; use Python backend for runtime extraction');
  }
  return options.fetchSourceLinks(input);
}
