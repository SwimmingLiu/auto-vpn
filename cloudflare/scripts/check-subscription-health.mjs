#!/usr/bin/env node
/**
 * Keep the subscription served, not merely deployed.
 *
 * A Pages deployment can be green while the service is down. Three failures
 * are invisible to `wrangler pages deploy`:
 *
 *   - the project is blocked by Cloudflare (`code: 8000119`), so every new
 *     deployment is rejected and the old one stops being served;
 *   - the CNAME still points at a project that was deleted, and Cloudflare
 *     answers every request with HTTP 403 `error code: 1014` ("CNAME
 *     Cross-User Banned") while `www` keeps working;
 *   - the hostname is not attached to the project's custom domains (or is
 *     attached and never leaves `pending`), so the project is healthy but the
 *     hostname does not route to it.
 *
 * Health is therefore three facts that must agree: every hostname's CNAME
 * content is `<live project>.pages.dev`, that project exists and is not
 * blocked, and the project lists the hostname as an active custom domain.
 * The root of each hostname is fetched too — that is where 1014 surfaces —
 * and, when HEALTH_SUBSCRIPTION_PROBE is set, so is the real subscription
 * URL. A 200 is not enough: a wrong `token` returns random base64 and the
 * decoy page returns HTML, both of which are `payload_invalid`.
 *
 * With --repair the findings are restored in this order: repoint the CNAME,
 * attach a missing custom domain, and — when the serving project is missing
 * or blocked — rotate to the next free `sub-links-share-NN`, copying env vars
 * and KV bindings from the old project. A worker bundle is redeployed only
 * when HEALTH_DEPLOY_DIR is set; otherwise the rotation is reported as
 * needing a manual deploy and the CNAMEs still move (traffic is down either
 * way, and a half-migration is easier to finish than to start over).
 *
 * Every request goes through one injectable `fetchImpl` and every sleep
 * through one injectable `sleep`, so the tests run without the network and
 * without waiting.
 *
 * 三者相合，方为无恙：指路之符尽指现存未封之驿馆，驿馆录其名而通之，叩门
 * 所得乃真天书而非伪页。馆封则另筑新馆，迁其钥与其器；符误则改指正馆；名
 * 缺则补录之。符节与钥不可示人，唯露其首。
 *
 * Usage:
 *   node cloudflare/scripts/check-subscription-health.mjs [--json] [--repair] [--dry-run]
 *
 * Exit codes: 0 healthy or repaired+verified, 1 findings remain, 2 usage/config.
 */
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_HOSTS = ['swimmingliu.online', 'www.swimmingliu.online'];
const DEFAULT_PROJECT_PREFIX = 'sub-links-share-';
const DEFAULT_VERIFY_ATTEMPTS = 6;
const DEFAULT_VERIFY_DELAY_MS = 10000;
// How many blocked projects in one family this checker will tolerate before it
// stops rotating. The schedule runs every ten minutes; without a ceiling a
// vendor-side block that hits every new project turns the schedule into a
// project factory — dozens per night, each one blocked on arrival, none of them
// serving. At the ceiling the checker stops writing and reports the state as
// needing a human, which is the only thing that can resolve it.
const DEFAULT_MAX_BLOCKED_PROJECTS = 3;
const HTTP_TIMEOUT_MS = 15000;
const API_TIMEOUT_MS = 20000;
const MAX_BASE64_LAYERS = 4;
const LINK_LINE = /^(vmess|vless|ss|trojan):\/\/\S+/i;
const SENSITIVE_PARAM = /(token|secret|key|passw|uuid|auth|serect)/i;
const SECRET_ENV_PREFIX = 'HEALTH_SECRET_';

export const USAGE = `usage: check-subscription-health.mjs [--json] [--repair] [--dry-run]

  --json     print one JSON object {healthy, findings, repairs, observations}
  --repair   repoint CNAMEs, attach custom domains, rotate a blocked project
  --dry-run  plan repairs without sending write requests (implies --repair)

environment:
  CLOUDFLARE_API_TOKEN       required; never printed
  CLOUDFLARE_ACCOUNT_ID      required
  CLOUDFLARE_ZONE_ID         optional; resolved from HEALTH_HOSTS when absent
  HEALTH_HOSTS               comma list (default: ${DEFAULT_HOSTS.join(',')})
  HEALTH_SUBSCRIPTION_PROBE  full subscription URL; the body must decode to links
  HEALTH_PROJECT_PREFIX      default: ${DEFAULT_PROJECT_PREFIX}
  HEALTH_DEPLOY_DIR          worker bundle directory for \`wrangler pages deploy\`
  HEALTH_SECRET_<NAME>       value for a secret_text env var of that name; a
                             rotation cannot read the old one back
  HEALTH_MAX_BLOCKED_PROJECTS default: ${DEFAULT_MAX_BLOCKED_PROJECTS}; stop
                             rotating once this many are blocked
  HEALTH_VERIFY_ATTEMPTS     default: ${DEFAULT_VERIFY_ATTEMPTS}
  HEALTH_VERIFY_DELAY_MS     default: ${DEFAULT_VERIFY_DELAY_MS}`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

class ApiError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const clean = (value) => (value === undefined || value === null ? '' : String(value).trim());
const normalizeHost = (value) => clean(value).toLowerCase().replace(/\.$/, '');
const normalizeTarget = (value) => clean(value).toLowerCase().replace(/\.$/, '');

// ---------------------------------------------------------------------------
// Redaction. A token that reaches stdout reaches the workflow log, and a public
// repository's actions logs are readable without authentication. Everything
// that leaves this process is scrubbed against the values read from the
// environment, so a detail string that accidentally embeds one still cannot
// print it.
//
// 符节与钥一出此境即入日志，唯露其首四字，余人不可复用。
// ---------------------------------------------------------------------------

/**
 * Keep a recognisable prefix so two runs can be told apart; never the value.
 * A short secret is not prefixed at all: four characters of a six-character
 * key is most of the key.
 */
export function redactValue(value) {
  const text = clean(value);
  if (!text) return '';
  if (text.length < 12) return '...';
  return `${text.slice(0, 4)}...`;
}

/** Redact the sensitive query parameters and any userinfo in a URL. */
export function redactUrl(raw) {
  let url;
  try {
    url = new URL(clean(raw));
  } catch {
    return '<invalid-url>';
  }
  if (url.username) url.username = redactValue(url.username);
  if (url.password) url.password = redactValue(url.password);
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(key)) {
      url.searchParams.set(key, redactValue(url.searchParams.get(key)));
    }
  }
  return url.toString();
}

/** Deep-copy a report with every known secret replaced by its prefix. */
export function scrubSecrets(value, secrets) {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) {
      if (!secret || secret.length < 8) continue;
      if (out.includes(secret)) out = out.split(secret).join(redactValue(secret));
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubSecrets(item, secrets);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Arguments, environment and payload decoding.
// ---------------------------------------------------------------------------

export function parseArgs(argv = []) {
  const args = { json: false, repair: false, dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--repair') args.repair = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  // `--dry-run` alone is the useful form: show the repairs that --repair would
  // make without sending any of them.
  if (args.dryRun) args.repair = true;
  return args;
}

function readInteger(raw, fallback, name, minimum) {
  const text = clean(raw);
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) throw new UsageError(`${name} must be a non-negative integer`);
  const value = Number(text);
  if (value < minimum) throw new UsageError(`${name} must be at least ${minimum}`);
  return value;
}

export function readConfig(env = process.env) {
  const token = clean(env.CLOUDFLARE_API_TOKEN);
  const accountId = clean(env.CLOUDFLARE_ACCOUNT_ID);
  if (!token) throw new UsageError('CLOUDFLARE_API_TOKEN must be set');
  if (!accountId) throw new UsageError('CLOUDFLARE_ACCOUNT_ID must be set');

  const hostsRaw = clean(env.HEALTH_HOSTS) || DEFAULT_HOSTS.join(',');
  const hosts = [...new Set(hostsRaw.split(',').map(normalizeHost).filter(Boolean))];
  if (!hosts.length) throw new UsageError('HEALTH_HOSTS must contain at least one hostname');
  for (const host of hosts) {
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) {
      throw new UsageError(`HEALTH_HOSTS contains an invalid hostname: ${host}`);
    }
  }

  const probeRaw = clean(env.HEALTH_SUBSCRIPTION_PROBE);
  let probeUrl = '';
  if (probeRaw) {
    let parsed;
    try {
      parsed = new URL(probeRaw);
    } catch {
      throw new UsageError('HEALTH_SUBSCRIPTION_PROBE must be an absolute http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UsageError('HEALTH_SUBSCRIPTION_PROBE must be an absolute http(s) URL');
    }
    probeUrl = parsed.toString();
  }

  const secrets = [token, probeRaw, probeUrl].filter(Boolean);
  if (probeUrl) {
    for (const [key, value] of new URL(probeUrl).searchParams) {
      if (value && SENSITIVE_PARAM.test(key)) secrets.push(value);
    }
  }

  // `secret_text` env vars are write-only: the API returns the name and type
  // but never the value. A rotation that copies the config therefore blanks
  // every secret on the new project, and the share Worker's `ADMIN` is one of
  // them. `HEALTH_SECRET_<NAME>` supplies a replacement value at rotation
  // time; whatever is missing is reported by name, never silently dropped.
  //
  // 秘符只入不出，迁馆则必以 `HEALTH_SECRET_<名>` 补之；缺者记名以告。
  const envSecrets = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(SECRET_ENV_PREFIX)) continue;
    const name = key.slice(SECRET_ENV_PREFIX.length);
    if (!name) continue;
    const text = clean(value);
    if (!text) continue;
    envSecrets[name] = text;
    secrets.push(text);
  }

  return {
    token,
    accountId,
    zoneId: clean(env.CLOUDFLARE_ZONE_ID),
    hosts,
    probeUrl,
    projectPrefix: clean(env.HEALTH_PROJECT_PREFIX) || DEFAULT_PROJECT_PREFIX,
    deployDir: clean(env.HEALTH_DEPLOY_DIR),
    envSecrets,
    maxBlockedProjects: readInteger(env.HEALTH_MAX_BLOCKED_PROJECTS, DEFAULT_MAX_BLOCKED_PROJECTS, 'HEALTH_MAX_BLOCKED_PROJECTS', 1),
    verifyAttempts: readInteger(env.HEALTH_VERIFY_ATTEMPTS, DEFAULT_VERIFY_ATTEMPTS, 'HEALTH_VERIFY_ATTEMPTS', 1),
    verifyDelayMs: readInteger(env.HEALTH_VERIFY_DELAY_MS, DEFAULT_VERIFY_DELAY_MS, 'HEALTH_VERIFY_DELAY_MS', 0),
    secrets
  };
}

export function looksLikeHtml(text) {
  const head = clean(text).slice(0, 400).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head') || head.includes('<body');
}

/** Cloudflare answers 1014 with an HTML body for a CNAME it refuses to follow. */
export function detect1014(text) {
  const body = String(text ?? '');
  return /error\s*code:\s*1014/i.test(body) || /CNAME Cross-User Banned/i.test(body);
}

/** A Pages block page carries 8000119; a rejected deploy says the same. */
export function detectBlocked(text) {
  const body = String(text ?? '');
  return /8000119/.test(body) || /pages project has been blocked/i.test(body);
}

/**
 * Peel up to four base64 layers and return the first non-empty link list.
 * A wrong `token` produces base64 of random bytes, which decodes to
 * replacement characters and stops here; the decoy page is HTML and stops
 * before any decode.
 *
 * 天书至多四层；符节误则所得皆乱码，伪页则先见其形而不解，二者俱非真驿。
 */
export function decodeSubscription(text) {
  let current = clean(text);
  for (let layers = 0; layers <= MAX_BASE64_LAYERS; layers += 1) {
    if (!current) return { links: [], layers };
    if (looksLikeHtml(current)) return { links: [], layers };
    const links = current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => LINK_LINE.test(line));
    if (links.length) return { links, layers };
    if (layers === MAX_BASE64_LAYERS) break;
    const compact = current.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) return { links: [], layers };
    const standard = compact.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
    let decoded = '';
    try {
      decoded = Buffer.from(padded, 'base64').toString('utf8');
    } catch {
      return { links: [], layers };
    }
    if (!decoded || decoded === current || decoded.includes('�')) return { links: [], layers };
    current = decoded.trim();
  }
  return { links: [], layers: MAX_BASE64_LAYERS };
}

function projectFromPagesDev(content) {
  const match = /^([a-z0-9-]+)\.pages\.dev$/i.exec(normalizeTarget(content));
  return match ? match[1] : '';
}

function projectSuffix(name, prefix) {
  if (!name.startsWith(prefix)) return 0;
  const rest = name.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : 0;
}

export function nextProjectName(prefix, existingNames) {
  let max = 0;
  for (const name of existingNames) {
    max = Math.max(max, projectSuffix(clean(name), prefix));
  }
  const next = max + 1;
  return `${prefix}${String(next).padStart(Math.max(2, String(next).length), '0')}`;
}

function hostSuffixes(host) {
  const labels = host.split('.').filter(Boolean);
  const out = [];
  for (let index = 0; index <= labels.length - 2; index += 1) out.push(labels.slice(index).join('.'));
  return out;
}

function commonSuffix(hosts) {
  const lists = hosts.map((host) => host.split('.').reverse());
  const labels = [];
  for (let index = 0; index < lists[0].length; index += 1) {
    const label = lists[0][index];
    if (lists.every((list) => list[index] === label)) labels.push(label);
    else break;
  }
  return labels.reverse().join('.');
}

function candidateZoneNames(hosts) {
  const names = [commonSuffix(hosts), ...hosts.flatMap(hostSuffixes)].filter(Boolean);
  return [...new Set(names)];
}

function firstApiError(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const first = errors.find((error) => error && error.message);
  return first ? clean(first.message) : '';
}

function summarizeDeploymentConfigs(configs) {
  const environments = Object.keys(configs ?? {});
  const envVars = new Set();
  const kvNamespaces = new Set();
  for (const environment of Object.values(configs ?? {})) {
    for (const name of Object.keys(environment?.env_vars ?? {})) envVars.add(name);
    for (const binding of environment?.kv_namespaces ?? []) {
      if (binding?.binding) kvNamespaces.add(clean(binding.binding));
    }
  }
  return {
    environments,
    envVars: [...envVars].sort(),
    kvNamespaces: [...kvNamespaces].sort()
  };
}

function errorDetail(payload, text) {
  return firstApiError(payload) || clean(text).slice(0, 160);
}

// ---------------------------------------------------------------------------
// Cloudflare API. HTTP status is returned to the caller; only credential and
// permission failures throw, because those are configuration errors (exit 2)
// rather than findings. A blocked-project response is not a credential error.
// ---------------------------------------------------------------------------

class CloudflareApi {
  constructor({ token, fetchImpl, isDryRun }) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.isDryRun = isDryRun;
  }

  async call(method, path, body) {
    const upper = method.toUpperCase();
    if (upper !== 'GET' && this.isDryRun()) {
      return { dryRun: true, ok: true, status: 0, payload: { success: true, result: null }, text: '' };
    }
    let response;
    let text = '';
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method: upper,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
      text = await response.text().catch(() => '');
    } catch (error) {
      throw new ApiError(`cloudflare api ${upper} ${path} failed: ${error?.message ?? String(error)}`);
    }
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if ((response.status === 401 || response.status === 403) && !detectBlocked(text)) {
      const detail = firstApiError(payload) || response.statusText || 'no detail';
      throw new UsageError(`cloudflare api rejected the credentials (${response.status}): ${detail}`);
    }
    return { dryRun: false, ok: response.ok, status: response.status, payload, text };
  }

  /**
   * Pages endpoints reject `per_page` with a 400, so pagination here is the
   * page number alone, bounded by the `total_pages` the response reports.
   *
   * 扫馆不施 per_page，只循页次，以响应所报之总页为度。
   */
  async list(path) {
    const items = [];
    for (let page = 1; page <= 50; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await this.call('GET', `${path}${separator}page=${page}`);
      if (!response.ok) {
        throw new ApiError(
          `cloudflare api GET ${path} answered ${response.status}: ${errorDetail(response.payload, response.text)}`,
          { status: response.status, body: response.text }
        );
      }
      const result = Array.isArray(response.payload?.result) ? response.payload.result : [];
      items.push(...result);
      const totalPages = Number(response.payload?.result_info?.total_pages ?? 1);
      if (!Number.isFinite(totalPages) || page >= totalPages) break;
      if (result.length === 0) break;
    }
    return items;
  }
}

async function defaultRunDeploy({ dir, project }) {
  const executable = clean(process.env.WRANGLER_BIN) || 'npx';
  const prefix = clean(process.env.WRANGLER_BIN) ? [] : ['--yes', 'wrangler'];
  const args = [...prefix, 'pages', 'deploy', dir, '--project-name', project, '--branch', 'main'];
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      env: process.env,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error?.code === 'number' ? error.code : 1, stdout: error?.stdout ?? '', stderr: error?.stderr ?? error?.message ?? '' };
  }
}

// ---------------------------------------------------------------------------
// Observation.
// ---------------------------------------------------------------------------

class HealthMonitor {
  constructor(config, deps = {}) {
    this.config = config;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.runDeploy = deps.runDeploy ?? defaultRunDeploy;
    this.dryRun = false;
    this.zone = null;
    this.api = new CloudflareApi({
      token: config.token,
      fetchImpl: this.fetchImpl,
      isDryRun: () => this.dryRun
    });
  }

  async httpGet(url) {
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: '*/*' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      const body = await response.text().catch(() => '');
      return {
        status: response.status,
        cfRay: clean(response.headers?.get?.('cf-ray')),
        contentType: clean(response.headers?.get?.('content-type')),
        body,
        error: null
      };
    } catch (error) {
      return { status: 0, cfRay: '', contentType: '', body: '', error: error?.message ?? String(error) };
    }
  }

  async ensureZone() {
    if (this.zone) return this.zone;
    const { zoneId, hosts } = this.config;
    if (zoneId) {
      this.zone = { id: zoneId, name: commonSuffix(hosts) };
      return this.zone;
    }
    for (const candidate of candidateZoneNames(hosts)) {
      const response = await this.api.call('GET', `/zones?name=${encodeURIComponent(candidate)}`);
      if (!response.ok) {
        throw new ApiError(
          `cloudflare api GET /zones answered ${response.status}: ${errorDetail(response.payload, response.text)}`,
          { status: response.status, body: response.text }
        );
      }
      const zones = Array.isArray(response.payload?.result) ? response.payload.result : [];
      const zone = zones.find((item) => normalizeHost(item?.name) === candidate);
      if (zone?.id) {
        this.zone = { id: clean(zone.id), name: normalizeHost(zone.name) };
        return this.zone;
      }
    }
    throw new UsageError(`could not resolve a Cloudflare zone for ${hosts.join(',')}; set CLOUDFLARE_ZONE_ID`);
  }

  async probeProject(name) {
    const response = await this.httpGet(`https://${name}.pages.dev/`);
    const blocked = detectBlocked(response.body);
    return {
      blocked,
      blockedEvidence: blocked ? 'pages.dev answered the project-blocked page (8000119)' : '',
      pagesDevStatus: response.status
    };
  }

  async observe() {
    const zone = await this.ensureZone();
    const [projectRows, dnsRows] = await Promise.all([
      this.api.list(`/accounts/${this.config.accountId}/pages/projects`),
      this.api.list(`/zones/${zone.id}/dns_records?type=CNAME`)
    ]);

    const projects = projectRows
      .map((row) => ({ name: clean(row?.name), suffix: projectSuffix(clean(row?.name), this.config.projectPrefix) }))
      .filter((project) => project.name && project.name.startsWith(this.config.projectPrefix));

    await Promise.all(projects.map(async (project) => {
      const probe = await this.probeProject(project.name);
      project.blocked = probe.blocked;
      project.blockedEvidence = probe.blockedEvidence;
      project.pagesDevStatus = probe.pagesDevStatus;
      project.domains = null;
      project.error = '';
    }));

    const dns = this.config.hosts.map((host) => ({
      host,
      records: dnsRows
        .filter((row) => normalizeHost(row?.name) === host)
        .map((row) => ({
          id: clean(row?.id),
          type: clean(row?.type).toUpperCase(),
          content: clean(row?.content),
          proxied: Boolean(row?.proxied)
        }))
    }));

    let servingProject = this.pickServingProject(projects, dns);
    let domains = [];
    while (servingProject) {
      try {
        domains = (await this.api.list(`/accounts/${this.config.accountId}/pages/projects/${servingProject}/domains`))
          .map((row) => ({ name: normalizeHost(row?.name), status: clean(row?.status).toLowerCase() }))
          .filter((domain) => domain.name);
        break;
      } catch (error) {
        const project = projects.find((item) => item.name === servingProject);
        if (error instanceof ApiError && detectBlocked(error.body) && project) {
          project.blocked = true;
          project.blockedEvidence = 'the domains API answered the project-blocked error (8000119)';
          servingProject = this.pickServingProject(projects, dns);
          continue;
        }
        throw error;
      }
    }
    if (servingProject) {
      const project = projects.find((item) => item.name === servingProject);
      if (project) project.domains = domains;
    }

    const [hosts, probe] = await Promise.all([
      Promise.all(this.config.hosts.map(async (host) => {
        const response = await this.httpGet(`https://${host}/`);
        return {
          host,
          status: response.status,
          cfRay: response.cfRay,
          error1014: detect1014(response.body),
          decoy: looksLikeHtml(response.body),
          contentType: response.contentType,
          error: response.error
        };
      })),
      this.observeProbe()
    ]);

    return {
      checkedAt: new Date().toISOString(),
      zone,
      hosts,
      dns,
      projects,
      projectNames: projectRows.map((row) => clean(row?.name)).filter(Boolean),
      servingProject,
      probe
    };
  }

  async observeProbe() {
    if (!this.config.probeUrl) return null;
    const response = await this.httpGet(this.config.probeUrl);
    const decoded = response.error ? { links: [], layers: 0 } : decodeSubscription(response.body);
    return {
      configured: true,
      url: redactUrl(this.config.probeUrl),
      host: normalizeHost(new URL(this.config.probeUrl).hostname),
      status: response.status,
      cfRay: response.cfRay,
      error1014: detect1014(response.body),
      decoy: looksLikeHtml(response.body),
      linkCount: decoded.links.length,
      layers: decoded.layers,
      bytes: response.body.length,
      error: response.error
    };
  }

  /**
   * The serving project is the one the hostnames already agree on, falling
   * back to the highest suffix. A blocked project never serves.
   */
  pickServingProject(projects, dns) {
    const candidates = projects.filter((project) => !project.blocked);
    if (!candidates.length) return '';
    let best = null;
    for (const project of candidates) {
      const cnameHits = dns.filter((entry) => entry.records.some(
        (record) => record.type === 'CNAME' && projectFromPagesDev(record.content) === project.name
      )).length;
      const score = cnameHits * 1000 + project.suffix;
      if (!best || score > best.score) best = { name: project.name, score };
    }
    return best.name;
  }

  // -------------------------------------------------------------------------
  // 修缮。
  //
  // 先改指路之符，再补驿馆所录之名；馆封或已废，则另筑新馆，迁其钥、其器、
  // 其所录之名，然后移符。未设 HEALTH_DEPLOY_DIR 者，但移其符，别记「须人
  // 筑驿」一条：符不动则客终不至，先移之，续工易毕。
  // -------------------------------------------------------------------------

  async attachDomain(project, host, repairs) {
    const response = await this.api.call(
      'POST',
      `/accounts/${this.config.accountId}/pages/projects/${project}/domains`,
      { name: host }
    );
    const already = response.ok || /already exists|already associated|already been taken|has already/i.test(response.text);
    repairs.push({
      action: 'custom_domain_attach',
      host,
      project,
      status: this.dryRun ? 'planned' : response.ok ? 'done' : already ? 'done' : 'failed',
      detail: response.ok ? '' : already ? 'already present' : errorDetail(response.payload, response.text),
      call: { method: 'POST', path: `/accounts/${this.config.accountId}/pages/projects/${project}/domains`, body: { name: host } }
    });
    return already;
  }

  async detachDomain(project, host, repairs) {
    const path = `/accounts/${this.config.accountId}/pages/projects/${project}/domains/${encodeURIComponent(host)}`;
    const response = await this.api.call('DELETE', path);
    repairs.push({
      action: 'custom_domain_detach',
      host,
      project,
      status: this.dryRun ? 'planned' : response.ok ? 'done' : 'failed',
      detail: response.ok ? '' : errorDetail(response.payload, response.text),
      call: { method: 'DELETE', path }
    });
  }

  async repointCname(host, project, observations, repairs) {
    const entry = observations.dns.find((item) => item.host === host);
    const cname = entry?.records.find((record) => record.type === 'CNAME');
    const zone = observations.zone;
    // The record's own proxied flag is preserved; a new record defaults to the
    // zone's apex being proxied and every other hostname being DNS-only, which
    // is how the two hosts are provisioned today.
    const proxied = cname ? cname.proxied : host === zone.name;
    const target = `${project}.pages.dev`;
    const body = { type: 'CNAME', name: host, content: target, proxied, ttl: 1 };
    if (cname) {
      const path = `/zones/${zone.id}/dns_records/${cname.id}`;
      const response = await this.api.call('PATCH', path, body);
      repairs.push({
        action: 'dns_repoint',
        host,
        project,
        from: cname.content,
        to: target,
        status: this.dryRun ? 'planned' : response.ok ? 'done' : 'failed',
        detail: response.ok ? '' : errorDetail(response.payload, response.text),
        call: { method: 'PATCH', path, body }
      });
      return;
    }
    const path = `/zones/${zone.id}/dns_records`;
    const response = await this.api.call('POST', path, body);
    repairs.push({
      action: 'dns_create',
      host,
      project,
      to: target,
      status: this.dryRun ? 'planned' : response.ok ? 'done' : 'failed',
      detail: response.ok ? '' : errorDetail(response.payload, response.text),
      call: { method: 'POST', path, body }
    });
  }

  async rotate(observations, repairs) {
    const prefix = this.config.projectPrefix;
    const existing = observations.projects.map((project) => project.name);
    // The cap is also enforced here, not only in `diagnose`: `repairAll` decides
    // from the findings, and a caller that reaches this method some other way
    // must not mint an unbounded series of projects either.
    const blockedCount = observations.projects.filter((project) => project.blocked).length;
    if (blockedCount >= this.config.maxBlockedProjects) {
      repairs.push({
        action: 'rotation_refused',
        status: 'manual',
        detail: `${blockedCount} projects in the ${prefix}NN family are already blocked (cap ${this.config.maxBlockedProjects}); a further rotation would only add another blocked name — a human must decide`
      });
      return '';
    }
    const next = nextProjectName(prefix, existing);

    // The old project's config must be read before anything new exists. The
    // CNAME target is the project that was actually serving; a blocked one
    // still exists and still holds the env vars the new project needs. Never
    // fall back to an un-prefixed sibling (sub-nodes-NN): its config describes
    // a different worker.
    const cnameTargets = observations.dns
      .map((entry) => projectFromPagesDev(entry.records.find((record) => record.type === 'CNAME')?.content ?? ''))
      .filter(Boolean);
    const source = cnameTargets.find((name) => existing.includes(name))
      || observations.servingProject
      || [...observations.projects].filter((project) => project.name.startsWith(prefix)).sort((a, b) => b.suffix - a.suffix)[0]?.name
      || '';
    let sourceConfigs = null;
    // 秘符只写不读：API 还其名而不还其值，照抄则新馆之秘尽空。
    const unfilledSecrets = new Set();
    if (source && source !== next) {
      const sourcePath = `/accounts/${this.config.accountId}/pages/projects/${source}`;
      const sourceResponse = await this.api.call('GET', sourcePath);
      const configs = sourceResponse.payload?.result?.deployment_configs;
      if (sourceResponse.ok && configs) {
        sourceConfigs = configs;
        // `secret_text` 的值不可读回，照抄即清空。凡环境中有 `HEALTH_SECRET_<名>`
        // 者补之；无者记其名，明告须人重设，不作无声之失。
        for (const environment of Object.values(sourceConfigs)) {
          const envVars = environment?.env_vars ?? {};
          for (const [name, binding] of Object.entries(envVars)) {
            if (binding?.type !== 'secret_text' || clean(binding.value)) continue;
            const replacement = clean(this.config.envSecrets[name]);
            if (replacement) {
              envVars[name] = { type: 'secret_text', value: replacement };
            } else {
              unfilledSecrets.add(name);
            }
          }
        }
      } else {
        repairs.push({
          action: 'config_copy',
          project: next,
          source,
          status: 'failed',
          detail: sourceResponse.ok ? 'the source project returned no deployment_configs' : `GET ${sourcePath} answered ${sourceResponse.status}`
        });
      }
    }

    const createPath = `/accounts/${this.config.accountId}/pages/projects`;
    const created = await this.api.call('POST', createPath, { name: next, production_branch: 'main' });
    const exists = created.ok || /already exists|8000007/i.test(created.text);
    repairs.push({
      action: 'project_create',
      project: next,
      status: this.dryRun ? 'planned' : created.ok ? 'done' : exists ? 'done' : 'failed',
      detail: created.ok ? '' : exists ? 'already exists' : errorDetail(created.payload, created.text),
      call: { method: 'POST', path: createPath, body: { name: next, production_branch: 'main' } }
    });
    if (!exists && !this.dryRun) return '';

    if (source && source !== next && (this.dryRun || sourceConfigs)) {
      // Only a summary is recorded: the request body carries secret_text
      // values, and this object is printed.
      const summary = this.dryRun
        ? { environments: ['<read from ' + source + ' at run time>'], envVars: [], kvNamespaces: [] }
        : summarizeDeploymentConfigs(sourceConfigs);
      const targetPath = `/accounts/${this.config.accountId}/pages/projects/${next}`;
      const response = await this.api.call('PATCH', targetPath, sourceConfigs ? { deployment_configs: sourceConfigs } : {});
      repairs.push({
        action: 'config_copy',
        project: next,
        source,
        status: this.dryRun ? 'planned' : response.ok ? 'done' : 'failed',
        detail: response.ok ? '' : errorDetail(response.payload, response.text),
        config: summary,
        call: { method: 'PATCH', path: targetPath, body: { deployment_configs: '<copied from source; not printed>' } }
      });
    }

    // A secret that could not be filled is a real, actionable state: the new
    // project serves, but the share Worker's `ADMIN` login cannot work until a
    // human sets it. Reporting it as `manual` keeps it visible in the run
    // summary instead of leaving the next symptom unexplained.
    if (unfilledSecrets.size > 0) {
      repairs.push({
        action: 'secret_reset_required',
        project: next,
        status: 'manual',
        detail: `set ${[...unfilledSecrets].sort().join(', ')} on ${next} (HEALTH_SECRET_<NAME> supplies it automatically)`
      });
    }

    if (this.config.deployDir) {
      // --dry-run must not shell out to a real deploy, even to "see" it.
      const command = [process.env.WRANGLER_BIN || 'npx', ...(process.env.WRANGLER_BIN ? [] : ['--yes', 'wrangler']), 'pages', 'deploy', this.config.deployDir, '--project-name', next, '--branch', 'main'];
      if (this.dryRun) {
        repairs.push({ action: 'worker_deploy', project: next, status: 'planned', detail: '', command });
      } else {
        const result = await this.runDeploy({ dir: this.config.deployDir, project: next });
        repairs.push({
          action: 'worker_deploy',
          project: next,
          status: result.code === 0 ? 'done' : 'failed',
          detail: result.code === 0 ? '' : `wrangler exited ${result.code}`,
          command
        });
      }
    } else {
      repairs.push({
        action: 'manual_redeploy_required',
        project: next,
        status: 'manual',
        detail: `HEALTH_DEPLOY_DIR is unset; deploy the share-worker bundle to ${next} before clients are expected to recover`
      });
    }

    // A project can be blocked within minutes of its first deploy — that is
    // what happened to `sub-links-share-23` on 2026-11-24. Probing here, before
    // any domain or CNAME moves, means a dead-on-arrival project costs one
    // deploy and no client-visible churn. The retry is bounded by the same cap
    // as the outer call: each blocked attempt adds one more blocked project to
    // the family, so the recursion stops at `maxBlockedProjects`.
    if (!this.dryRun) {
      const probe = await this.probeProject(next);
      if (probe.blocked) {
        repairs.push({
          action: 'rotation_retry',
          project: next,
          status: 'failed',
          detail: `${next} answered the project-blocked page (8000119) immediately after its deploy; trying the next suffix`
        });
        const retryObservations = {
          ...observations,
          projects: [...observations.projects, { name: next, suffix: projectSuffix(next, prefix), blocked: true }]
        };
        return this.rotate(retryObservations, repairs);
      }
    }

    // A hostname can be attached to one Pages project at a time, so detach from
    // the old project before attaching to the new one. A blocked project may
    // reject the DELETE; the attach is attempted anyway and reported.
    const hasSource = source && source !== next && observations.projects.some((project) => project.name === source);
    for (const host of this.config.hosts) {
      if (hasSource) await this.detachDomain(source, host, repairs);
      await this.attachDomain(next, host, repairs);
    }
    // CNAMEs move even when the deploy is still manual: traffic is down either
    // way, and a half-migration is easier to finish than to start over.
    for (const host of this.config.hosts) {
      await this.repointCname(host, next, observations, repairs);
    }
    // The project this rotation left behind serves nothing and holds no
    // hostname, so it is dead weight: it keeps the account's project list
    // growing and, once blocked, can never be deployed to again. Delete it
    // after the move, and only when it is genuinely not the project traffic
    // now lands on.
    if (hasSource) await this.retireProject(source, repairs);
    return next;
  }

  /**
   * Delete a superseded project.
   *
   * Deliberately narrow: never the project that now serves, never one still
   * holding a custom domain (the domains were just moved off it, so a failure
   * there leaves them attached and this refuses rather than orphaning them).
   * The delete is best-effort and reported; a failure leaves the project for a
   * human instead of failing the whole rotation.
   */
  async retireProject(project, repairs) {
    if (!project) return;
    // Read the domains back rather than trusting the snapshot from the start
    // of the run: a detach that failed up the stack leaves the hostname on the
    // old project, and deleting it would orphan that hostname entirely. The
    // live read is the only thing that distinguishes the two cases.
    let remaining = [];
    let known = false;
    try {
      const response = await this.api.call('GET', `/accounts/${this.config.accountId}/pages/projects/${project}/domains`);
      if (response.ok && Array.isArray(response.payload?.result)) {
        remaining = response.payload.result;
        known = true;
      }
    } catch {
      known = false;
    }
    // A blocked project answers this endpoint with 8000119, so "no answer" is
    // not "no domains". Treating an unreadable domain list as empty is the one
    // mistake that orphans a hostname, so an unreadable list means no delete.
    if (!known) {
      repairs.push({
        action: 'project_retire',
        project,
        status: 'skipped',
        detail: 'the project domain list could not be read, so the project was left in place'
      });
      return;
    }
    if (remaining.length > 0) {
      repairs.push({
        action: 'project_retire',
        project,
        status: 'skipped',
        detail: `still holds custom domain(s): ${remaining.map((entry) => entry.name).join(', ')}`
      });
      return;
    }
    if (this.dryRun) {
      repairs.push({
        action: 'project_retire',
        project,
        status: 'planned',
        detail: '',
        call: { method: 'DELETE', path: `/accounts/${this.config.accountId}/pages/projects/${project}` }
      });
      return;
    }
    const path = `/accounts/${this.config.accountId}/pages/projects/${project}`;
    const response = await this.api.call('DELETE', path);
    repairs.push({
      action: 'project_retire',
      project,
      status: response.ok || response.status === 404 ? 'done' : 'failed',
      detail: response.ok || response.status === 404 ? '' : errorDetail(response.payload, response.text),
      call: { method: 'DELETE', path }
    });
  }

  async repairAll(findings, observations) {
    const repairs = [];
    const rotationNeeded = findings.some((finding) => finding.code === 'project_missing' || finding.code === 'project_blocked');
    if (rotationNeeded) {
      // Rotation moves both hostnames and both CNAMEs; the per-finding loops
      // below would repeat those calls.
      await this.rotate(observations, repairs);
      return repairs;
    }
    const serving = observations.servingProject;
    if (!serving) return repairs;
    for (const finding of findings) {
      if (finding.code === 'dns_wrong_target' || finding.code === 'dns_missing') {
        await this.repointCname(finding.host, serving, observations, repairs);
      }
    }
    for (const finding of findings) {
      if (finding.code === 'custom_domain_missing') {
        await this.attachDomain(serving, finding.host, repairs);
      }
    }
    return repairs;
  }

  async run({ repair, dryRun }) {
    this.dryRun = Boolean(dryRun);
    let observations = await this.observe();
    let findings = diagnose(observations, this.config);
    let repairs = [];
    if (repair && findings.some((finding) => finding.repairable)) {
      repairs = await this.repairAll(findings, observations);
      if (!this.dryRun) {
        observations = await this.observe();
        findings = diagnose(observations, this.config);
        let attempt = 1;
        while (!verificationPasses(observations, this.config) && attempt < this.config.verifyAttempts) {
          await this.sleep(this.config.verifyDelayMs);
          observations = await this.observe();
          findings = diagnose(observations, this.config);
          attempt += 1;
        }
      }
    }
    return { healthy: findings.length === 0, findings, repairs, observations };
  }
}

// ---------------------------------------------------------------------------
// 诊候。
//
// 符不指其馆，则馆虽在而客不至；馆封而符犹指之，则非迁馆不可；名未录或久
// 悬而不过，则馆虽善而门不通；叩门得 1014 者，关隘拒客之兆也。
// ---------------------------------------------------------------------------

export function diagnose(observations, config) {
  const findings = [];
  const seen = new Set();
  const add = (finding) => {
    const key = `${finding.code}|${finding.host ?? ''}|${finding.project ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      code: finding.code,
      ...(finding.host ? { host: finding.host } : {}),
      ...(finding.project ? { project: finding.project } : {}),
      detail: finding.detail,
      repairable: Boolean(finding.repairable)
    });
  };

  const serving = observations.servingProject;
  const blocked = observations.projects.filter((project) => project.blocked);
  // Rotation is a bounded repair, not a loop. Every rotation leaves one more
  // blocked project in the family, and a family that keeps getting blocked is
  // a platform-side decision about this account, not a bad project name — so
  // past the cap the finding stays visible but stops being auto-repairable and
  // a human reads it instead. Without this, a ten-minute schedule would mint a
  // new project every run and never converge.
  //
  // 迁馆有度：同族被封者已满，则不再筑新馆，止而待人也。
  const rotationCapped = blocked.length >= config.maxBlockedProjects;
  const canRotate = !rotationCapped && (!observations.projects.length || blocked.length > 0);

  if (!observations.projects.length) {
    add({
      code: 'project_missing',
      detail: `no Pages project matching ${config.projectPrefix}NN exists in account ${config.accountId}`,
      repairable: true
    });
  } else if (!serving) {
    for (const project of blocked) {
      add({
        code: 'project_blocked',
        project: project.name,
        detail: rotationCapped
          ? `Pages project ${project.name} is blocked (8000119); ${blocked.length} blocked projects in the family reaches HEALTH_MAX_BLOCKED_PROJECTS=${config.maxBlockedProjects}, so rotation has stopped — a human must investigate the account`
          : `Pages project ${project.name} is blocked (8000119); it cannot serve and must be rotated`,
        repairable: canRotate
      });
    }
  } else {
    // A blocked project that a CNAME still points at is the state that needs
    // rotation; a blocked sibling nothing points at is reported but sits out
    // of the repair order (rotation would move traffic off the live project).
    const pointedAt = new Set(observations.dns
      .map((entry) => projectFromPagesDev(entry.records.find((record) => record.type === 'CNAME')?.content ?? ''))
      .filter(Boolean));
    for (const project of blocked) {
      const inUse = pointedAt.has(project.name) || observations.hosts.some((entry) => entry.error1014);
      if (!inUse) continue;
      add({
        code: 'project_blocked',
        project: project.name,
        detail: rotationCapped
          ? `Pages project ${project.name} is blocked (8000119) and a hostname still depends on it; ${blocked.length} blocked projects reaches HEALTH_MAX_BLOCKED_PROJECTS=${config.maxBlockedProjects}, so rotation has stopped — a human must investigate the account`
          : `Pages project ${project.name} is blocked (8000119) and a hostname still depends on it; rotate to a new project`,
        repairable: canRotate
      });
    }
  }

  const expected = serving ? `${serving}.pages.dev` : '';
  for (const entry of observations.dns) {
    const cname = entry.records.find((record) => record.type === 'CNAME');
    if (!cname) {
      add({
        code: 'dns_missing',
        host: entry.host,
        detail: `no CNAME record for ${entry.host} in zone ${observations.zone.name}`,
        repairable: Boolean(serving) || canRotate
      });
      continue;
    }
    if (!expected || normalizeTarget(cname.content) !== expected) {
      const targetProject = projectFromPagesDev(cname.content);
      const missing = targetProject && !observations.projectNames.includes(targetProject);
      add({
        code: 'dns_wrong_target',
        host: entry.host,
        detail: `${entry.host} points at ${cname.content}${missing ? ' (no such Pages project)' : ''}; expected ${expected || `a live ${config.projectPrefix}NN project`}`,
        repairable: Boolean(serving) || canRotate
      });
    }
  }

  if (serving) {
    const domains = observations.projects.find((project) => project.name === serving)?.domains ?? [];
    for (const host of config.hosts) {
      const attached = domains.find((domain) => domain.name === host);
      if (!attached) {
        add({
          code: 'custom_domain_missing',
          host,
          project: serving,
          detail: `${serving} does not list ${host} as a custom domain`,
          repairable: true
        });
      } else if (attached.status !== 'active') {
        add({
          code: 'custom_domain_not_active',
          host,
          project: serving,
          detail: `custom domain ${host} on ${serving} is '${attached.status || 'unknown'}', not active`,
          repairable: false
        });
      }
    }
  }

  for (const entry of observations.hosts) {
    if (entry.error) {
      add({
        code: 'http_error',
        host: entry.host,
        detail: `GET https://${entry.host}/ failed: ${entry.error}`,
        repairable: false
      });
      continue;
    }
    if (entry.error1014) {
      add({
        code: 'http_1014',
        host: entry.host,
        detail: `GET https://${entry.host}/ answered ${entry.status} with Cloudflare 1014 (CNAME target banned or missing)`,
        repairable: Boolean(serving) || canRotate
      });
      continue;
    }
    if (entry.status !== 200) {
      add({
        code: 'http_error',
        host: entry.host,
        detail: `GET https://${entry.host}/ answered ${entry.status}${entry.decoy ? ' (HTML)' : ''}`,
        repairable: false
      });
    }
  }

  const probe = observations.probe;
  if (probe?.configured) {
    if (probe.error) {
      add({
        code: 'http_error',
        host: probe.host,
        detail: `subscription probe ${probe.url} failed: ${probe.error}`,
        repairable: false
      });
    } else if (probe.error1014) {
      add({
        code: 'http_1014',
        host: probe.host,
        detail: `subscription probe ${probe.url} answered ${probe.status} with Cloudflare 1014`,
        repairable: Boolean(serving) || canRotate
      });
    } else if (probe.status !== 200) {
      add({
        code: 'http_error',
        host: probe.host,
        detail: `subscription probe ${probe.url} answered ${probe.status}`,
        repairable: false
      });
    } else if (probe.linkCount === 0) {
      add({
        code: 'payload_invalid',
        host: probe.host,
        detail: probe.decoy
          ? `subscription probe ${probe.url} returned the decoy HTML page, not a subscription`
          : `subscription probe ${probe.url} decoded to 0 vmess/vless/ss/trojan links after ${probe.layers} base64 layer(s) (${probe.bytes} bytes)`,
        repairable: false
      });
    }
  }

  return findings;
}

function verificationPasses(observations, config) {
  const hostsOk = observations.hosts.every((entry) => entry.status === 200);
  const probeOk = !config.probeUrl
    || (observations.probe?.status === 200 && observations.probe.linkCount > 0);
  return hostsOk && probeOk;
}

// ---------------------------------------------------------------------------
// Output and CLI.
// ---------------------------------------------------------------------------

function printHuman(report, stream) {
  const observations = report.observations;
  if (observations) {
    stream.write(`zone ${observations.zone.name || '(unknown)'} (${observations.zone.id})\n`);
    stream.write(`serving project: ${observations.servingProject || '(none)'}\n`);
    for (const entry of observations.hosts) {
      const flags = [entry.error1014 ? '1014' : '', entry.decoy ? 'html' : ''].filter(Boolean).join(' ');
      stream.write(`  ${entry.host.padEnd(28)} ${String(entry.status || 'ERR').padEnd(4)}${flags ? ` ${flags}` : ''}${entry.cfRay ? `  cf-ray ${entry.cfRay}` : ''}\n`);
    }
    if (observations.probe?.configured) {
      stream.write(`  probe ${observations.probe.host}: ${observations.probe.status}, ${observations.probe.linkCount} link(s) after ${observations.probe.layers} layer(s)\n`);
    }
  }
  stream.write(`findings: ${report.findings.length}\n`);
  for (const finding of report.findings) {
    const where = [finding.host, finding.project].filter(Boolean).join(' ');
    stream.write(`  ${finding.code}${where ? ` ${where}` : ''} — ${finding.detail}\n`);
  }
  stream.write(`repairs: ${report.repairs.length}\n`);
  for (const repair of report.repairs) {
    const where = [repair.host, repair.project].filter(Boolean).join(' ');
    stream.write(`  ${repair.action}${where ? ` ${where}` : ''} — ${repair.status}${repair.detail ? `: ${repair.detail}` : ''}\n`);
  }
  stream.write(report.healthy ? 'healthy\n' : 'unhealthy\n');
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;

  let args;
  let config;
  try {
    args = parseArgs(argv);
    if (args.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    config = readConfig(env);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const monitor = new HealthMonitor(config, deps);
  let report;
  try {
    report = await monitor.run({ repair: args.repair, dryRun: args.dryRun });
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${scrubSecrets(error.message, config.secrets)}\n`);
      return 2;
    }
    const detail = scrubSecrets(error?.message ?? String(error), config.secrets);
    stderr.write(`${detail}\n`);
    report = {
      healthy: false,
      findings: [{ code: 'http_error', detail, repairable: false }],
      repairs: [],
      observations: null
    };
  }

  const safe = scrubSecrets({
    healthy: report.healthy,
    findings: report.findings,
    repairs: report.repairs,
    observations: report.observations
  }, config.secrets);

  if (args.json) stdout.write(`${JSON.stringify(safe)}\n`);
  else printHuman(safe, stdout);
  return safe.healthy ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await main();
}
