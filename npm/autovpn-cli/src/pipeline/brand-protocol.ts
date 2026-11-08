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
