import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '@iarna/toml';

import { profileSummary } from '../config/profile.js';
import { resolveArtifactsRoot, resolveProfilePath } from '../runtime/paths.js';
import {
  normalizeManagedToolCommandForSpawn,
  resolveManagedNpmTool,
  type ResolveManagedNpmToolOptions,
  type ManagedNpmToolResolution
} from '../runtime/managed-tools.js';

interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details: Record<string, unknown>;
}

interface DoctorOptions {
  resolveManagedNpmTool?: (options: ResolveManagedNpmToolOptions) => Promise<ManagedNpmToolResolution>;
  safeRun?: (command: string[], env: NodeJS.ProcessEnv) => { ok: boolean; message: string };
  platform?: NodeJS.Platform;
}

const JAVASCRIPT_OBFUSCATOR_VERSION = '5.4.3';
const WRANGLER_VERSION = '4.106.0';

function check(name: string, status: DoctorCheck['status'], message: string, details: Record<string, unknown> = {}): DoctorCheck {
  return { name, status, message, details };
}

function pathWritable(targetPath: string): boolean {
  const target = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, '.doctor-write-test');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function commandPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const pathValue = String(env.PATH ?? process.env.PATH ?? '');
  const extensions = platform === 'win32'
    ? String(env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
    : [''];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return '';
}

function firstExistingPath(candidates: string[]): string {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? '';
}

function mihomoInstallCandidates(env: NodeJS.ProcessEnv): string[] {
  const homeDir = String(env.HOME ?? env.USERPROFILE ?? '').trim();
  return [
    homeDir ? path.join(homeDir, 'clashctl', 'bin', 'mihomo') : '',
    '/opt/homebrew/bin/mihomo',
    '/usr/local/bin/mihomo',
    '/usr/bin/mihomo'
  ];
}

function mihomoPath(env: NodeJS.ProcessEnv): string {
  return commandPath('mihomo', env) || firstExistingPath(mihomoInstallCandidates(env));
}

function safeRun(command: string[], env: NodeJS.ProcessEnv): { ok: boolean; message: string } {
  try {
    const { executable, args } = normalizeManagedToolCommandForSpawn(command);
    const result = spawnSync(executable, args, {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 5000
    });
    const output = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] ?? '';
    return { ok: result.status === 0, message: output || `exit ${result.status ?? 1}` };
  } catch (error) {
    const err = error as Error;
    return { ok: false, message: `${err.name}: ${err.message}` };
  }
}

function canBindLocalhost(): boolean {
  const server = net.createServer();
  try {
    server.listen(0, '127.0.0.1');
    server.close();
    return true;
  } catch {
    server.close();
    return false;
  }
}

function checkSpeedTestConfig(profile: Record<string, any>): DoctorCheck {
  const speed = (profile.speed_test ?? {}) as Record<string, any>;
  const invalid: string[] = [];
  if (Number(speed.timeout_seconds ?? 0) < 1) invalid.push('timeout_seconds');
  if (Number(speed.concurrency ?? 0) < 1) invalid.push('concurrency');
  if (Number(speed.min_download_mb_s ?? 0) < 0) invalid.push('min_download_mb_s');
  if (Number(speed.max_download_bytes ?? 0) < 1) invalid.push('max_download_bytes');
  if (!String(speed.probe_url ?? '').trim()) invalid.push('probe_url');
  if (invalid.length) {
    return check('speed_test_config', 'fail', 'Speed test settings are invalid', { invalid_fields: invalid });
  }
  return check('speed_test_config', 'pass', 'Speed test settings are valid', {
    speed_url_count: Array.isArray(speed.urls) ? speed.urls.length : 0,
    has_probe_url: Boolean(String(speed.probe_url ?? '').trim())
  });
}

function loadProfile(profilePath: string): Record<string, any> {
  if (!fs.existsSync(profilePath)) {
    return {};
  }
  return parse(fs.readFileSync(profilePath, 'utf8')) as Record<string, any>;
}

function checkProxyRuntime(env: NodeJS.ProcessEnv): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const mihomo = mihomoPath(env);
  if (!mihomo) {
    checks.push(check('mihomo', 'fail', 'mihomo binary is missing'));
  } else {
    const result = safeRun([mihomo, '-v'], env);
    checks.push(check('mihomo', result.ok ? 'pass' : 'fail', result.ok ? 'mihomo is executable' : 'mihomo version command failed', {
      path: mihomo,
      version: result.message
    }));
  }
  checks.push(check(
    'localhost_port',
    canBindLocalhost() ? 'pass' : 'fail',
    canBindLocalhost() ? 'Localhost port binding works' : 'Localhost port binding failed'
  ));
  const configuredKeys = [
    'VPN_AUTOMATION_UPSTREAM_PROXY',
    'VPN_AUTOMATION_DEPLOY_PROXY',
    'VPN_AUTOMATION_CLOUDFLARE_PROXY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY'
  ].filter((key) => env[key] || process.env[key]);
  checks.push(check('proxy_environment', 'pass', 'Proxy environment inspected', { configured_keys: configuredKeys }));
  return checks;
}

async function checkNodeTools(projectRoot: string, env: NodeJS.ProcessEnv, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const missing = ['node', 'npm'].filter((name) => !commandPath(name, env, options.platform));
  const checks: DoctorCheck[] = [
    check(
      'node_binaries',
      missing.length ? 'fail' : 'pass',
      missing.length ? 'Node.js command line tools are missing' : 'Node.js command line tools are available',
      { missing }
    )
  ];
  const hasPlaywright = [
    path.join(projectRoot, 'node_modules', 'playwright'),
    path.join(projectRoot, 'electron', 'runtime', 'node-vendor', 'node_modules', 'playwright')
  ].some((candidate) => fs.existsSync(candidate));
  checks.push(check(
    'playwright',
    hasPlaywright ? 'pass' : 'warn',
    hasPlaywright ? 'Playwright package is installed' : 'Playwright package was not found; run npx playwright install --with-deps chromium-headless-shell'
  ));
  try {
    const obfuscator = await (options.resolveManagedNpmTool ?? resolveManagedNpmTool)({
      packageName: 'javascript-obfuscator',
      binaryName: 'javascript-obfuscator',
      version: JAVASCRIPT_OBFUSCATOR_VERSION,
      projectRoot,
      installMissing: false
    });
    checks.push(check(
      'javascript_obfuscator',
      'pass',
      'javascript-obfuscator is available',
      { source: obfuscator.source, version: obfuscator.version, path: obfuscator.command }
    ));
  } catch (error) {
    checks.push(check('javascript_obfuscator', 'fail', error instanceof Error ? error.message : String(error)));
  }
  return checks;
}

async function checkCloudflare(summary: Record<string, any>, deploy: boolean, env: NodeJS.ProcessEnv, projectRoot: string, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const deploySummary = summary.deploy ?? {};
  const hasCredentials = deploySummary.cloudflare_api_token === 'set'
    || Boolean((env.CLOUDFLARE_API_TOKEN ?? '').trim())
    || (deploySummary.cloudflare_global_key === 'set' && deploySummary.cloudflare_email === 'set')
    || (Boolean((env.CLOUDFLARE_API_KEY ?? '').trim()) && Boolean((env.CLOUDFLARE_EMAIL ?? '').trim()));
  checks.push(check(
    'cloudflare_credentials',
    hasCredentials ? 'pass' : (deploy ? 'fail' : 'warn'),
    hasCredentials ? 'Cloudflare credentials are configured' : 'Cloudflare credentials are missing',
    { auth_state: hasCredentials ? 'set' : 'missing', deploy_required: deploy }
  ));
  const hasAccount = deploySummary.account_id === 'set' || Boolean((env.CLOUDFLARE_ACCOUNT_ID ?? '').trim());
  checks.push(check(
    'cloudflare_account',
    hasAccount ? 'pass' : (deploy ? 'fail' : 'warn'),
    hasAccount ? 'Cloudflare account ID is configured' : 'Cloudflare account ID is missing',
    { account_state: hasAccount ? 'set' : 'missing', deploy_required: deploy }
  ));
  const pagesProjectUrl = String(deploySummary.pages_project_url ?? '');
  const hasDeployUrl = Boolean(String(deploySummary.project_name ?? '').trim() && URL.canParse(pagesProjectUrl));
  checks.push(check(
    'deploy_urls',
    hasDeployUrl ? 'pass' : (deploy ? 'fail' : 'warn'),
    hasDeployUrl ? 'Deploy URL settings are internally consistent' : 'Deploy URL settings are incomplete',
    { has_project_name: Boolean(String(deploySummary.project_name ?? '').trim()), has_pages_url: URL.canParse(pagesProjectUrl) }
  ));
  try {
    const wrangler = await (options.resolveManagedNpmTool ?? resolveManagedNpmTool)({
      packageName: 'wrangler',
      binaryName: 'wrangler',
      version: WRANGLER_VERSION,
      projectRoot,
      installMissing: false
    });
    const result = (options.safeRun ?? safeRun)([wrangler.command, 'pages', 'deploy', '--help'], env);
    checks.push(check(
      'wrangler',
      result.ok ? 'pass' : (deploy ? 'fail' : 'warn'),
      result.ok ? 'Wrangler Pages deploy command is available' : 'Wrangler Pages deploy command is not available',
      { source: wrangler.source, version: wrangler.version, path: wrangler.command, result: result.message, deploy_required: deploy }
    ));
  } catch (error) {
    checks.push(check(
      'wrangler',
      deploy ? 'fail' : 'warn',
      error instanceof Error ? error.message : String(error),
      { deploy_required: deploy }
    ));
  }
  return checks;
}

export async function runDoctor(
  projectRoot: string,
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: DoctorOptions = {}
): Promise<{ code: number; payload: Record<string, unknown> }> {
  const deploy = argv.includes('--deploy');
  const strict = argv.includes('--strict');
  const profilePath = resolveProfilePath(projectRoot, env);
  const artifactsRoot = resolveArtifactsRoot(projectRoot, env);
  const profile = loadProfile(profilePath);
  const summary = profileSummary(projectRoot, env) as Record<string, any>;
  const sourceValues = Object.values((summary.sources ?? {}) as Record<string, any>);
  const configuredSources = sourceValues.filter((source) => source.enabled && source.url === 'set' && source.key === 'set');
  const nodeToolChecks = await checkNodeTools(projectRoot, env, options);
  const cloudflareChecks = await checkCloudflare(summary, deploy, env, projectRoot, options);
  const checks: DoctorCheck[] = [
    check('node_version', 'pass', `Node ${process.versions.node}`, { required: '>=20' }),
    check('project_root', 'pass', 'Project root resolved', { path: projectRoot }),
    check(
      'profile_path',
      pathWritable(profilePath) ? 'pass' : 'fail',
      pathWritable(profilePath) ? 'Profile is readable and writable' : 'Profile path is not writable',
      { profile_path: profilePath, exists: fs.existsSync(profilePath) }
    ),
    check(
      'artifacts_root',
      pathWritable(artifactsRoot) ? 'pass' : 'fail',
      pathWritable(artifactsRoot) ? 'Artifacts root is writable' : 'Artifacts root is not writable',
      { path: artifactsRoot }
    ),
    check(
      'worker_template',
      fs.existsSync(path.join(projectRoot, 'templates', 'vmess_node.js')) ? 'pass' : 'fail',
      fs.existsSync(path.join(projectRoot, 'templates', 'vmess_node.js')) ? 'Worker template exists' : 'Worker template is missing',
      { path: path.join(projectRoot, 'templates', 'vmess_node.js') }
    ),
    check(
      'share_worker_template',
      fs.existsSync(path.join(projectRoot, 'templates', 'share-worker', 'vpn.js')) ? 'pass' : 'warn',
      fs.existsSync(path.join(projectRoot, 'templates', 'share-worker', 'vpn.js')) ? 'Share worker template exists' : 'Share worker template is missing',
      { path: path.join(projectRoot, 'templates', 'share-worker', 'vpn.js') }
    ),
    configuredSources.length
      ? check('sources', 'pass', 'At least one enabled source is configured', { configured_count: configuredSources.length })
      : check('sources', 'warn', 'No enabled source has both URL and key configured', { configured_count: 0, key_state: 'missing' }),
    checkSpeedTestConfig(profile),
    ...checkProxyRuntime(env),
    ...nodeToolChecks,
    ...cloudflareChecks
  ];
  const hasFailures = checks.some((item) => item.status === 'fail');
  const hasWarnings = checks.some((item) => item.status === 'warn');
  const ok = !hasFailures && !(strict && hasWarnings);
  return { code: ok ? 0 : 1, payload: { ok, deploy, strict, project_root: projectRoot, checks } };
}
