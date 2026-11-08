import fs from 'node:fs';
import path from 'node:path';

import type { ApkDiscovery } from './apk-discovery.js';

/**
 * Persistent brand fingerprint cache.
 *
 * Inspecting an APK is expensive (a 20-25 MB download plus dex parsing), while
 * the facts it yields — package, version, certificate and seed domains — only
 * change when the vendor publishes a new build. The cache keeps them on disk so
 * a run only re-inspects when the seeds stop answering, and then refreshes the
 * entry instead of starting from nothing.
 */

export interface BrandFingerprint extends ApkDiscovery {
  /** When this fingerprint was last confirmed against a working seed. */
  verified_at: string;
  /** Brand key this fingerprint belongs to. */
  brand: string;
}

export interface FingerprintStoreOptions {
  /** Directory holding the cache; created on demand. */
  cacheDir: string;
  now?: () => Date;
  /** How long a fingerprint is trusted without re-verification. */
  maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * File name for one brand's fingerprint.
 *
 * Brand keys are Chinese product names, which `[^\w.-]` would collapse to a
 * single underscore; the code-point hex keeps them distinct and filesystem-safe.
 */
function cachePath(cacheDir: string, brand: string): string {
  const safe = [...String(brand)].map((char) => (
    /[\w.-]/.test(char) ? char : `u${char.codePointAt(0)?.toString(16)}`
  )).join('');
  return path.join(cacheDir, `brand-${safe}.json`);
}

export class FingerprintStore {
  private readonly cacheDir: string;
  private readonly now: () => Date;
  private readonly maxAgeMs: number;

  constructor(options: FingerprintStoreOptions) {
    this.cacheDir = options.cacheDir;
    this.now = options.now ?? (() => new Date());
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  read(brand: string): BrandFingerprint | null {
    const file = cachePath(this.cacheDir, brand);
    if (!fs.existsSync(file)) {
      return null;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as BrandFingerprint;
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.seed_domains)) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  /** Returns a fingerprint when it is present and still within its trust window. */
  /**
   * Returns the fingerprint when it is still inside its trust window.
   *
   * A stale entry still carries usable seed domains, so callers fall back to
   * `read()` and only re-inspect the APK when the seeds stop answering.
   */
  readFresh(brand: string): BrandFingerprint | null {
    const payload = this.read(brand);
    if (!payload) {
      return null;
    }
    const verifiedAt = Date.parse(String(payload.verified_at ?? ''));
    if (!Number.isFinite(verifiedAt)) {
      return null;
    }
    return this.now().getTime() - verifiedAt <= this.maxAgeMs ? payload : null;
  }

  write(brand: string, discovery: ApkDiscovery): BrandFingerprint {
    const payload: BrandFingerprint = {
      ...discovery,
      brand,
      verified_at: this.now().toISOString()
    };
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(cachePath(this.cacheDir, brand), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
  }

  /** Records that a cached fingerprint still works, without re-reading the APK. */
  touch(brand: string): void {
    const payload = this.read(brand);
    if (!payload) {
      return;
    }
    this.write(brand, payload);
  }
}

/**
 * The cache lives next to the profile, so it travels with the profile and is
 * cleared by the same operations that reset state.
 */
export function resolveFingerprintCacheDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'brand-fingerprints');
}
