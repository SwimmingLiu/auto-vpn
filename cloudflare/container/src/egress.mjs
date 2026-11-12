#!/usr/bin/env node
/**
 * Egress supervisor.
 *
 * The crawl stages default to `http://127.0.0.1:7897` (see `egress.ts` in the
 * CLI). On a VPS that port is whatever local proxy the operator runs. In a
 * Cloudflare Container there is no such proxy, and the shared Cloudflare egress
 * range is exactly what a vendor is most likely to throttle or block.
 *
 * So we build one: the nodes from the *already published subscription* become
 * the crawl's source IP. Each run refreshes the list, health-checks the
 * candidates against a real vendor host, and hands the survivors to mihomo in a
 * `fallback` group on 127.0.0.1:7897. The CLI needs no change at all.
 *
 * Degradation is explicit, never silent:
 *   proxy  -> at least one node reaches the vendor; crawl through it
 *   direct -> every node failed; mihomo runs a direct-only config and
 *             `/egress/status` says so, so the run log carries the reason
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EGRESS_PORT = 7897;
const CONTROLLER_PORT = 7917;
const MIHOMO_BIN = process.env.MIHOMO_BIN || '/usr/local/bin/mihomo';
const EGRESS_DIR = process.env.EGRESS_DIR || '/data/egress';
const HEALTH_PROBE_TIMEOUT_MS = 8000;
const HEALTH_CONCURRENCY = 8;
const MAX_CANDIDATE_NODES = Number(process.env.EGRESS_MAX_CANDIDATES || 40);

/** Vendor host the crawl actually needs to reach. */
export const DEFAULT_PROBE_HOST = 'https://www.16863988.com/';

export function decodeSubscriptionPayload(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  // The published worker returns random bytes for a wrong key; a real payload
  // always decodes to lines beginning with a scheme.
  const candidates = [trimmed, trimmed.replace(/-/g, '+').replace(/_/g, '/')];
  for (const candidate of candidates) {
    const padded = candidate + '='.repeat((4 - (candidate.length % 4)) % 4);
    let decoded = '';
    try {
      decoded = Buffer.from(padded, 'base64').toString('utf8');
    } catch {
      continue;
    }
    const links = decoded
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('vmess://'));
    if (links.length) return links;
  }
  return [];
}

/**
 * Fetch a subscription body with an explicit status check.
 *
 * A DNS-poisoned name (the `198.18.0.0/15` range a filtered resolver hands
 * back) does not throw: it completes the TCP connect and then dies in the TLS
 * handshake, or answers with an unrelated body. Treating that as "a
 * subscription with no nodes" is right, but it must carry the reason so the run
 * log does not read like the publisher stopped publishing.
 */
export async function fetchSubscription(url, { timeoutMs = 20000 } = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { text: '', error: `subscription responded ${response.status}` };
    }
    return { text: await response.text(), error: '' };
  } catch (error) {
    return { text: '', error: `subscription fetch failed: ${error.message}` };
  }
}

export function parseVmess(link) {
  const encoded = String(link).replace(/^vmess:\/\//, '');
  const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
  // Vendors emit url-safe base64 without padding; Buffer accepts both once padded.
  return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
}

/** A mihomo proxy entry plus the name the controller addresses it by. */
export function toMihomoProxy(link, index) {
  const payload = parseVmess(link);
  const name = `n${index}`;
  const network = String(payload.net ?? 'ws');
  const tlsEnabled = String(payload.tls ?? '').toLowerCase() === 'tls';
  const proxy = {
    name,
    type: 'vmess',
    server: String(payload.add ?? ''),
    port: Number(payload.port ?? 0),
    uuid: String(payload.id ?? ''),
    alterId: Number(String(payload.aid ?? '0') || 0),
    cipher: payload.scy ?? 'auto',
    udp: false,
    network
  };
  if (tlsEnabled) {
    proxy.tls = true;
    // The same concession the measurement path already makes: the pool is
    // served from bare IPs whose certificates rarely match the SNI.
    proxy['skip-cert-verify'] = true;
    proxy.servername = payload.sni || payload.host || payload.add;
  }
  if (network === 'ws') {
    proxy['ws-opts'] = {
      path: payload.path ?? '',
      headers: { Host: payload.host || payload.add || '' }
    };
  }
  return { name, proxy };
}

export function buildConfig(proxies, { probeUrl = DEFAULT_PROBE_HOST, direct = false } = {}) {
  const base = {
    'mixed-port': EGRESS_PORT,
    'allow-lan': false,
    mode: 'global',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': `127.0.0.1:${CONTROLLER_PORT}`,
    // mihomo only resolves node addresses here; the container resolver is
    // already the platform's, so a local one would only add a failure mode.
    dns: { enable: false }
  };
  if (direct || proxies.length === 0) {
    return {
      ...base,
      proxies: [],
      'proxy-groups': [{ name: 'EGRESS', type: 'select', proxies: ['DIRECT'] }],
      rules: ['MATCH,EGRESS']
    };
  }
  return {
    ...base,
    proxies,
    'proxy-groups': [{
      name: 'EGRESS',
      // `fallback` holds one node until it fails a health check, then moves on.
      // `url-test` would re-rank on latency every interval and flap the crawl
      // between exit IPs, which looks exactly like account takeover to a
      // vendor's risk engine.
      type: 'fallback',
      proxies: proxies.map((proxy) => proxy.name),
      url: probeUrl,
      interval: 120,
      timeout: 5000,
      lazy: false
    }],
    rules: ['MATCH,EGRESS']
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function controllerJson(pathname, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${CONTROLLER_PORT}${pathname}`, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForController(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await controllerJson('/version', 500);
    if (payload) return true;
    await sleep(100);
  }
  return false;
}

export class EgressSupervisor {
  constructor(options = {}) {
    this.dir = options.dir || EGRESS_DIR;
    this.bin = options.bin || MIHOMO_BIN;
    this.configPath = path.join(this.dir, 'config.json');
    this.child = null;
    this.state = {
      mode: 'unknown',
      nodes_total: 0,
      nodes_healthy: 0,
      healthy_names: [],
      probe_url: '',
      starts: 0,
      last_error: '',
      updated_at: ''
    };
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.killed) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
  }

  async launch(config) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');
    await this.stop();
    const child = spawn(this.bin, ['-f', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // The container's own outbound path must not be rewritten by a proxy env
      // the platform may inject; mihomo binds local ports and dials directly.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(?:https?|all|no)_proxy$/i.test(key))
      )
    });
    let tail = '';
    const append = (chunk) => { tail = (tail + String(chunk)).slice(-4096); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => { tail = `${tail}\nspawn error: ${error.message}`.slice(-4096); });
    this.child = child;
    this.state.starts += 1;
    if (!(await waitForController(15000))) {
      await this.stop();
      this.state.last_error = `mihomo did not open its controller port; output: ${tail.trim()}`;
      throw new Error(this.state.last_error);
    }
    return tail;
  }

  /**
   * Keep only the nodes that can actually reach the vendor.
   *
   * A node that answers `generate_204` but is blocked for this vendor is worse
   * than no node: it moves the failure into the middle of an 11k-request crawl.
   * Probing the real host first costs one round trip per candidate.
   */
  async probeNodes(names, probeUrl, { concurrency = HEALTH_CONCURRENCY } = {}) {
    const healthy = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, names.length)) }, async () => {
      while (cursor < names.length) {
        const name = names[cursor];
        cursor += 1;
        const query = `/proxies/${encodeURIComponent(name)}/delay`
          + `?timeout=${HEALTH_PROBE_TIMEOUT_MS}&url=${encodeURIComponent(probeUrl)}`;
        const payload = await controllerJson(query, HEALTH_PROBE_TIMEOUT_MS + 2000);
        if (payload && Number.isFinite(Number(payload.delay)) && Number(payload.delay) >= 0) {
          healthy.push({ name, delay: Number(payload.delay) });
        }
      }
    });
    await Promise.all(workers);
    healthy.sort((a, b) => a.delay - b.delay);
    return healthy;
  }

  /**
   * Build the egress for this run.
   *
   * Returns the state `/egress/status` reports and the run log records, so
   * "the crawl went out through X" is an observable fact, not an assumption.
   */
  async prepare({ subscriptionUrl, subscriptionBody, probeUrl = DEFAULT_PROBE_HOST } = {}) {
    this.state = {
      mode: 'unknown',
      nodes_total: 0,
      nodes_healthy: 0,
      healthy_names: [],
      probe_url: probeUrl,
      starts: this.state.starts,
      last_error: '',
      updated_at: new Date().toISOString()
    };

    let text = String(subscriptionBody ?? '');
    if (!text && subscriptionUrl) {
      const fetched = await fetchSubscription(subscriptionUrl);
      text = fetched.text;
      if (fetched.error) this.state.last_error = fetched.error;
    }

    const entries = decodeSubscriptionPayload(text)
      .map((link, index) => {
        try {
          return toMihomoProxy(link, index);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((entry) => entry.proxy.server && entry.proxy.port)
      // The publisher's order is already speed-ranked, so the first candidates
      // are the ones most likely to pass.
      .slice(0, MAX_CANDIDATE_NODES);

    this.state.nodes_total = entries.length;

    if (entries.length === 0) {
      const reason = this.state.last_error || 'subscription carried no usable vmess nodes';
      await this.launch(buildConfig([], { direct: true }));
      this.state.mode = 'direct';
      this.state.last_error = `${reason}; crawling direct`;
      this.state.updated_at = new Date().toISOString();
      return this.state;
    }

    // Phase 1: start every candidate so the controller can health-check them.
    await this.launch(buildConfig(entries.map((entry) => entry.proxy), { probeUrl }));
    const healthy = await this.probeNodes(entries.map((entry) => entry.name), probeUrl);

    if (healthy.length === 0) {
      await this.launch(buildConfig([], { direct: true }));
      this.state.mode = 'direct';
      this.state.last_error = `none of ${entries.length} nodes reached ${probeUrl}; crawling direct`;
      this.state.updated_at = new Date().toISOString();
      return this.state;
    }

    // Phase 2: restart with only the survivors, fastest first.
    const byName = new Map(entries.map((entry) => [entry.name, entry.proxy]));
    const survivors = healthy.map((hit) => byName.get(hit.name)).filter(Boolean);
    await this.launch(buildConfig(survivors, { probeUrl }));

    this.state.mode = 'proxy';
    this.state.nodes_healthy = survivors.length;
    this.state.healthy_names = healthy.map((hit) => hit.name);
    this.state.updated_at = new Date().toISOString();
    return this.state;
  }

  status() {
    return { ...this.state };
  }
}
