import crypto from 'node:crypto';
import zlib from 'node:zlib';

/**
 * Static APK discovery and inspection without native Android tooling.
 *
 * Discovery path: official site -> download page chunk -> cdn.js -> time-sliced
 * APK URL -> APK bytes -> dex string literals. The brand apps embed their whole
 * control-plane configuration (seed domains, package, version, certificate) in
 * the dex, so nothing here needs aapt, apktool or a device.
 */

export interface ApkDiscovery {
  apk_url: string;
  package_name: string;
  version_name: string;
  cert_sha1: string;
  seed_domains: string[];
  protocol: string;
  core_version: string;
  lite_version: string;
}

export interface SlotSpec {
  prefix: string;
  interval_minutes: number;
}

const SEED_DOMAIN_PATTERN = /^(https?:\/\/www\.[a-z0-9]{3,14}\.(?:cc|info|com|net))(?::(\d+))?\/?$/;
const PACKAGE_PATTERN = /^[a-zA-Z][\w]*(?:\.[\w]+){2,}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function readU16(buffer: Buffer, offset: number): number {
  return offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : 0;
}

function readU32(buffer: Buffer, offset: number): number {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0;
}

function decodeUleb128(buffer: Buffer, start: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    offset += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, next: offset };
    }
    shift += 7;
    if (shift > 35) {
      break;
    }
  }
  return { value: result >>> 0, next: offset };
}

/** Reads the dex `string_ids` table: every string literal the app carries. */
export function dexStrings(data: Buffer): string[] {
  if (data.length < 0x70 || data.subarray(0, 4).toString('binary') !== 'dex\n') {
    return [];
  }
  const stringIdsSize = readU32(data, 0x38);
  const stringIdsOffset = readU32(data, 0x3c);
  if (!stringIdsSize || stringIdsOffset + stringIdsSize * 4 > data.length) {
    return [];
  }
  const out: string[] = [];
  for (let index = 0; index < stringIdsSize; index += 1) {
    const dataOffset = readU32(data, stringIdsOffset + index * 4);
    if (!dataOffset || dataOffset >= data.length) {
      continue;
    }
    const { next } = decodeUleb128(data, dataOffset);
    const end = data.indexOf(0, next);
    if (end < 0) {
      continue;
    }
    out.push(data.subarray(next, end).toString('utf8'));
  }
  return out;
}

/** Reads selected zip entries by walking the central directory. */
export function readZipEntries(zip: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const minEocd = 22;
  let eocd = -1;
  for (let offset = zip.length - minEocd; offset >= Math.max(0, zip.length - 0xffff - minEocd); offset -= 1) {
    if (readU32(zip, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    return out;
  }
  const entryCount = readU16(zip, eocd + 10);
  let centralOffset = readU32(zip, eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (centralOffset + 46 > zip.length || readU32(zip, centralOffset) !== 0x02014b50) {
      break;
    }
    const method = readU16(zip, centralOffset + 10);
    const compressedSize = readU32(zip, centralOffset + 20);
    const uncompressedSize = readU32(zip, centralOffset + 24);
    const nameLength = readU16(zip, centralOffset + 28);
    const extraLength = readU16(zip, centralOffset + 30);
    const commentLength = readU16(zip, centralOffset + 32);
    const localOffset = readU32(zip, centralOffset + 42);
    const name = zip.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
    centralOffset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) {
      continue;
    }
    if (localOffset + 30 > zip.length || readU32(zip, localOffset) !== 0x04034b50) {
      continue;
    }
    const dataStart = localOffset + 30 + readU16(zip, localOffset + 26) + readU16(zip, localOffset + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    if (raw.length !== compressedSize) {
      continue;
    }
    if (method === 0) {
      out.set(name, Buffer.from(raw));
    } else if (method === 8) {
      try {
        const inflated = zlib.inflateRawSync(raw);
        if (inflated.length === uncompressedSize) {
          out.set(name, inflated);
        }
      } catch {
        // A corrupt entry must not abort discovery of the others.
      }
    }
  }
  return out;
}

/** AndroidManifest.xml is binary AXML; the string pool holds package and versionName. */
export function axmlStrings(data: Buffer): string[] {
  if (data.length < 8) {
    return [];
  }
  if (readU16(data, 0) !== 0x0003) {
    return [...data.toString('utf8').matchAll(/="([^"]*)"/g)].map((match) => match[1]);
  }
  const poolOffset = 8;
  if (readU16(data, poolOffset) !== 0x0001) {
    return [];
  }
  const stringCount = readU32(data, poolOffset + 8);
  const flags = readU32(data, poolOffset + 16);
  const stringsStart = readU32(data, poolOffset + 20);
  const isUtf8 = (flags & 0x100) !== 0;
  const base = poolOffset + stringsStart;
  const out: string[] = [];
  for (let index = 0; index < stringCount; index += 1) {
    const relative = readU32(data, poolOffset + 28 + index * 4);
    let cursor = base + relative;
    try {
      if (isUtf8) {
        cursor = decodeUleb128(data, cursor).next;
        const length = decodeUleb128(data, cursor);
        cursor = length.next;
        out.push(data.subarray(cursor, cursor + length.value).toString('utf8'));
      } else {
        let length = readU16(data, cursor);
        cursor += 2;
        if (length & 0x8000) {
          length = ((length & 0x7fff) << 16) | readU16(data, cursor);
          cursor += 2;
        }
        out.push(data.subarray(cursor, cursor + length * 2).toString('utf16le'));
      }
    } catch {
      // Ignore malformed entries; the remaining pool is still usable.
    }
  }
  return out;
}

/**
 * The manifest string pool lists every literal, so the package name cannot be
 * "the first com.* string" — permission constants and bundled SDK namespaces
 * come first. The reliable source is the dex, which carries the package name
 * itself (the `<manifest package>` value) as a plain literal, next to the
 * `…action.activity` style prefixes it generates.
 */
export function manifestIdentity(axml: Buffer, dexLiterals: string[] = []): { package_name: string; version_name: string } {
  const strings = axmlStrings(axml);
  const versionName = strings.find((value) => VERSION_PATTERN.test(value)) ?? '';

  // `<manifest package="x">` also appears in the manifest pool; prefer a value
  // the dex independently repeats and that no permission constant shadows.
  const manifestCandidates = strings.filter((value) => (
    PACKAGE_PATTERN.test(value)
    && value.startsWith('com.')
    && !/^com\.android\./.test(value)
  ));
  const dexSet = new Set(dexLiterals);
  const confirmed = manifestCandidates
    .filter((value) => dexSet.has(value) && dexLiterals.some((literal) => literal.startsWith(`${value}.action.`)))
    .sort((left, right) => right.length - left.length);
  if (confirmed.length > 0) {
    return { package_name: confirmed[0], version_name: versionName };
  }

  // Second best: any dex literal shaped `com.<vendor>.<app><digits>`.
  const shaped = dexLiterals
    .filter((value) => /^com\.[a-z]+\.[a-z]+\d{6,}$/i.test(value))
    .sort((left, right) => right.length - left.length);
  if (shaped.length > 0) {
    return { package_name: shaped[0], version_name: versionName };
  }
  return { package_name: manifestCandidates[0] ?? '', version_name: versionName };
}

export function certificateSha1(certificateDer: Buffer): string {
  return crypto.createHash('sha1').update(certificateDer).digest('hex').toUpperCase();
}

/**
 * Extracts the signer certificate from a PKCS#7 SignedData blob.
 *
 * The blob nests several SEQUENCEs (SignedData, its `certificates` set, then the
 * certificate itself), so "the first large SEQUENCE" picks the wrong one. The
 * certificate is the SEQUENCE whose structure parses as an X.509 TBSCertificate:
 * it must start with another `30 82`, be at least a few hundred bytes, and fit
 * exactly inside the blob. The deepest such candidate is the certificate.
 */
export function firstCertificateFromPkcs7(pkcs7: Buffer): Buffer | null {
  const candidates: Buffer[] = [];
  const walk = (buffer: Buffer, depth: number): void => {
    for (let offset = 0; offset + 4 <= buffer.length; offset += 1) {
      if (buffer[offset] !== 0x30 || buffer[offset + 1] !== 0x82) {
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      const end = offset + 4 + length;
      if (length < 0x180 || end > buffer.length) {
        continue;
      }
      const inner = buffer.subarray(offset, end);
      // An X.509 certificate's first child is its TBSCertificate SEQUENCE.
      if (inner[4] !== 0x30) {
        continue;
      }
      candidates.push(Buffer.from(inner));
      if (depth < 6) {
        walk(inner.subarray(4), depth + 1);
      }
    }
  };
  walk(pkcs7, 0);
  if (candidates.length === 0) {
    return null;
  }
  // The certificate is the innermost candidate, i.e. the shortest one that
  // still spans a full X.509 structure.
  return candidates.sort((left, right) => left.length - right.length)[0];
}

/** Hosts shipped as documentation samples, never a control-plane seed. */
const SAMPLE_HOSTS = new Set(['www.example.com', 'www.google.com', 'example.com', 'google.com']);

/**
 * Seed domains are the `https://www.<label>.<tld>:20000` literals the dex
 * carries; they are what `getApiDomain()` picks between and what
 * `/api/eversion` answers on. The control-plane port is the filter that
 * separates them from the sample hosts bundled in third-party libraries.
 */
export function seedDomains(strings: string[]): string[] {
  const candidates: string[] = [];
  for (const value of strings) {
    const match = SEED_DOMAIN_PATTERN.exec(value.trim());
    if (!match || SAMPLE_HOSTS.has(match[1].replace(/^https?:\/\//, ''))) {
      continue;
    }
    const normalized = `${match[1]}:${match[2] ?? '20000'}`;
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  }
  return candidates.filter((value) => value.endsWith(':20000'));
}

export function apkDiscoveryFromBytes(apk: Buffer, apkUrl: string): ApkDiscovery {
  const entries = readZipEntries(apk, (name) => (
    name === 'AndroidManifest.xml'
    || name.endsWith('.dex')
    || (name.startsWith('META-INF/') && /\.(RSA|DSA|EC)$/i.test(name))
  ));
  const manifest = entries.get('AndroidManifest.xml');
  const strings: string[] = [];
  for (const [name, data] of entries) {
    if (name.endsWith('.dex')) {
      strings.push(...dexStrings(data));
    }
  }
  const identity = manifest
    ? manifestIdentity(manifest, strings)
    : { package_name: '', version_name: '' };
  const joined = strings.join('\n');

  let certSha1 = '';
  for (const [name, data] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    if (!/\.(RSA|DSA|EC)$/i.test(name)) {
      continue;
    }
    const certificate = firstCertificateFromPkcs7(data);
    if (certificate) {
      certSha1 = certificateSha1(certificate);
      break;
    }
  }

  return {
    apk_url: apkUrl,
    package_name: identity.package_name,
    version_name: identity.version_name,
    cert_sha1: certSha1,
    seed_domains: seedDomains(strings),
    protocol: `v${/proto=v(\d+)/.exec(joined)?.[1] ?? '7'}`,
    core_version: /&core=([\d.]+)/.exec(joined)?.[1] ?? '5.12.1',
    lite_version: /lite=([\d.]+)/.exec(joined)?.[1] ?? '5.29.4'
  };
}

/**
 * The download page loads a per-brand `cdn.js` that declares `cdnurl` (and often
 * `cdnurl2`) plus `apk_interval`. That interval is the archive cadence in minutes.
 */
export function parseCdnConfig(source: string): { download_hosts: string[]; apk_interval_minutes: number } {
  const hosts: string[] = [];
  for (const name of ['cdnurl', 'cdnurl2']) {
    const match = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*["']([^"']*)["']`).exec(source);
    const value = match ? match[1].trim().replace(/\/+$/, '') : '';
    if (value && !hosts.includes(value)) {
      hosts.push(value);
    }
  }
  const intervalMatch = /(?:var|let|const)\s+apk_interval\s*=\s*(\d+)/.exec(source);
  return {
    download_hosts: hosts,
    apk_interval_minutes: intervalMatch ? Number.parseInt(intervalMatch[1], 10) : 0
  };
}

/**
 * The download page names its route chunks; Vite's dep map is the reliable list.
 *
 * Sites split their routes into lazy chunks (`TheAndriod`, `mf-pages-android`,
 * …), so the Android downloader is not the page's own entry bundle. The dep map
 * and the direct script tags together cover both shapes.
 */
export function androidChunkUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const add = (reference: string) => {
    try {
      const absolute = new URL(reference, `${baseUrl.replace(/\/+$/, '')}/`).toString();
      if (!urls.includes(absolute)) {
        urls.push(absolute);
      }
    } catch {
      // Ignore references that cannot be resolved against the site.
    }
  };
  const depMap = /m\.f=\[([^\]]+)\]/.exec(html);
  if (depMap) {
    for (const match of depMap[1].matchAll(/"([^"]+\.js)"/g)) {
      add(match[1]);
    }
  }
  for (const match of html.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) {
    add(match[1]);
  }
  return urls;
}

/** Sites whose `cdn.js` is served at the root and needs a cache-busting stamp. */
export function cdnConfigUrls(baseUrl: string, timestampMs: number): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  return [`${base}/cdn.js?t=${Math.floor(timestampMs / 1000)}`, `${base}/cdn.js`];
}

export interface CdnReference {
  url: string;
  apk_interval_minutes: number;
}

/**
 * Some sites inline the download formula in the Android chunk (fixed host and
 * cadence), others load a separate `cdn.js`. Both shapes are recognised here.
 */
export function cdnReferencesFromChunk(source: string, chunkUrl: string): CdnReference[] {
  const references: CdnReference[] = [];
  for (const match of source.matchAll(/["'`](\/assets\/[^"'`]*cdn[^"'`]*\.js[^"'`]*)["'`]/gi)) {
    references.push({
      url: new URL(match[1], chunkUrl).toString(),
      apk_interval_minutes: 0
    });
  }
  return references;
}

/**
 * Fixed-host variant: the chunk hardcodes the download origin and computes the
 * slot inline, e.g. `https://wpk.example.com/apks64/DATE_mfSLOT.apk`.
 */
export function inlineDownloadSpec(source: string): { host: string; prefix: string; interval_minutes: number } | null {
  const hostMatch = /https?:\/\/([a-z0-9.-]+)\/apks64\//i.exec(source);
  // The filename is assembled at runtime (`'…_mf'+index+'apk'`), so the prefix
  // is read from the literal fragment rather than a complete `.apk` path.
  const fileMatch = /apks64\/[^"'`+]*_([a-z]{2,6})["'`+]?\s*\+\s*index/i.exec(source)
    ?? /apks64\/[^"'`]*_([a-z]{2,6})\d*\.apk/i.exec(source);
  if (!hostMatch || !fileMatch) {
    return null;
  }
  const intervalMatch = /getHours\(\)\s*\*\s*(\d+)\s*\+\s*Math\.floor\(\s*[^)]*getMinutes\(\)\s*\/\s*(\d+)\s*\)/.exec(source);
  return {
    host: `https://${hostMatch[1]}`,
    prefix: fileMatch[1].toLowerCase(),
    interval_minutes: intervalMatch ? Number.parseInt(intervalMatch[2], 10) : 0
  };
}

/**
 * Time-sliced archive slot for one moment.
 *
 * The apps publish a fresh APK every `interval` minutes; the archive index is
 * `hours * (60 / interval) + floor(minutes / interval)`.
 */
export function apkSlot(now: Date, intervalMinutes: number): number {
  const interval = Math.max(1, intervalMinutes);
  return now.getHours() * Math.floor(60 / interval) + Math.floor(now.getMinutes() / interval);
}

export function apkFileName(now: Date, prefix: string, slot: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${day}_${prefix}${slot}.apk`;
}

/**
 * Candidate URLs for now and the preceding slots.
 *
 * The newest slot is frequently not published yet, so the walk goes backwards;
 * it also wraps to the previous day because slot numbering restarts at midnight.
 */
export function candidateApkUrls(hosts: string[], prefix: string, now: Date, intervalMinutes: number, lookbackSlots = 8): string[] {
  const interval = Math.max(1, intervalMinutes);
  const urls: string[] = [];
  for (let step = 0; step < lookbackSlots; step += 1) {
    const stamp = new Date(now.getTime() - step * interval * 60_000);
    const name = apkFileName(stamp, prefix, apkSlot(stamp, interval));
    for (const host of hosts) {
      urls.push(`${host.replace(/\/+$/, '')}/apks64/${name}`);
    }
    if (stamp.getHours() === 0 && stamp.getMinutes() < interval) {
      const previous = new Date(stamp.getTime() - 60 * 60_000);
      const tail = apkFileName(previous, prefix, apkSlot(previous, interval));
      for (const host of hosts) {
        urls.push(`${host.replace(/\/+$/, '')}/apks64/${tail}`);
      }
    }
  }
  return urls;
}
