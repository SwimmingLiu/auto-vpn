import { isIsoAlpha2CountryCode } from './country-codes.js';

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

export interface PostprocessBackendOptions {}

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
const DEFAULT_FILTERS: Required<PostprocessFilters> = {
  excluded_country_codes: ['CN'],
  per_country_limit: {}
};
const LEADING_EMOJI_AND_COUNTRY_PATTERN = /^(?:\S+\s+)?([A-Za-z]{2})\s+(.*)$/;

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
  if (!isIsoAlpha2CountryCode(normalized)) {
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

export async function postprocessLinksWithBackend(input: PostprocessInput, options: PostprocessBackendOptions = {}): Promise<PostprocessOutput> {
  void options;
  return runPostprocess(input);
}
