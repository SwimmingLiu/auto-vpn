import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { mergeProjectEnv } from '../runtime/env.js';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

export interface DedupeBackendOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  resolvePythonCli?: () => ResolvedPythonCli | Promise<ResolvedPythonCli>;
  pythonDedupe?: (links: string[]) => string[] | Promise<string[]>;
}

const PYTHON_DEDUPE_HELPER = `
import json
import sys
from vpn_automation.pipeline.dedupe import dedupe_vmess_links

payload = json.load(sys.stdin)
json.dump(dedupe_vmess_links(payload["links"]), sys.stdout, ensure_ascii=False)
sys.stdout.write("\\n")
`;

export function parseVmessLink(link: string): Record<string, unknown> {
  const encoded = link.replace(/^vmess:\/\//, '');
  const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function canonicalVmessKey(payload: Record<string, unknown>): string {
  return JSON.stringify([
    payload.add ?? '',
    payload.port ?? '',
    payload.id ?? '',
    payload.net ?? '',
    payload.host ?? '',
    payload.path ?? '',
    payload.tls ?? '',
    payload.sni ?? ''
  ].map((value) => String(value)));
}

export function dedupeVmessLinks(links: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const link of links) {
    const key = canonicalVmessKey(parseVmessLink(link));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(link);
  }
  return result;
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

async function dedupeVmessLinksWithPython(links: string[], options: DedupeBackendOptions): Promise<string[]> {
  const env = mergeProjectEnv(options.cwd ?? process.cwd(), options.env ?? process.env);
  const resolved = options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(env);
  const child = (options.spawn ?? defaultSpawn)(pythonCommandFor(resolved), ['-c', PYTHON_DEDUPE_HELPER], {
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
  const completion = new Promise<string[]>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python dedupe backend failed with exit code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as string[]);
      } catch (error) {
        reject(new Error(`Python dedupe backend returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
  child.stdin?.write(JSON.stringify({ links }));
  child.stdin?.end();
  return completion;
}

export async function dedupeVmessLinksWithBackend(links: string[], options: DedupeBackendOptions = {}): Promise<string[]> {
  if (selectPipelineStageBackend('dedupe', options.env ?? process.env) === 'python') {
    return options.pythonDedupe ? options.pythonDedupe(links) : dedupeVmessLinksWithPython(links, options);
  }
  return dedupeVmessLinks(links);
}
