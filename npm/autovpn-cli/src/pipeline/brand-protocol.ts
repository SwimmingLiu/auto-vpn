/**
 * Protocol primitives the brand apps share.
 *
 * Every brand ships the same control plane, differing only in seed domains,
 * package name, certificate and a handful of literal flags, so the crypto and
 * request shapes below are common to all of them.
 */

import { createHash } from 'node:crypto';

export type Platform = 'android' | 'ios';

/** Login requests sign the credentials with a fixed salt baked into every APK. */
export const LOGIN_SALT = '954d976c3c9fd5e5c63dab4016cc12da';

/** The AES key that protects every control-plane response. */
export type ControlPlaneKey = string;

export interface BrandIdentity {
  seed_domains: string[];
  package_name: string;
  version_name: string;
  cert_sha1: string;
  protocol: string;
  core_version: string;
  lite_version: string;
}

export interface DeviceIdentity {
  device_id: string;
  install_date: string;
}

/**
 * `getApiDomain()` picks a seed by the first character of MD5(deviceId).
 * The index uses the character code, not its hexadecimal value, which is why
 * a device whose digest starts with `b` lands on index 2 rather than 1.
 */
export function apiDomainIndex(deviceId: string, seedCount: number): number {
  if (seedCount <= 0) {
    return -1;
  }
  const digest = createMd5Hex(deviceId);
  return digest.charCodeAt(0) % seedCount;
}

export function createMd5Hex(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

/**
 * `apps=` is `MD5(certSha1 + deviceId)`; the Java code upper-cases the
 * concatenation before hashing, so the digest differs from a naive join.
 */
export function appsFingerprint(certSha1: string, deviceId: string): string {
  return createMd5Hex(`${certSha1}${deviceId}`.toUpperCase());
}

export function selectApiDomain(seedDomains: string[], deviceId: string): string {
  const index = apiDomainIndex(deviceId, seedDomains.length);
  return index < 0 ? '' : seedDomains[index];
}

export interface CommonParamsInput {
  identity: BrandIdentity;
  device: DeviceIdentity;
  platform: Platform;
  timestampMs: number;
  token?: string;
  code?: string;
  recommendCode?: string;
  isVip?: boolean;
  unlimited?: boolean;
}

/** A brand's literal parameter block: flags interleaved between the common ones. */
export interface BrandLayout {
  /** Literal block inserted after `&package=`, e.g. `&newlt=1`. */
  afterPackage?: string;
  /** Literal block inserted before `&apps=`, after `&unlimit=`. */
  beforeApps?: string;
  /** Width/height block inserted before `&isvip=`. */
  viewport?: boolean;
  /** `&vip=` is emitted first (旋风) and `isvip` is omitted. */
  vipFirst?: boolean;
}

/**
 * `getCommParams()` as a parameter list.
 *
 * The four brands share the same fields but not the same order: each one is a
 * single `return` concatenation with a literal flag block in a different place,
 * and the server does notice. 雷霆 carries the viewport block before `&isvip=`,
 * 旋风 puts `&vip=` first and drops `isvip` entirely.
 */
export function commonParams(input: CommonParamsInput, layout: BrandLayout = {}): string {
  const { identity, device, platform } = input;
  const isVip = input.isVip === false ? 0 : 1;
  const unlimited = input.unlimited === false ? 0 : 1;
  const viewport = '&width=392.7&height=830.9&w=1178&h=2493';
  const parts: string[] = [];
  if (layout.vipFirst) {
    parts.push(`&vip=${isVip}`);
  }
  parts.push(
    `&proto=${identity.protocol}`,
    `&platform=${platform}`,
    `&core=${identity.core_version}`,
    `&lite=${identity.lite_version}`,
    `&ver=${identity.version_name}`,
    `&deviceid=${device.device_id}`,
    `&unicode=${device.device_id}`,
    `&t=${input.timestampMs}`,
    `&code=${input.code ?? ''}`,
    `&recomm_code=${input.recommendCode ?? ''}`,
    `&f=${device.install_date}`,
    `&install=${device.install_date}`,
    `&token=${input.token ?? ''}`,
    `&package=${identity.package_name}`
  );
  if (layout.afterPackage) {
    parts.push(layout.afterPackage);
  }
  if (layout.viewport) {
    parts.push(viewport);
  }
  if (!layout.vipFirst) {
    parts.push(`&isvip=${isVip}`);
  }
  parts.push(`&unlimit=${unlimited}`);
  if (layout.beforeApps) {
    parts.push(layout.beforeApps);
  }
  parts.push(`&apps=${appsFingerprint(identity.cert_sha1, device.device_id)}`);
  return parts.join('');
}

export function buildUrl(base: string, params: string): string {
  const separator = base.includes('?') ? '' : '?';
  return `${base}${separator}${params}`;
}

/** `Uri.parse(url)` + `getPath() + "?" + getQuery()` — the domain is dropped. */
export function pathAndQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}?${parsed.searchParams.toString()}`;
  } catch {
    return url;
  }
}

export interface RouteNode {
  area: number;
  name: string;
  region: string;
  cid: number;
  enabled: boolean;
}

export interface RouteGroup {
  cid: number;
  cname: string;
  open: number;
  nodes: Array<{ id: number; name: string; enable: number; enable_desc: string }>;
}

/**
 * Flattens `/myapi/apinodelist` the way `LineActivity` renders it.
 *
 * `open == 2` shows only the children (the group is a collapsed header), so the
 * clickable rows carry `data[].id`. For the other modes the group row itself is
 * clickable too and carries the group's `cid`.
 */
export function flattenRouteGroups(groups: RouteGroup[]): RouteNode[] {
  const out: RouteNode[] = [];
  for (const group of groups) {
    const children = group.nodes ?? [];
    if (group.open !== 2) {
      out.push({
        area: group.cid,
        name: group.cname,
        region: group.cname,
        cid: group.cid,
        enabled: true
      });
    }
    for (const child of children) {
      out.push({
        area: child.id,
        name: child.name,
        region: group.cname,
        cid: group.cid,
        enabled: Number(child.enable) === 1
      });
    }
  }
  return out;
}

/**
 * Route groups the pool must not spend rounds on.
 *
 * `/myapi/apinodelist` mixes three kinds of row: paid foreign regions, a free
 * tier, and mainland/return-to-China lines. Only the first produces nodes worth
 * publishing, and asking the other two costs a request per round forever.
 * Matching is on the group name (`cname`) and the row name, because a free row
 * can sit inside an otherwise paid group.
 */
const FREE_ROUTE_PATTERN = /免费|免費|试用|試用|体验|體驗|free|trial|guest/i;

/**
 * Mainland and return-to-China labels.
 *
 * 香港 / 台湾 / 澳门 are deliberately not matched: the apps list them as their own
 * regions rather than as 中国, and they are the routes this pool exists to
 * collect. `回国` is matched because it is the mainland-bound direction.
 */
const CHINA_ROUTE_PATTERN =
  /中国|中國|国内|國內|大陆|大陸|内地|內地|回国|回國|china|mainland|\bCN\b|北京|上海|天津|重庆|廣州|广州|深圳|杭州|南京|成都|武汉|武漢|西安|苏州|蘇州|郑州|鄭州|长沙|長沙|青岛|青島|大连|大連|宁波|寧波|厦门|廈門|福州|济南|濟南|合肥|昆明|南昌|贵阳|貴陽|太原|石家庄|石家莊|哈尔滨|哈爾濱|长春|長春|沈阳|瀋陽|南宁|南寧|海口|兰州|蘭州|银川|銀川|西宁|西寧|乌鲁木齐|烏魯木齊|呼和浩特|拉萨|拉薩|广东|廣東|江苏|江蘇|浙江|山东|山東|河南|河北|湖南|湖北|四川|福建|安徽|辽宁|遼寧|陕西|陝西|江西|云南|雲南|贵州|貴州|山西|甘肃|甘肅|吉林|黑龙江|黑龍江|海南|青海|内蒙古|內蒙古|广西|廣西|宁夏|寧夏|新疆|西藏/i;

export function isFreeRoute(route: Pick<RouteNode, 'region' | 'name'>): boolean {
  return FREE_ROUTE_PATTERN.test(`${route.region} ${route.name}`);
}

/**
 * Hong Kong / Taiwan / Macau stay in the pool even when the vendor spells the
 * region `中国香港` or `中国台湾`; the bare `中国` rule below would otherwise drop
 * exactly the routes the filter promises to keep.
 */
const GREATER_CHINA_EXEMPT_PATTERN = /香港|台湾|台灣|臺灣|澳门|澳門|hong\s*kong|taiwan|macau|macao/i;

export function isChinaRoute(route: Pick<RouteNode, 'region' | 'name'>): boolean {
  const text = `${route.region} ${route.name}`;
  if (GREATER_CHINA_EXEMPT_PATTERN.test(text) && !/回国|回國|mainland-bound/i.test(text)) {
    return false;
  }
  return CHINA_ROUTE_PATTERN.test(text);
}

export interface RouteFilterOptions {
  /** Keep the free tier. Off by default: it issues placeholders, not nodes. */
  includeFree?: boolean;
  /** Keep mainland and return-to-China lines. Off by default. */
  includeChina?: boolean;
  /** Keep rows the vendor marked unclickable. Off by default. */
  includeDisabled?: boolean;
}

export interface RouteFilterResult {
  routes: RouteNode[];
  dropped_free: number;
  dropped_china: number;
  dropped_disabled: number;
  dropped_duplicate: number;
}

/**
 * Reduce one or more route tables to the area ids worth looping over.
 *
 * Dedupe is by `area`, not by name: 旋风 serves two labelled tables that overlap,
 * and the same id in both is one route, not two. The first occurrence wins so
 * the region label stays the one the vendor listed first.
 */
export function selectForeignRoutes(routes: RouteNode[], options: RouteFilterOptions = {}): RouteFilterResult {
  const result: RouteFilterResult = {
    routes: [],
    dropped_free: 0,
    dropped_china: 0,
    dropped_disabled: 0,
    dropped_duplicate: 0
  };
  const seen = new Set<number>();
  for (const route of routes) {
    if (!Number.isFinite(route.area) || route.area < 0) {
      result.dropped_duplicate += 1;
      continue;
    }
    if (!options.includeDisabled && !route.enabled) {
      result.dropped_disabled += 1;
      continue;
    }
    if (!options.includeFree && isFreeRoute(route)) {
      result.dropped_free += 1;
      continue;
    }
    if (!options.includeChina && isChinaRoute(route)) {
      result.dropped_china += 1;
      continue;
    }
    if (seen.has(route.area)) {
      result.dropped_duplicate += 1;
      continue;
    }
    seen.add(route.area);
    result.routes.push(route);
  }
  return result;
}

/** The placeholder the server returns when it will not issue a real node. */
export const PLACEHOLDER_ADDRESS = '1.1.1.1';

export function isPlaceholderNode(address: string): boolean {
  return String(address).trim() === PLACEHOLDER_ADDRESS;
}

/** `transformNodeId` — swaps each 4-character pair, matching the app's UUID form. */
export function transformNodeId(original: string): string {
  return String(original).split('-').map((part) => {
    const chunks: string[] = [];
    for (let index = 0; index < part.length; index += 4) {
      const chunk = part.slice(index, index + 4);
      if (chunk) {
        chunks.push(`${chunk.slice(2)}${chunk.slice(0, 2)}`);
      }
    }
    return chunks.join('');
  }).join('-');
}
