import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { mergeProjectEnv } from '../runtime/env.js';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;
type DeployLike = Record<string, unknown>;

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

export interface CloudflareCredentials {
  auth_mode: 'api_token' | 'global_key';
  api_token: string;
  account_id: string;
  email: string;
  global_api_key: string;
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

const PAGES_PRODUCTION_BRANCH = 'main';
const FALLBACK_SUFFIX_PATTERN = /^(?<prefix>.+)-(?<suffix>\d+)$/;

function clean(value: unknown): string {
  return value ? String(value).trim() : '';
}

function nonNegativeInt(value: unknown): number {
  const normalized = clean(value);
  if (!/^[+-]?\d+$/.test(normalized)) {
    return 0;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function getString(source: DeployLike, key: string): string {
  return clean(source[key]);
}

export function buildPagesDeployCommand(bundleDir: string, projectName: string): string[] {
  return ['npx', 'wrangler', 'pages', 'deploy', bundleDir, '--project-name', projectName, '--branch', PAGES_PRODUCTION_BRANCH];
}

export function derivePagesProjectUrl(projectName: string): string {
  return `https://${projectName}.pages.dev`;
}

export function buildSecretUrl(deploy: DeployLike): string {
  return `${getString(deploy, 'pages_project_url').replace(/\/+$/g, '')}/?${getString(deploy, 'secret_query')}`;
}

export function buildPagesProjectRootUrl(deploy: DeployLike): string {
  return getString(deploy, 'pages_project_url').replace(/\/+$/g, '');
}

export function buildCustomDomainRootUrl(deploy: DeployLike): string {
  const customDomain = getString(deploy, 'custom_domain').replace(/\/+$/g, '');
  return customDomain ? `https://${customDomain}` : '';
}

export function rewriteUrlHost(url: string, hostname: string): string {
  try {
    const parsed = new URL(clean(url));
    if (!parsed.protocol || !parsed.host) {
      return '';
    }
    parsed.host = hostname;
    return parsed.toString();
  } catch {
    return '';
  }
}

export function buildCustomDomainSubscriptionUrl(deploy: DeployLike): string {
  const customDomain = getString(deploy, 'custom_domain').replace(/\/+$/g, '');
  if (!customDomain) {
    return '';
  }
  const verifyUrl = getString(deploy, 'verify_subscription_url');
  if (verifyUrl) {
    return rewriteUrlHost(verifyUrl, customDomain) || verifyUrl;
  }
  const subscriptionUrl = getString(deploy, 'subscription_url');
  return subscriptionUrl ? rewriteUrlHost(subscriptionUrl, customDomain) : '';
}

function pagesHostnameFromUrl(url: string): string {
  try {
    return new URL(clean(url)).host.trim();
  } catch {
    return '';
  }
}

export function deriveCustomDomainDnsTarget(deploy: DeployLike): string {
  return pagesHostnameFromUrl(buildPagesProjectRootUrl(deploy));
}

function splitProjectSuffix(projectName: string, expectedPrefix = ''): { prefix: string; suffix: number } {
  const normalized = clean(projectName);
  if (!normalized) {
    return { prefix: '', suffix: 0 };
  }
  const match = FALLBACK_SUFFIX_PATTERN.exec(normalized);
  if (!match?.groups) {
    return { prefix: normalized, suffix: 0 };
  }
  const prefix = match.groups.prefix;
  const suffix = Number.parseInt(match.groups.suffix, 10);
  if (expectedPrefix && prefix !== expectedPrefix) {
    return { prefix: normalized, suffix: 0 };
  }
  return { prefix, suffix };
}

export function deriveFallbackProjectBaseName(configuredPrefix: string, currentProjectName: string): string {
  const explicit = clean(configuredPrefix);
  if (explicit) {
    return explicit;
  }
  const { prefix, suffix } = splitProjectSuffix(currentProjectName);
  return prefix && suffix > 0 ? prefix : clean(currentProjectName);
}

export function generateFallbackProjectName(
  baseName: string,
  existingNames: Iterable<string>,
  options: { currentProjectName?: string; lastUsedSuffix?: number } = {}
): { projectName: string; suffix: number } {
  const normalized = clean(baseName);
  if (!normalized) {
    throw new Error('Fallback project base name is empty');
  }
  const existing = new Set(existingNames);
  const current = splitProjectSuffix(options.currentProjectName ?? '', normalized);
  const currentSuffix = current.prefix === normalized ? current.suffix : 0;
  let maxExistingSuffix = 0;
  for (const existingName of existing) {
    const existing = splitProjectSuffix(existingName, normalized);
    if (existing.prefix === normalized) {
      maxExistingSuffix = Math.max(maxExistingSuffix, existing.suffix);
    }
  }
  let nextSuffix = Math.max(currentSuffix, maxExistingSuffix, nonNegativeInt(options.lastUsedSuffix)) + 1;
  while (true) {
    const width = Math.max(2, String(nextSuffix).length);
    const candidate = `${normalized}-${String(nextSuffix).padStart(width, '0')}`;
    if (!existing.has(candidate)) {
      return { projectName: candidate, suffix: nextSuffix };
    }
    nextSuffix += 1;
  }
}

export function resolveLatestExistingProjectName(baseName: string, existingNames: Iterable<string>): string {
  const normalized = clean(baseName);
  if (!normalized) {
    return '';
  }
  const existing = new Set(existingNames);
  if (existing.has(normalized)) {
    return normalized;
  }
  let latestName = '';
  let latestSuffix = 0;
  for (const existingName of existing) {
    const suffix = splitProjectSuffix(existingName, normalized);
    if (suffix.prefix === normalized && suffix.suffix > latestSuffix) {
      latestName = existingName;
      latestSuffix = suffix.suffix;
    }
  }
  return latestName;
}

export function resolveCloudflareCredentials(
  deploy: DeployLike,
  runtimeEnv: Record<string, string>,
  options: { explicitApiToken?: string } = {}
): CloudflareCredentials {
  const authMode = getString(deploy, 'cloudflare_auth_mode') || 'api_token';
  const accountId = getString(deploy, 'account_id') || clean(runtimeEnv.CLOUDFLARE_ACCOUNT_ID);
  if (authMode === 'global_key') {
    const email = getString(deploy, 'cloudflare_email') || clean(runtimeEnv.CLOUDFLARE_EMAIL);
    const globalApiKey = getString(deploy, 'cloudflare_global_key') || clean(runtimeEnv.CLOUDFLARE_API_KEY);
    if (!email || !globalApiKey) {
      throw new Error('Cloudflare global key credentials are incomplete');
    }
    return { auth_mode: 'global_key', api_token: '', account_id: accountId, email, global_api_key: globalApiKey };
  }
  const apiToken = getString(deploy, 'cloudflare_api_token') || clean(options.explicitApiToken) || clean(runtimeEnv.CLOUDFLARE_API_TOKEN);
  if (!apiToken) {
    throw new Error('Cloudflare API token is missing');
  }
  return { auth_mode: 'api_token', api_token: apiToken, account_id: accountId, email: '', global_api_key: '' };
}

export function buildWranglerAuthEnv(credentials: CloudflareCredentials): Record<string, string> {
  const env: Record<string, string> = { CI: '1' };
  if (credentials.account_id) {
    env.CLOUDFLARE_ACCOUNT_ID = credentials.account_id;
  }
  if (credentials.auth_mode === 'global_key') {
    env.CLOUDFLARE_API_KEY = credentials.global_api_key;
    env.CLOUDFLARE_EMAIL = credentials.email;
  } else {
    env.CLOUDFLARE_API_TOKEN = credentials.api_token;
  }
  return env;
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
