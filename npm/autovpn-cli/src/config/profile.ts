import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from '@iarna/toml';

import { brandSite, normalizeBrand, type BrandKey } from '../pool/brands.js';
import { resolveArtifactsRoot, resolveProfilePath } from '../runtime/paths.js';

/**
 * One entry per vendor.
 *
 * `xuanfeng-area` / `xuanfeng-all-area` were two profile rows for one brand's
 * two route tables. The pipeline now fetches every table `/api/eversion`
 * advertises and merges them, so a second row would only duplicate the work.
 * Old profiles keep working: `normalizeBrand` maps both names to `xuanfeng`.
 */
const DEFAULT_SOURCE_ORDER = ['leiting', 'heidong', 'mifeng', 'xuanfeng'];

/** Profile rows that name the same vendor twice, folded into one. */
const LEGACY_SOURCE_ALIASES: Record<string, string> = {
  'xuanfeng-area': 'xuanfeng',
  'xuanfeng-all-area': 'xuanfeng',
  xuanfeng1: 'xuanfeng',
  xuanfeng2: 'xuanfeng'
};

/**
 * Fold legacy split rows into their canonical name.
 *
 * A row spelled with the canonical name always wins: an alias
 * (`xuanfeng-area`, `leiting_ios`) is the older shape, and letting it win would
 * overwrite the configured site or round budget with a stale copy. Two aliases
 * collapse to the first one listed. `enabled` is merged with OR either way, so
 * a disabled duplicate can never switch off a live source.
 */
export function collapseLegacySources(sources: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, config] of Object.entries(sources ?? {})) {
    const canonical = LEGACY_SOURCE_ALIASES[name] ?? name;
    const existing = out[canonical];
    if (!existing) {
      out[canonical] = { ...config };
      continue;
    }
    out[canonical] = {
      ...existing,
      ...(canonical === name ? config : {}),
      enabled: Boolean(existing.enabled ?? true) || Boolean(config.enabled ?? true)
    };
  }
  return out;
}

const OFFICIAL_SOURCE_KEYS = new Set<BrandKey>(['leiting', 'heidong', 'mifeng', 'xuanfeng']);
/**
 * Fields the drawer no longer edits.
 *
 * `min_iterations` and `platforms` are deliberately absent: both are still read
 * by the round policy and by `resolveCredentialPlatforms`, so a pinned debug
 * profile that sets them must keep working. Dropping them here would silently
 * change how many rounds run.
 */
const OBSOLETE_SOURCE_FIELDS = [
  'url', 'key', 'account', 'password', 'platform',
  'use_random_area', 'area_min', 'area_max',
  'resume_from_iteration', 'failure_limit'
] as const;

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback;
}

/**
 * Migrate the four vendor rows to the final input contract: official site only.
 *
 * Credentials live in the account pool and the control-plane key is discovered
 * from the APK. Both client channels run for every row, so a stored `platform`
 * is no longer a choice. URL-mode round counts are not carried over: 3000 URL
 * iterations meant 3000 requests, while 3000 credential rounds would mean
 * 3000 requests per route per platform.
 */
export function normalizeOfficialSources(sources: Record<string, any>): Record<string, any> {
  const collapsed = collapseLegacySources(sources);
  const out: Record<string, any> = {};
  for (const [name, config] of Object.entries(collapsed)) {
    const brand = normalizeBrand(name);
    if (!brand || !OFFICIAL_SOURCE_KEYS.has(brand) || !config || typeof config !== 'object') {
      out[name] = config;
      continue;
    }
    const wasCredential = config.mode === 'credential';
    const normalized: Record<string, any> = {
      ...config,
      mode: 'credential',
      official_site: String(config.official_site ?? '').trim() || brandSite(brand),
      enabled: config.enabled !== false,
      // A round is one cursor step over the fixed area list, not a full sweep
      // of every region. 200 rounds × the default 8 areas / 50 with no new
      // node matches the documented defaults.
      max_iterations: wasCredential ? positiveInteger(config.max_iterations, 200) : 200,
      plateau_limit: wasCredential ? positiveInteger(config.plateau_limit, 50) : 50,
      areas_per_round: Math.min(64, positiveInteger(config.areas_per_round, 8)),
      area_concurrency: Math.min(16, positiveInteger(config.area_concurrency, 4))
    };
    // Only a known vendor can serve as a data plane; an unknown name would
    // silently fall back to the row's own brand and produce the very node
    // shortage the field exists to fix.
    if (config.backend_brand !== undefined) {
      const backend = normalizeBrand(String(config.backend_brand).trim());
      if (backend && backend !== brand) {
        normalized.backend_brand = backend;
      } else {
        delete normalized.backend_brand;
      }
    }
    if (!wasCredential) {
      // A legacy URL row's caps describe a different operation; start the
      // cursor flow at the documented scheduled-run default instead. A floor
      // carried over from URL mode is the same mismatch and is dropped with it.
      normalized.max_iterations = 200;
      normalized.plateau_limit = 50;
      delete normalized.min_iterations;
    }
    for (const field of OBSOLETE_SOURCE_FIELDS) delete normalized[field];
    out[brand] = normalized;
  }
  return out;
}

function state(value: unknown): string {
  return String(value ?? '').trim() ? 'set' : 'missing';
}

/**
 * Crawl egress defaults, surfaced so the settings drawer can render them.
 *
 * `proxy` is the product default: the crawl goes through the upstream proxy and
 * drops to direct only when the proxy is not listening. `auto` starts direct
 * and pins the proxy on the first blocked response; `direct` never proxies.
 * The pipeline reads the same values from the environment, which the
 * orchestrator and the Electron backend env build from this section.
 */
export function normalizeNetworkSection(value: unknown): Record<string, any> {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, any>;
  const mode = String(raw.proxy_mode ?? 'proxy').trim().toLowerCase();
  return {
    ...raw,
    proxy_mode: ['proxy', 'direct', 'auto'].includes(mode) ? mode : 'proxy',
    proxy_url: String(raw.proxy_url ?? 'http://127.0.0.1:7897').trim() || 'http://127.0.0.1:7897'
  };
}

/** Map the profile's [network] section onto the env the pipeline reads. */
export function networkEnv(section: unknown, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const network = normalizeNetworkSection(section);
  return {
    ...base,
    VPN_AUTOMATION_PROXY_MODE: network.proxy_mode,
    VPN_AUTOMATION_UPSTREAM_PROXY: network.proxy_url
  };
}

function readProfile(profilePath: string): Record<string, any> {
  if (!fs.existsSync(profilePath)) {
    return {};
  }
  return parse(fs.readFileSync(profilePath, 'utf8')) as Record<string, any>;
}

export function profileSummary(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const profilePath = resolveProfilePath(projectRoot, env);
  const stateRoot = path.dirname(profilePath);
  const payload = readProfile(profilePath);
  const rawSources = normalizeOfficialSources((payload.sources ?? {}) as Record<string, any>);
  const sourceNames = [
    ...DEFAULT_SOURCE_ORDER,
    ...Object.keys(rawSources).filter((name) => !DEFAULT_SOURCE_ORDER.includes(name)).sort()
  ];
  const sources = Object.fromEntries(
    sourceNames.map((name) => {
      const config = rawSources[name] ?? {};
      const mode = config?.mode === 'credential' ? 'credential' : 'url';
      return [
      name,
      {
        enabled: Boolean(config?.enabled ?? true),
        mode,
        url: mode === 'url' ? state(config?.url) : state(config?.official_site ?? config?.apk_url),
        // A credential source has no control-plane key in the profile; the key
        // is discovered from the APK, so the check must not require one.
        key: mode === 'url' ? state(config?.key) : state(config?.key ?? 'discovered'),
        account: mode === 'credential' ? 'pool' : state(config?.account),
        platform: mode === 'credential' ? 'android+ios' : String(config?.platform ?? 'android')
      }
    ];
    })
  );
  const deploy = (payload.deploy ?? {}) as Record<string, any>;
  return {
    ok: true,
    sources,
    deploy: {
      project_name: String(deploy.project_name ?? ''),
      pages_project_url: String(deploy.pages_project_url ?? ''),
      cloudflare_api_token: state(deploy.cloudflare_api_token),
      cloudflare_global_key: state(deploy.cloudflare_global_key),
      cloudflare_email: state(deploy.cloudflare_email),
      account_id: state(deploy.account_id),
      subscription_url: state(deploy.subscription_url),
      verify_subscription_url: state(deploy.verify_subscription_url),
      secret_query: state(deploy.secret_query)
    },
    paths: {
      project_root: projectRoot,
      artifacts_root: resolveArtifactsRoot(projectRoot, env),
      state_root: stateRoot,
      profile_path: profilePath
    }
  };
}

export function profilePayload(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const profilePath = resolveProfilePath(projectRoot, env);
  const paths = {
    project_root: projectRoot,
    artifacts_root: resolveArtifactsRoot(projectRoot, env),
    state_root: path.dirname(profilePath),
    profile_path: profilePath
  };
  const raw = readProfile(profilePath);
  return {
    ...raw,
    sources: normalizeOfficialSources((raw.sources ?? {}) as Record<string, any>),
    network: normalizeNetworkSection(raw.network),
    paths,
    workspace: paths
  };
}

export function saveProfilePayload(projectRoot: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const profilePath = resolveProfilePath(projectRoot, env);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const persisted = { ...payload };
  delete (persisted as Record<string, unknown>).paths;
  delete (persisted as Record<string, unknown>).workspace;
  persisted.sources = normalizeOfficialSources((persisted.sources ?? {}) as Record<string, any>);
  persisted.network = normalizeNetworkSection((persisted as Record<string, any>).network);
  fs.writeFileSync(profilePath, stringify(persisted as any), 'utf8');
  return profilePayload(projectRoot, env);
}
