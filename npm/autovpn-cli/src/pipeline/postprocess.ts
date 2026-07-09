import path from 'node:path';
import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { mergeProjectEnv } from '../runtime/env.js';

export type PipelineStageBackend = 'node' | 'python';

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

interface ResolvedPythonCli {
  command: string;
  args: string[];
}

interface RankedLink {
  link: string;
  country_code?: string;
  countryCode?: string;
}

interface PostprocessFilters {
  excluded_country_codes?: string[];
  per_country_limit?: Record<string, number>;
}

export interface PostprocessInput {
  ranked_links: RankedLink[];
  filters?: PostprocessFilters;
}

export interface PostprocessOutput {
  links: string[];
}

export interface PostprocessBackendOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  resolvePythonCli?: () => ResolvedPythonCli | Promise<ResolvedPythonCli>;
  pythonPostprocess?: (input: PostprocessInput) => PostprocessOutput | Promise<PostprocessOutput>;
}

const EMOJI_MAP: Record<string, string> = {
  AE: '🇦🇪',
  AR: '🇦🇷',
  AU: '🇦🇺',
  BE: '🇧🇪',
  BR: '🇧🇷',
  CA: '🇨🇦',
  CH: '🇨🇭',
  CL: '🇨🇱',
  CN: '🇨🇳',
  CO: '🇨🇴',
  DE: '🇩🇪',
  DK: '🇩🇰',
  ES: '🇪🇸',
  FR: '🇫🇷',
  GB: '🇬🇧',
  HK: '🇭🇰',
  IN: '🇮🇳',
  IT: '🇮🇹',
  JP: '🇯🇵',
  KR: '🇰🇷',
  MX: '🇲🇽',
  MY: '🇲🇾',
  NL: '🇳🇱',
  NO: '🇳🇴',
  NZ: '🇳🇿',
  PL: '🇵🇱',
  PT: '🇵🇹',
  RU: '🇷🇺',
  SA: '🇸🇦',
  SE: '🇸🇪',
  SG: '🇸🇬',
  TH: '🇹🇭',
  TR: '🇹🇷',
  TW: '🇹🇼',
  US: '🇺🇸',
  ZA: '🇿🇦'
};

const FALLBACK_COUNTRY_CODE = 'US';
const UNKNOWN_COUNTRY_CODE = 'ZZ';
const DEFAULT_FILTERS: Required<PostprocessFilters> = {
  excluded_country_codes: ['CN'],
  per_country_limit: {}
};
const LEADING_EMOJI_AND_COUNTRY_PATTERN = /^(?:\S+\s+)?([A-Za-z]{2})\s+(.*)$/;

const PYTHON_POSTPROCESS_HELPER = `
import json
import sys
from vpn_automation.config.models import FilterConfig
from vpn_automation.pipeline.postprocess import decorate_link_with_country, select_links_by_country_limit

payload = json.load(sys.stdin)
filters = payload.get("filters")
ranked_links = payload.get("ranked_links") or []
filter_config = FilterConfig() if filters is None else FilterConfig(
    excluded_country_codes=list(filters.get("excluded_country_codes") or []),
    per_country_limit=dict(filters.get("per_country_limit") or {}),
)
selected = select_links_by_country_limit(
    [(item["link"], {}, item.get("country_code") or item.get("countryCode") or "") for item in ranked_links],
    filter_config,
)
country_by_link = {
    item["link"]: item.get("country_code") or item.get("countryCode") or ""
    for item in ranked_links
}
json.dump({"links": [decorate_link_with_country(link, country_by_link[link]) for link in selected]}, sys.stdout, ensure_ascii=False)
sys.stdout.write("\\n")
`;

export function parseVmessLink(link: string): Record<string, unknown> {
  const encoded = link.replace(/^vmess:\/\//, '');
  const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function generateVmessLink(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  return `vmess://${encoded}`;
}

export function normalizeCountryCode(countryCode: string): string {
  const normalized = String(countryCode || '').trim().toUpperCase();
  if (normalized.length !== 2 || !/^[A-Z]{2}$/.test(normalized) || normalized === UNKNOWN_COUNTRY_CODE) {
    return FALLBACK_COUNTRY_CODE;
  }
  return normalized;
}

export function countryToEmoji(countryCode: string): string {
  const normalized = normalizeCountryCode(countryCode);
  return EMOJI_MAP[normalized] ?? EMOJI_MAP[FALLBACK_COUNTRY_CODE];
}

function resolveFilters(filters: PostprocessFilters | undefined): Required<PostprocessFilters> {
  return {
    excluded_country_codes: filters?.excluded_country_codes ?? DEFAULT_FILTERS.excluded_country_codes,
    per_country_limit: filters?.per_country_limit ?? DEFAULT_FILTERS.per_country_limit
  };
}

function stripLeadingCountryPrefix(originalName: string): string {
  const name = String(originalName || '').trim();
  if (!name) {
    return '';
  }
  const match = name.match(LEADING_EMOJI_AND_COUNTRY_PATTERN);
  if (!match) {
    return name;
  }
  const remainder = String(match[2] ?? '').trim();
  return remainder || name;
}

export function decorateNodeName(originalName: string, countryCode: string, emoji: string): string {
  const cleanedName = stripLeadingCountryPrefix(originalName);
  return `${emoji} ${countryCode} ${cleanedName}`.trim();
}

export function decorateLinkWithCountry(link: string, countryCode: string): string {
  const payload = parseVmessLink(link);
  const normalizedCountry = normalizeCountryCode(countryCode);
  payload.ps = decorateNodeName(String(payload.ps ?? ''), normalizedCountry, countryToEmoji(normalizedCountry));
  return generateVmessLink(payload);
}

export function selectLinksByCountryLimit(rankedLinks: RankedLink[], filters: PostprocessFilters = {}): string[] {
  const resolvedFilters = resolveFilters(filters);
  const excluded = new Set(resolvedFilters.excluded_country_codes.map((country) => normalizeCountryCode(country)));
  const limits = Object.fromEntries(Object.entries(resolvedFilters.per_country_limit).map(([country, limit]) => [normalizeCountryCode(country), Number(limit)]));
  const counters = new Map<string, number>();
  const selected: string[] = [];
  for (const item of rankedLinks) {
    const country = normalizeCountryCode(String(item.country_code ?? item.countryCode ?? ''));
    if (excluded.has(country)) {
      continue;
    }
    if (country in limits) {
      const current = counters.get(country) ?? 0;
      if (current >= limits[country]) {
        continue;
      }
      counters.set(country, current + 1);
    }
    selected.push(item.link);
  }
  return selected;
}

export function runPostprocess(input: PostprocessInput): PostprocessOutput {
  const rankedLinks = input.ranked_links ?? [];
  const selected = selectLinksByCountryLimit(rankedLinks, input.filters);
  const countries = new Map(rankedLinks.map((item) => [item.link, String(item.country_code ?? item.countryCode ?? '')]));
  return {
    links: selected.map((link) => decorateLinkWithCountry(link, countries.get(link) ?? ''))
  };
}

export function selectPipelineStageBackend(stage: string, env: NodeJS.ProcessEnv = process.env): PipelineStageBackend {
  void stage;
  void env;
  return 'node';
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

async function postprocessWithPython(input: PostprocessInput, options: PostprocessBackendOptions): Promise<PostprocessOutput> {
  const env = mergeProjectEnv(options.cwd ?? process.cwd(), options.env ?? process.env);
  const resolved = options.resolvePythonCli ? await options.resolvePythonCli() : await defaultResolvePythonCli(env);
  const helperInput = { ...input, filters: resolveFilters(input.filters) };
  const child = (options.spawn ?? defaultSpawn)(pythonCommandFor(resolved), ['-c', PYTHON_POSTPROCESS_HELPER], {
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
  const completion = new Promise<PostprocessOutput>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python postprocess backend failed with exit code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as PostprocessOutput);
      } catch (error) {
        reject(new Error(`Python postprocess backend returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
  child.stdin?.write(JSON.stringify(helperInput));
  child.stdin?.end();
  return completion;
}

export async function postprocessLinksWithBackend(input: PostprocessInput, options: PostprocessBackendOptions = {}): Promise<PostprocessOutput> {
  if (selectPipelineStageBackend('postprocess', options.env ?? process.env) === 'python') {
    return options.pythonPostprocess ? options.pythonPostprocess(input) : postprocessWithPython(input, options);
  }
  return runPostprocess(input);
}
