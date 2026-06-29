import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { mergeProjectEnv } from '../runtime/env.js';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

export interface DeployInput {
  projectRoot: string;
  bundleDir: string;
  deploy: Record<string, unknown>;
}

export interface VerifyInput {
  projectRoot: string;
  deploy: Record<string, unknown>;
  deployment: Record<string, unknown>;
}

export interface DeployVerifyBackendOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  resolvePythonCli?: () => ResolvedPythonCli | Promise<ResolvedPythonCli>;
  pythonDeploy?: (input: DeployInput) => Record<string, unknown> | Promise<Record<string, unknown>>;
  pythonVerify?: (input: VerifyInput) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

const PYTHON_DEPLOY_HELPER = `
import json
import sys
from pathlib import Path
from vpn_automation.config.models import DeployConfig
from vpn_automation.config.runtime import load_runtime_env
from vpn_automation.integrations.cloudflare import deploy_pages_bundle, resolve_cloudflare_credentials

payload = json.load(sys.stdin)
deploy = DeployConfig(**payload["deploy"])
runtime_env = load_runtime_env(Path(payload["project_root"]))
credentials = resolve_cloudflare_credentials(deploy, runtime_env)
result = deploy_pages_bundle(Path(payload["bundle_dir"]), deploy, credentials)
json.dump(result, sys.stdout, ensure_ascii=False)
sys.stdout.write("\\n")
`;

const PYTHON_VERIFY_HELPER = `
import json
import sys
from pathlib import Path
from vpn_automation.config.models import DeployConfig
from vpn_automation.config.runtime import load_runtime_env
from vpn_automation.integrations.cloudflare import resolve_cloudflare_credentials
from vpn_automation.backend_resume import (
    _cleanup_blocked_pages_project,
    _default_verify,
    _is_verify_success,
    _merge_deploy_verification_target,
)

payload = json.load(sys.stdin)
deploy = DeployConfig(**payload["deploy"])
deployment = payload.get("deployment", {})
runtime_env = load_runtime_env(Path(payload["project_root"]))
credentials = resolve_cloudflare_credentials(deploy, runtime_env)
target = _merge_deploy_verification_target(deploy, deployment)
verification = _default_verify(target, credentials)
result = dict(verification)
if _is_verify_success(verification):
    result.update(_cleanup_blocked_pages_project(target, deployment, credentials))
json.dump(result, sys.stdout, ensure_ascii=False)
sys.stdout.write("\\n")
`;

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
    if (!path.isAbsolute(command)) {
      throw new Error(
        'Python deploy/verify fallback requires an absolute AUTOVPN_PYTHON_CLI path; PATH autovpn cannot identify its Python interpreter safely'
      );
    }
    const executable = process.platform === 'win32' ? 'python.exe' : 'python';
    return path.join(path.dirname(command), executable);
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

async function runPythonJsonHelper(
  code: string,
  payload: unknown,
  options: DeployVerifyBackendOptions,
  stageName: string
): Promise<Record<string, unknown>> {
  const cwd = options.cwd ?? process.cwd();
  const env = mergeProjectEnv(cwd, options.env ?? process.env);
  const resolved = options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(env);
  const child = (options.spawn ?? defaultSpawn)(pythonCommandFor(resolved), ['-c', code], {
    cwd,
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
  const completion = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`Python ${stageName} backend failed with exit code ${exitCode}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`Python ${stageName} backend returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
  child.stdin?.write(JSON.stringify(payload));
  child.stdin?.end();
  return completion;
}

export async function deployPagesWithBackend(input: DeployInput, options: DeployVerifyBackendOptions = {}): Promise<Record<string, unknown>> {
  if (selectPipelineStageBackend('deploy', options.env ?? process.env) !== 'python') {
    throw new Error('Node deploy backend is not available yet; set AUTOVPN_STAGE_BACKEND_DEPLOY=python to use the Python deployment adapter');
  }
  if (options.pythonDeploy) {
    return options.pythonDeploy(input);
  }
  return runPythonJsonHelper(PYTHON_DEPLOY_HELPER, input, options, 'deploy');
}

export async function verifyDeploymentWithBackend(input: VerifyInput, options: DeployVerifyBackendOptions = {}): Promise<Record<string, unknown>> {
  if (selectPipelineStageBackend('verify', options.env ?? process.env) !== 'python') {
    throw new Error('Node verify backend is not available yet; set AUTOVPN_STAGE_BACKEND_VERIFY=python to use the Python verification adapter');
  }
  if (options.pythonVerify) {
    return options.pythonVerify(input);
  }
  return runPythonJsonHelper(PYTHON_VERIFY_HELPER, input, options, 'verify');
}

export function isVerifySuccess(verification: Record<string, unknown>): boolean {
  const pagesDomainOk = verification.pages_domain_ok === undefined ? true : Boolean(verification.pages_domain_ok);
  if (!(pagesDomainOk && verification.secret_ok && verification.subscription_ok)) {
    return false;
  }
  if (verification.custom_domain_ok && verification.custom_domain_subscription_ok === false) {
    return false;
  }
  if (verification.custom_domain_ok && verification.custom_domain_dns_ok === false) {
    return false;
  }
  return true;
}
