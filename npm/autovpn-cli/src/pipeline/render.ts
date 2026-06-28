import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';

export const MAIN_DATA_PLACEHOLDER = '__MAIN_DATA__';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

export interface RenderInput {
  template: string;
  links: string[];
}

export interface RenderOutput {
  rendered_source: string;
}

export interface RenderBackendOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  resolvePythonCli?: () => ResolvedPythonCli | Promise<ResolvedPythonCli>;
  pythonRender?: (input: RenderInput) => RenderOutput | Promise<RenderOutput>;
}

const PYTHON_RENDER_HELPER = `
import json
import sys
from vpn_automation.pipeline.render import replace_main_data

payload = json.load(sys.stdin)
json.dump(
    {"rendered_source": replace_main_data(payload["template"], list(payload.get("links") or []))},
    sys.stdout,
    ensure_ascii=False,
)
sys.stdout.write("\\n")
`;

export function replaceMainData(template: string, links: string[]): string {
  const occurrences = template.split(MAIN_DATA_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error('Template must contain exactly one MainData placeholder');
  }
  return template.replace(MAIN_DATA_PLACEHOLDER, links.join('\n'));
}

export function runRender(input: RenderInput): RenderOutput {
  return {
    rendered_source: replaceMainData(input.template, input.links ?? [])
  };
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

async function renderWithPython(input: RenderInput, options: RenderBackendOptions): Promise<RenderOutput> {
  const env = options.env ?? process.env;
  const resolved = options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(env);
  const child = (options.spawn ?? defaultSpawn)(pythonCommandFor(resolved), ['-c', PYTHON_RENDER_HELPER], {
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
  const completion = new Promise<RenderOutput>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python render backend failed with exit code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as RenderOutput);
      } catch (error) {
        reject(new Error(`Python render backend returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
  child.stdin?.write(JSON.stringify(input));
  child.stdin?.end();
  return completion;
}

export async function renderMainDataWithBackend(input: RenderInput, options: RenderBackendOptions = {}): Promise<RenderOutput> {
  if (selectPipelineStageBackend('render', options.env ?? process.env) === 'python') {
    return options.pythonRender ? options.pythonRender(input) : renderWithPython(input, options);
  }
  return runRender(input);
}
