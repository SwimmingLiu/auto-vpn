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
  'resume_from_iteration', 'failure_limit',
  // Internal: the extractor sets this when `backend_brand` redirects the data
  // plane. It is derived state, so a hand-edited profile must not persist it —
  // it would outlive the redirect that produced it.
  'brand_override'
] as const;

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback;
}

/**
 * A lap count as stored, or null when the key is absent or unusable.
 *
 * Null is what keeps a legacy row legacy: the caller must be able to tell "no
 * lap key" from "lap key of 0", because only the former leaves the round
 * policy in charge. `min_laps` legitimately accepts 0.
 */
function positiveLapValue(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
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
    // A lap row is already expressed in the unit the operator chose. Rewriting
    // its legacy caps to the round defaults would silently change the budget
    // the drawer just displayed, so those keys pass through verbatim and only
    // the lap keys are normalized.
    const hasLapKey = ['max_laps', 'dry_laps', 'min_laps'].some((key) => positiveLapValue(config[key]) !== null);
    const normalized: Record<string, any> = {
      ...config,
      mode: 'credential',
      official_site: String(config.official_site ?? '').trim() || brandSite(brand),
      enabled: config.enabled !== false,
      // A round is one cursor step over the fixed area list, not a full sweep
      // of every region. 200 rounds × the default 8 areas / 50 with no new
      // node matches the documented defaults.
      max_iterations: hasLapKey
        ? positiveInteger(config.max_iterations, 200)
        : wasCredential ? positiveInteger(config.max_iterations, 200) : 200,
      plateau_limit: hasLapKey
        ? positiveInteger(config.plateau_limit, 50)
        : wasCredential ? positiveInteger(config.plateau_limit, 50) : 50,
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
    if (hasLapKey) {
      const maxLaps = positiveLapValue(config.max_laps);
      const dryLaps = positiveLapValue(config.dry_laps);
      const minLaps = positiveLapValue(config.min_laps);
      if (maxLaps !== null) normalized.max_laps = maxLaps;
      if (dryLaps !== null) normalized.dry_laps = dryLaps;
      // A floor of 0 is meaningful ("no guaranteed laps"), so it is kept.
      if (minLaps !== null) normalized.min_laps = minLaps;
    }
    if (!wasCredential && !hasLapKey) {
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

/**
 * Fill in the fixed-IP egress defaults the Clash renderer reads.
 *
 * A profile written before this section existed has none of these keys, so
 * only the twin mode gets a default: an absent address list must stay absent,
 * otherwise the share Worker would build an empty egress group.
 */
export function normalizeStaticExitSection(value: unknown): Record<string, any> {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, any>;
  const twins = String(raw.twins ?? 'entrance').trim().toLowerCase();
  return {
    ...raw,
    exit: String(raw.exit ?? '').trim(),
    exit_json: String(raw.exit_json ?? '').trim(),
    group: String(raw.group ?? '').trim(),
    entrance: String(raw.entrance ?? '').trim(),
    twins: ['entrance', 'all', 'off'].includes(twins) ? twins : 'entrance'
  };
}

/**
 * Hide egress credentials before a profile leaves the server.
 *
 * The address list carries `user:pass@host`, so `/api/state` must not echo it
 * back; the reverse mapping restores the stored value when the client saves.
 */
export const STATIC_EXIT_REDACTED = '<redacted>';

export function redactStaticExitForClient(section: unknown): Record<string, any> {
  const normalized = normalizeStaticExitSection(section);
  return {
    ...normalized,
    exit: normalized.exit ? STATIC_EXIT_REDACTED : '',
    exit_json: normalized.exit_json ? STATIC_EXIT_REDACTED : ''
  };
}

export function preserveRedactedStaticExit(incoming: unknown, current: unknown): Record<string, any> {
  const merged = normalizeStaticExitSection(incoming);
  const stored = normalizeStaticExitSection(current);
  for (const key of ['exit', 'exit_json'] as const) {
    if (merged[key] === STATIC_EXIT_REDACTED) {
      merged[key] = stored[key];
    }
  }
  return merged;
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
    static_exit: (() => {
      const section = normalizeStaticExitSection((payload.static_exit ?? {}) as Record<string, any>);
      return {
        exit: state(section.exit),
        exit_json: state(section.exit_json),
        twins: section.twins
      };
    })(),
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
    static_exit: normalizeStaticExitSection(raw.static_exit),
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
  persisted.static_exit = normalizeStaticExitSection((persisted as Record<string, any>).static_exit);
  fs.writeFileSync(profilePath, stringify(persisted as any), 'utf8');
  return profilePayload(projectRoot, env);
}
