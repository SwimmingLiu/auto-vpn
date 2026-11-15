/**
 * The live mihomo that Clash Verge Rev runs, reached over its unix socket.
 *
 * A write to the extension script only becomes visible after Verge rebuilds
 * the profile, and a rebuild that silently did nothing is the failure mode the
 * operator cannot see: the app looks fine and traffic keeps leaving through the
 * old route. Everything here answers "is the new exit actually loaded", from
 * the kernel's side rather than from the app's UI.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const SERVICE_SOCKET_ROOT = '/var/run/clash-verge-service/users';

export interface ProxyRecord {
  name?: string;
  type?: string;
  now?: string;
  all?: string[];
  alive?: boolean;
}

export type ProxyMap = Record<string, ProxyRecord>;

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.AUTOVPN_MIHOMO_SOCKET ?? '').trim();
  if (override) return override;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(SERVICE_SOCKET_ROOT, String(uid), 'verge-mihomo.sock');
}

/**
 * The socket Verge created, or '' when the service is not running.
 *
 * The service puts the core socket under the invoking user's uid, so the
 * default is right for the normal case; the scan covers a Verge that was
 * started by another account or an older layout.
 */
export function findSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const preferred = defaultSocketPath(env);
  if (fs.existsSync(preferred)) return preferred;
  // An explicit path is not a hint: when AUTOVPN_MIHOMO_SOCKET names a socket
  // that is not there yet, the answer is "not yet", not "here is the machine's
  // real one". Scanning past it made a test hit the live core and made a
  // caller that asked for a specific socket silently talk to another.
  if (String(env.AUTOVPN_MIHOMO_SOCKET ?? '').trim()) return '';
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(SERVICE_SOCKET_ROOT);
  } catch {
    return '';
  }
  for (const entry of entries) {
    const candidate = path.join(SERVICE_SOCKET_ROOT, entry, 'verge-mihomo.sock');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

export interface MihomoResponse {
  status: number;
  body: string;
}

export function requestMihomo(
  socketPath: string,
  method: string,
  urlPath: string,
  payload?: unknown,
  timeoutMs = 5_000,
): Promise<MihomoResponse> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const request = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
        timeout: timeoutMs,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    request.on('timeout', () => request.destroy(new Error('mihomo API timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

export async function readProxies(socketPath: string): Promise<ProxyMap> {
  const response = await requestMihomo(socketPath, 'GET', '/proxies');
  if (response.status !== 200) {
    throw new Error(`mihomo /proxies returned ${response.status}`);
  }
  const parsed = JSON.parse(response.body) as { proxies?: ProxyMap };
  return parsed.proxies ?? {};
}

export async function selectProxy(socketPath: string, group: string, name: string): Promise<void> {
  const response = await requestMihomo(socketPath, 'PUT', `/proxies/${encodeURIComponent(group)}`, { name });
  if (response.status !== 204 && response.status !== 200) {
    throw new Error(`mihomo refused to select ${name} in ${group} (${response.status})`);
  }
}

export interface DelayResult {
  delay: number;
}

/**
 * A chain node's first connection is cold: the core dials the entrance, the
 * entrance dials the exit, and only then does the probe URL answer. Right after
 * a profile rebuild that handshake has been seen to outlast a single 5 s
 * budget, which reported a working chain as dead. The retry is not a longer
 * timeout — the first attempt leaves the entrance and exit connections open,
 * so the second one measures a warm chain.
 */
export async function probeDelay(
  socketPath: string,
  name: string,
  options: { url?: string; timeoutMs?: number; attempts?: number } = {},
): Promise<DelayResult> {
  const url = options.url ?? 'https://api.ipify.org';
  const timeout = options.timeoutMs ?? 5_000;
  const attempts = Math.max(1, options.attempts ?? 2);
  const query = `?url=${encodeURIComponent(url)}&timeout=${timeout}`;
  let lastError: unknown = new Error('probe failed');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await requestMihomo(socketPath, 'GET', `/proxies/${encodeURIComponent(name)}/delay${query}`, undefined, timeout + 2_000);
      const parsed = JSON.parse(response.body || '{}') as { delay?: number; message?: string };
      if (response.status !== 200 || typeof parsed.delay !== 'number') {
        throw new Error(parsed.message ? `probe failed: ${parsed.message}` : `probe failed (${response.status})`);
      }
      return { delay: parsed.delay };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the core socket to appear, then return its path.
 *
 * Quitting Clash Verge removes the socket, and the restarted app takes longer
 * to recreate it than the quit itself: resolving the path once, before the
 * wait, looked the restart in the face and reported "not live" for a chain
 * that came up ten seconds later.
 */
export async function waitForSocket(
  env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<string> {
  const interval = options.intervalMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const found = findSocketPath(env);
    if (found) return found;
    if (Date.now() >= deadline) return '';
    await sleep(interval);
  }
}

export async function waitForProxies(
  socketPath: string,
  predicate: (proxies: ProxyMap) => boolean,
  options: WaitOptions,
): Promise<ProxyMap | null> {
  const interval = options.intervalMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + options.timeoutMs;
  let last: ProxyMap | null = null;
  for (;;) {
    try {
      last = await readProxies(socketPath);
      if (predicate(last)) return last;
    } catch {
      // The core disappears while Verge restarts; that is expected here.
    }
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

/** Node names the extension added, as they appear in the live core. */
export function injectedNames(proxies: ProxyMap, exitGroup: string): string[] {
  const group = proxies[exitGroup];
  return Array.isArray(group?.all) ? [...group.all] : [];
}
