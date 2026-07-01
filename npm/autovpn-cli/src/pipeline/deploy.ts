import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { mergeProjectEnv } from '../runtime/env.js';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;
type DeployLike = Record<string, unknown>;
type RunCommandLike = (
  command: string[],
  options: { cwd: string; env: Record<string, string> }
) => Promise<{ returncode: number; stdout: string; stderr: string }>;

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

export interface CloudflareVerifyClient {
  verifyUrl(url: string, expectedFragment?: string): Promise<boolean>;
  verifySubdomainCname(hostname: string, target: string): Promise<boolean>;
  deletePagesProject(projectName: string): Promise<unknown>;
}

export interface CloudflareDeployClient extends CloudflareVerifyClient {
  listPagesProjects(): Promise<Array<Record<string, unknown>>>;
  getPagesProject(projectName: string): Promise<Record<string, unknown>>;
  createPagesProject(projectName: string): Promise<unknown>;
  updatePagesProject(projectName: string, payload: Record<string, unknown>): Promise<unknown>;
  copyPagesProjectConfig(sourceProjectName: string, targetProjectName: string, runtimeEnv: Record<string, string | undefined>): Promise<unknown>;
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
  cloudflareClient?: CloudflareVerifyClient;
  cloudflareDeployClient?: CloudflareDeployClient;
  fetch?: typeof fetch;
  runCommand?: RunCommandLike;
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
const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const NETWORK_ERROR_MARKERS = [
  'fetch failed',
  'connectivity issue',
  'und_err_socket',
  'other side closed',
  'econnreset',
  'etimedout'
];
const BLOCKED_PAGES_MARKERS = [
  '8000119',
  'your pages project has been blocked',
  'pages project has been blocked',
  'contact abusereply@cloudflare.com'
];
const PAGES_SECRET_ENV_PREFIX = 'VPN_AUTOMATION_PAGES_SECRET_';

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
    return `${parsed.protocol}//${hostname}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '';
  }
}

export function buildCustomDomainSubscriptionUrl(deploy: DeployLike): string {
  const customDomain = getString(deploy, 'custom_domain');
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

export function resolveVerifySubscriptionUrl(deploy: DeployLike): string {
  const verifySubscriptionUrl = getString(deploy, 'verify_subscription_url');
  return verifySubscriptionUrl || getString(deploy, 'subscription_url');
}

export function resolveCustomDomainVerifySubscriptionUrl(deploy: DeployLike): string {
  return buildCustomDomainSubscriptionUrl(deploy).trim();
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
  runtimeEnv: Record<string, string | undefined>,
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

function buildProxyEnv(proxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl
  };
}

function isTransientDeployFailure(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return NETWORK_ERROR_MARKERS.some((marker) => combined.includes(marker));
}

export function isBlockedPagesError(stdout: string, stderr = ''): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return BLOCKED_PAGES_MARKERS.some((marker) => combined.includes(marker));
}

function resolveDeployProxyUrl(env: NodeJS.ProcessEnv): string {
  for (const key of [
    'VPN_AUTOMATION_DEPLOY_PROXY',
    'VPN_AUTOMATION_CLOUDFLARE_PROXY',
    'VPN_AUTOMATION_UPSTREAM_PROXY',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy'
  ]) {
    const value = clean(env[key]);
    if (!value) {
      continue;
    }
    if (['off', 'none', 'false', '0'].includes(value.toLowerCase())) {
      return '';
    }
    return value;
  }
  return '';
}

function resolvePagesSecretValue(secretName: string, runtimeEnv: Record<string, string | undefined>): string {
  const configuredDefault = secretName === 'ADMIN'
    ? clean(runtimeEnv.VPN_AUTOMATION_DEFAULT_PAGES_SECRET_ADMIN) || 'swimmingliu'
    : '';
  for (const key of [`${PAGES_SECRET_ENV_PREFIX}${secretName}`, secretName]) {
    const value = clean(runtimeEnv[key]) || clean(process.env[key]);
    if (value) {
      return value;
    }
  }
  if (configuredDefault) {
    return configuredDefault;
  }
  throw new Error(`Missing Pages secret value for ${secretName}; set ${PAGES_SECRET_ENV_PREFIX}${secretName} or ${secretName}`);
}

function cloneEnvVars(envVars: Record<string, Record<string, unknown>>, runtimeEnv: Record<string, string | undefined>): Record<string, Record<string, unknown>> {
  const cloned: Record<string, Record<string, unknown>> = {};
  for (const [name, payload] of Object.entries(envVars)) {
    const valueType = clean(payload.type) || 'plain_text';
    if (valueType === 'secret_text') {
      cloned[name] = { type: 'secret_text', value: resolvePagesSecretValue(name, runtimeEnv) };
      continue;
    }
    cloned[name] = { type: valueType, value: payload.value ?? '' };
  }
  return cloned;
}

function cloneDeploymentConfig(config: Record<string, unknown>, runtimeEnv: Record<string, string | undefined>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  if (config.env_vars && typeof config.env_vars === 'object') {
    cloned.env_vars = cloneEnvVars(config.env_vars as Record<string, Record<string, unknown>>, runtimeEnv);
  }
  if (config.kv_namespaces) {
    cloned.kv_namespaces = config.kv_namespaces;
  }
  for (const key of [
    'compatibility_date',
    'compatibility_flags',
    'build_image_major_version',
    'usage_model',
    'fail_open',
    'always_use_latest_compatibility_date'
  ]) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      cloned[key] = config[key];
    }
  }
  return cloned;
}

function cloneProjectDeploymentConfigs(projectPayload: Record<string, unknown>, runtimeEnv: Record<string, string | undefined>): Record<string, unknown> {
  const deploymentConfigs = projectPayload.deployment_configs;
  if (!deploymentConfigs || typeof deploymentConfigs !== 'object') {
    return {};
  }
  const cloned: Record<string, unknown> = {};
  for (const [environmentName, config] of Object.entries(deploymentConfigs as Record<string, Record<string, unknown>>)) {
    cloned[environmentName] = cloneDeploymentConfig(config, runtimeEnv);
  }
  return cloned;
}

function runCommandWithSpawn(
  command: string[],
  options: { cwd: string; env: Record<string, string> },
  spawnImpl: SpawnLike = defaultSpawn
): Promise<{ returncode: number; stdout: string; stderr: string }> {
  const [executable, ...args] = command;
  const child = spawnImpl(executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ returncode: exitCode ?? 1, stdout, stderr });
    });
  });
}

async function runPagesDeployAttempts(
  command: string[],
  baseEnv: Record<string, string>,
  proxyUrl: string,
  options: { cwd: string; runCommand: RunCommandLike }
): Promise<{ result: { returncode: number; stdout: string; stderr: string }; attempts: Array<Record<string, unknown>> }> {
  const attempts: Array<{ mode: string; env: Record<string, string> }> = [
    { mode: 'direct', env: baseEnv },
    { mode: 'direct-retry', env: baseEnv }
  ];
  if (proxyUrl) {
    attempts.push({ mode: 'proxy', env: { ...baseEnv, ...buildProxyEnv(proxyUrl) } });
  }

  let result: { returncode: number; stdout: string; stderr: string } | undefined;
  const attemptLog: Array<Record<string, unknown>> = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    result = await options.runCommand(command, { cwd: options.cwd, env: attempt.env });
    attemptLog.push({ mode: attempt.mode, returncode: result.returncode });
    if (result.returncode === 0) {
      break;
    }
    if (!isTransientDeployFailure(result.stdout, result.stderr)) {
      break;
    }
    if (index === attempts.length - 1) {
      break;
    }
  }
  if (!result) {
    throw new Error('Wrangler deploy did not run');
  }
  return { result, attempts: attemptLog };
}

export function mergeDeployVerificationTarget(deploy: DeployLike, deployment: DeployLike): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...deploy };
  for (const key of ['project_name', 'pages_project_url', 'custom_domain']) {
    if (Object.prototype.hasOwnProperty.call(deployment, key)) {
      merged[key] = deployment[key];
    }
  }
  return merged;
}

export function resolveCleanupBlockedProjectCandidates(deploy: DeployLike, deployment: DeployLike): string[] {
  const finalProject = getString(deploy, 'project_name');
  const cleanupCandidates: string[] = [];
  for (const key of ['cleanup_blocked_project', 'share_project_cleanup_blocked_project']) {
    const candidate = getString(deployment, key);
    if (!candidate || candidate === finalProject || cleanupCandidates.includes(candidate)) {
      continue;
    }
    cleanupCandidates.push(candidate);
  }
  return cleanupCandidates;
}

export function buildNoopCleanupBlockedProjectResult(deployment: DeployLike): Record<string, unknown> {
  return {
    cleanup_deleted: false,
    cleanup_errors: deployment.cleanup_errors ?? []
  };
}

function normalizeHostname(value: string): string {
  return clean(value).replace(/\.+$/g, '').toLowerCase();
}

function cloudflareHeaders(credentials: CloudflareCredentials): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credentials.auth_mode === 'global_key') {
    headers['X-Auth-Email'] = credentials.email;
    headers['X-Auth-Key'] = credentials.global_api_key;
    return headers;
  }
  headers.Authorization = `Bearer ${credentials.api_token}`;
  return headers;
}

function responseBodyText(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

export class CloudflareHttpClient implements CloudflareVerifyClient {
  private accountId: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(credentials: CloudflareCredentials, options: { fetch?: typeof fetch } = {}) {
    this.accountId = credentials.account_id;
    this.headers = cloudflareHeaders(credentials);
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async apiRequest(pathname: string, options: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${CLOUDFLARE_API_BASE_URL}${pathname}`, {
      ...options,
      headers: { ...this.headers, ...(options.headers as Record<string, string> | undefined) },
      signal: options.signal ?? AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      const body = await responseBodyText(response);
      throw new Error(`Cloudflare API request failed (${response.status}): ${body || response.statusText}`);
    }
    return response.json();
  }

  private async apiResult(pathname: string, options: RequestInit = {}): Promise<unknown> {
    const payload = await this.apiRequest(pathname, options);
    if (payload && typeof payload === 'object' && 'result' in payload) {
      return (payload as { result: unknown }).result;
    }
    return payload;
  }

  async listAccounts(): Promise<Record<string, unknown>[]> {
    return (await this.apiResult('/accounts')) as Record<string, unknown>[];
  }

  async listPagesProjects(): Promise<Array<Record<string, unknown>>> {
    const accountId = await this.resolveAccountId();
    return (await this.apiResult(`/accounts/${accountId}/pages/projects`)) as Array<Record<string, unknown>>;
  }

  async getPagesProject(projectName: string): Promise<Record<string, unknown>> {
    const accountId = await this.resolveAccountId();
    return (await this.apiResult(`/accounts/${accountId}/pages/projects/${projectName}`)) as Record<string, unknown>;
  }

  async createPagesProject(projectName: string): Promise<unknown> {
    const accountId = await this.resolveAccountId();
    return this.apiResult(`/accounts/${accountId}/pages/projects`, {
      method: 'POST',
      body: JSON.stringify({ name: projectName, production_branch: PAGES_PRODUCTION_BRANCH })
    });
  }

  async updatePagesProject(projectName: string, payload: Record<string, unknown>): Promise<unknown> {
    const accountId = await this.resolveAccountId();
    return this.apiResult(`/accounts/${accountId}/pages/projects/${projectName}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  }

  async copyPagesProjectConfig(sourceProjectName: string, targetProjectName: string, runtimeEnv: Record<string, string | undefined>): Promise<unknown> {
    const sourceProject = await this.getPagesProject(sourceProjectName);
    return this.updatePagesProject(targetProjectName, {
      deployment_configs: cloneProjectDeploymentConfigs(sourceProject, runtimeEnv)
    });
  }

  async resolveAccountId(): Promise<string> {
    if (this.accountId) {
      return this.accountId;
    }
    const accounts = await this.listAccounts();
    if (!accounts.length) {
      throw new Error('No Cloudflare account available for the supplied credentials');
    }
    this.accountId = clean(accounts[0].id);
    return this.accountId;
  }

  async listZones(name = ''): Promise<Record<string, unknown>[]> {
    const params = name ? `?name=${encodeURIComponent(name)}` : '';
    return (await this.apiResult(`/zones${params}`)) as Record<string, unknown>[];
  }

  async resolveZoneForHostname(hostname: string): Promise<Record<string, unknown>> {
    const normalized = normalizeHostname(hostname);
    const labels = normalized.split('.').filter(Boolean);
    const startIndex = labels.length <= 2 ? 0 : 1;
    for (let index = startIndex; index < labels.length - 1; index += 1) {
      const candidate = labels.slice(index).join('.');
      if (!candidate.includes('.')) {
        continue;
      }
      const zones = await this.listZones(candidate);
      for (const zone of zones) {
        if (clean(zone.name).toLowerCase() === candidate) {
          return zone;
        }
      }
    }
    throw new Error(`Cloudflare zone not found for hostname: ${hostname}`);
  }

  async listDnsRecords(zoneId: string, hostname: string): Promise<Record<string, unknown>[]> {
    return (await this.apiResult(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`)) as Record<string, unknown>[];
  }

  async verifySubdomainCname(hostname: string, target: string): Promise<boolean> {
    const normalizedHost = normalizeHostname(hostname);
    const normalizedTarget = normalizeHostname(target);
    const zone = await this.resolveZoneForHostname(normalizedHost);
    const records = await this.listDnsRecords(clean(zone.id), normalizedHost);
    return records.some((record) => (
      clean(record.type).toUpperCase() === 'CNAME'
      && normalizeHostname(clean(record.name)) === normalizedHost
      && normalizeHostname(clean(record.content)) === normalizedTarget
    ));
  }

  async deletePagesProject(projectName: string): Promise<unknown> {
    const accountId = await this.resolveAccountId();
    return this.apiRequest(`/accounts/${accountId}/pages/projects/${projectName}`, { method: 'DELETE' });
  }

  async verifyUrl(url: string, expectedFragment = ''): Promise<boolean> {
    const response = await this.fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      const body = await responseBodyText(response);
      throw new Error(`URL verification failed (${response.status}): ${body || response.statusText}`);
    }
    if (!expectedFragment) {
      return true;
    }
    return (await response.text()).includes(expectedFragment);
  }
}

export async function defaultVerifyDeployment(deploy: DeployLike, client: CloudflareVerifyClient): Promise<Record<string, boolean>> {
  const pagesDomainUrl = buildPagesProjectRootUrl(deploy);
  const pagesDomainOk = pagesDomainUrl ? await client.verifyUrl(pagesDomainUrl) : false;
  const secretOk = await client.verifyUrl(buildSecretUrl(deploy));
  const subscriptionOk = await client.verifyUrl(resolveVerifySubscriptionUrl(deploy));
  const customDomainUrl = buildCustomDomainRootUrl(deploy);
  const customDomainOk = customDomainUrl ? await client.verifyUrl(customDomainUrl) : false;
  const customDomainSubscriptionUrl = resolveCustomDomainVerifySubscriptionUrl(deploy);
  const customDomainSubscriptionOk = customDomainSubscriptionUrl ? await client.verifyUrl(customDomainSubscriptionUrl) : false;
  const customDomainDnsTarget = deriveCustomDomainDnsTarget(deploy);
  const customDomainDnsOk = customDomainUrl && customDomainDnsTarget
    ? await client.verifySubdomainCname(getString(deploy, 'custom_domain'), customDomainDnsTarget)
    : false;
  return {
    pages_domain_ok: pagesDomainOk,
    secret_ok: secretOk,
    subscription_ok: subscriptionOk,
    custom_domain_ok: customDomainOk,
    custom_domain_subscription_ok: customDomainSubscriptionOk,
    custom_domain_dns_ok: customDomainDnsOk
  };
}

export async function cleanupBlockedPagesProjects(
  deploy: DeployLike,
  deployment: DeployLike,
  client: CloudflareVerifyClient
): Promise<Record<string, unknown>> {
  const candidates = resolveCleanupBlockedProjectCandidates(deploy, deployment);
  if (!candidates.length) {
    return buildNoopCleanupBlockedProjectResult(deployment);
  }
  let deletedAny = false;
  const errors: string[] = [];
  for (const blockedProject of candidates) {
    try {
      await client.deletePagesProject(blockedProject);
      deletedAny = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { cleanup_deleted: deletedAny, cleanup_errors: errors };
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
    const cwd = options.cwd ?? process.cwd();
    const env = mergeProjectEnv(cwd, options.env ?? process.env);
    const deploy = input.deploy;
    const projectName = getString(deploy, 'project_name');
    if (!projectName) {
      throw new Error('Cloudflare Pages project name is missing');
    }
    if (getString(deploy, 'custom_domain') || getString(deploy, 'share_project_name')) {
      throw new Error('Node deploy backend does not support custom_domain or share_project_name yet; set AUTOVPN_STAGE_BACKEND_DEPLOY=python');
    }
    const runtimeEnv = {
      ...env,
      VPN_AUTOMATION_DEFAULT_PAGES_SECRET_ADMIN: getString(deploy, 'pages_secret_admin') || 'swimmingliu'
    };
    const credentials = resolveCloudflareCredentials(deploy, runtimeEnv);
    const command = buildPagesDeployCommand(input.bundleDir, projectName);
    const baseEnv = buildWranglerAuthEnv(credentials);
    const runCommand = options.runCommand ?? ((commandToRun, runOptions) => runCommandWithSpawn(commandToRun, runOptions, options.spawn));
    const proxyUrl = resolveDeployProxyUrl(env);
    let activeCommand = command;
    let finalProjectName = projectName;
    let pagesProjectUrl = getString(deploy, 'pages_project_url') || derivePagesProjectUrl(projectName);
    let fallbackUsed = false;
    let cleanupBlockedProject = '';
    let fallbackLastUsedSuffix = nonNegativeInt(deploy.fallback_last_used_suffix);
    const fallbackCandidateNames: string[] = [];
    let { result, attempts } = await runPagesDeployAttempts(command, baseEnv, proxyUrl, {
      cwd: input.bundleDir,
      runCommand
    });
    if (
      result.returncode !== 0
      && Boolean(deploy.auto_create_project_on_blocked ?? true)
      && isBlockedPagesError(result.stdout, result.stderr)
    ) {
      const client = options.cloudflareDeployClient ?? new CloudflareHttpClient(credentials, { fetch: options.fetch });
      const existingNames = new Set((await client.listPagesProjects()).map((project) => clean(project.name)).filter(Boolean));
      const fallbackBaseName = deriveFallbackProjectBaseName(getString(deploy, 'fallback_project_prefix'), projectName);
      const fallback = generateFallbackProjectName(fallbackBaseName, existingNames, {
        currentProjectName: projectName,
        lastUsedSuffix: fallbackLastUsedSuffix
      });
      finalProjectName = fallback.projectName;
      fallbackLastUsedSuffix = fallback.suffix;
      fallbackCandidateNames.push(finalProjectName);
      await client.createPagesProject(finalProjectName);
      await client.copyPagesProjectConfig(projectName, finalProjectName, runtimeEnv);
      activeCommand = buildPagesDeployCommand(input.bundleDir, finalProjectName);
      const fallbackDeploy = await runPagesDeployAttempts(activeCommand, baseEnv, proxyUrl, {
        cwd: input.bundleDir,
        runCommand
      });
      result = fallbackDeploy.result;
      attempts = [
        ...attempts,
        ...fallbackDeploy.attempts.map((attempt) => ({
          ...attempt,
          mode: `fallback-${String(attempt.mode)}`
        }))
      ];
      pagesProjectUrl = derivePagesProjectUrl(finalProjectName);
      fallbackUsed = true;
      cleanupBlockedProject = projectName;
    }
    return {
      command: activeCommand,
      returncode: result.returncode,
      stdout: result.stdout,
      stderr: result.stderr,
      attempts,
      requested_project_name: projectName,
      fallback_candidate_names: fallbackCandidateNames,
      cleanup_blocked_project: cleanupBlockedProject === finalProjectName ? '' : cleanupBlockedProject,
      cleanup_deleted: false,
      cleanup_errors: [],
      project_name: finalProjectName,
      pages_project_url: pagesProjectUrl,
      custom_domain: '',
      custom_domain_dns_name: '',
      custom_domain_dns_target: '',
      custom_domain_dns_proxied: false,
      custom_domain_dns_ok: false,
      fallback_used: fallbackUsed,
      fallback_last_used_suffix: fallbackLastUsedSuffix,
      share_project_requested_name: '',
      share_project_name: '',
      share_project_fallback_used: false,
      share_project_cleanup_blocked_project: '',
      share_project_sub_value: '',
      share_project_sync_ok: true,
      share_project_sync_error: '',
      share_project_fallback_candidate_names: [],
      share_project_fallback_last_used_suffix: nonNegativeInt(deploy.share_project_fallback_last_used_suffix),
      bundle_dir: input.bundleDir,
      worker_entry: path.join(input.bundleDir, '_worker.js'),
      module_manifest_path: path.join(input.bundleDir, 'manifest.json')
    };
  }
  if (options.pythonDeploy) {
    return options.pythonDeploy(input);
  }
  return runPythonJsonHelper(PYTHON_DEPLOY_HELPER, input, options, 'deploy');
}

export async function verifyDeploymentWithBackend(input: VerifyInput, options: DeployVerifyBackendOptions = {}): Promise<Record<string, unknown>> {
  if (selectPipelineStageBackend('verify', options.env ?? process.env) !== 'python') {
    const cwd = options.cwd ?? process.cwd();
    const env = mergeProjectEnv(cwd, options.env ?? process.env);
    const client = options.cloudflareClient ?? new CloudflareHttpClient(resolveCloudflareCredentials(input.deploy, env), { fetch: options.fetch });
    const target = mergeDeployVerificationTarget(input.deploy, input.deployment);
    const verification = await defaultVerifyDeployment(target, client);
    const result: Record<string, unknown> = { ...verification };
    if (isVerifySuccess(verification)) {
      Object.assign(result, await cleanupBlockedPagesProjects(target, input.deployment, client));
    }
    return result;
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
