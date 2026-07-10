import { spawn as defaultSpawn, ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface VmessPayload {
  add: string;
  port: string | number;
  id: string;
  aid?: string | number;
  scy?: string;
  net?: string;
  tls?: string;
  sni?: string;
  host?: string;
  path?: string;
  [key: string]: unknown;
}

export interface MihomoRuntimePorts {
  mixedPort: number;
  controllerPort: number;
}

type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;
type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
}>;

export interface MihomoRuntime {
  process: ChildProcess;
  proxies: Record<'http' | 'https', string>;
  configPath: string;
  controllerUrl: string;
  proxyName: string;
  close: () => Promise<void>;
}

export interface OpenMihomoRuntimeOptions {
  runtimePath?: string;
  startupWaitSeconds?: number;
  mixedPort?: number;
  controllerPort?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  waitForPort?: (port: number, timeoutSeconds: number) => Promise<void>;
  selectProxy?: (controllerUrl: string, proxyName: string, timeoutSeconds: number) => Promise<void>;
}

export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy'
] as const;

const MIHOMO_DELAY_TIMEOUT_MAX_MS = 30_000;

function padBase64(encoded: string): string {
  return encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
}

export function parseVmessLink(link: string): VmessPayload {
  const encoded = link.startsWith('vmess://') ? link.slice('vmess://'.length) : link;
  return JSON.parse(Buffer.from(padBase64(encoded), 'base64url').toString('utf8')) as VmessPayload;
}

export function buildMihomoRuntimeConfig(payload: VmessPayload, ports: MihomoRuntimePorts): Record<string, unknown> {
  const network = String(payload.net ?? 'ws');
  const tlsEnabled = String(payload.tls ?? '').toLowerCase() === 'tls';
  const proxyName = 'runtime-node';
  const proxy: Record<string, unknown> = {
    name: proxyName,
    type: 'vmess',
    server: payload.add,
    port: Number(payload.port),
    uuid: payload.id,
    alterId: Number(String(payload.aid ?? '0') || 0),
    cipher: payload.scy ?? 'auto',
    udp: false,
    network
  };

  if (tlsEnabled) {
    proxy.tls = true;
    proxy['skip-cert-verify'] = true;
    proxy.servername = payload.sni || payload.host || payload.add;
  }

  if (network === 'ws') {
    proxy['ws-opts'] = {
      path: payload.path ?? '',
      headers: { Host: payload.host || payload.add || '' }
    };
  }

  return {
    'mixed-port': ports.mixedPort,
    'allow-lan': false,
    mode: 'global',
    'log-level': 'silent',
    ipv6: false,
    'external-controller': `127.0.0.1:${ports.controllerPort}`,
    dns: { enable: false },
    proxies: [proxy],
    'proxy-groups': [
      {
        name: 'GLOBAL',
        type: 'select',
        proxies: [proxyName]
      }
    ],
    rules: ['MATCH,GLOBAL']
  };
}

export function stripProxyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const stripped = { ...env };
  for (const key of PROXY_ENV_KEYS) {
    delete stripped[key];
  }
  return stripped;
}

function requireFetch(fetchImpl?: FetchLike): FetchLike {
  const selected = fetchImpl ?? globalThis.fetch?.bind(globalThis) as FetchLike | undefined;
  if (!selected) {
    throw new Error('Node proxy runtime requires fetch support');
  }
  return selected;
}

function requireOkResponse(response: Awaited<ReturnType<FetchLike>>, context: string): void {
  if (response.ok === false || Number(response.status ?? 200) >= 400) {
    throw new Error(`${context} failed with status ${response.status ?? 0} ${response.statusText ?? ''}`.trim());
  }
}

export async function selectMihomoProxy(
  controllerUrl: string,
  proxyName: string,
  _timeoutSeconds: number,
  options: { fetch?: FetchLike } = {}
): Promise<void> {
  if (!controllerUrl) {
    return;
  }
  const fetchImpl = requireFetch(options.fetch);
  const response = await fetchImpl(`${controllerUrl}/proxies/GLOBAL`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: proxyName })
  });
  requireOkResponse(response, 'mihomo proxy selection');
}

export async function probeMihomoProxyDelay(
  controllerUrl: string,
  proxyName: string,
  probeUrl: string,
  timeoutSeconds: number,
  options: { fetch?: FetchLike } = {}
): Promise<number> {
  const fetchImpl = requireFetch(options.fetch);
  const url = new URL(`${controllerUrl}/proxies/${encodeURIComponent(proxyName)}/delay`);
  const timeoutMs = Math.min(MIHOMO_DELAY_TIMEOUT_MAX_MS, Math.max(1, Math.trunc(timeoutSeconds * 1000)));
  url.searchParams.set('timeout', String(timeoutMs));
  url.searchParams.set('url', probeUrl);
  const response = await fetchImpl(url.toString(), { method: 'GET' });
  requireOkResponse(response, 'mihomo proxy delay probe');
  const payload = await response.json?.();
  const delay = Number((payload as { delay?: unknown } | undefined)?.delay ?? -1);
  if (!Number.isFinite(delay) || delay < 0) {
    throw new Error(`mihomo returned invalid delay payload: ${JSON.stringify(payload)}`);
  }
  return Math.trunc(delay);
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (typeof address === 'object' && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error('failed to allocate a free local port'));
      });
    });
  });
}

async function canConnectToPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function defaultWaitForPort(port: number, timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + Math.max(timeoutSeconds, 0.1) * 1000;
  while (Date.now() < deadline) {
    if (await canConnectToPort(port)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`proxy port ${port} did not open in time`);
}

async function closeChildProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.killed) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (process.exitCode === null && !process.killed) {
        process.kill('SIGKILL');
      }
      resolve();
    }, 2000);
    process.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    process.kill('SIGTERM');
  });
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

async function firstExistingFile(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (candidate && await fileExists(candidate)) {
      return candidate;
    }
  }
  return '';
}

function mihomoInstallCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const homeDir = String(env.HOME ?? env.USERPROFILE ?? '').trim();
  return [
    homeDir ? path.join(homeDir, 'clashctl', 'bin', 'mihomo') : '',
    '/opt/homebrew/bin/mihomo',
    '/usr/local/bin/mihomo',
    '/usr/bin/mihomo'
  ];
}

async function resolveMihomoCommand(runtimePath?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidate = String(runtimePath ?? '').trim();
  if (!candidate) {
    return await firstExistingFile(mihomoInstallCandidates(env)) || 'mihomo';
  }
  try {
    const info = await stat(candidate);
    if (info.isFile()) {
      return candidate;
    }
    if (info.isDirectory() && path.basename(candidate) === 'runtime') {
      return await firstExistingFile(mihomoInstallCandidates(env)) || 'mihomo';
    }
  } catch {
    if (path.basename(candidate) === 'runtime') {
      return await firstExistingFile(mihomoInstallCandidates(env)) || 'mihomo';
    }
  }
  return candidate;
}

export async function openMihomoRuntime(link: string, options: OpenMihomoRuntimeOptions = {}): Promise<MihomoRuntime> {
  const startupWaitSeconds = Number(options.startupWaitSeconds ?? 1);
  const mixedPort = Number.isInteger(options.mixedPort) && Number(options.mixedPort) > 0
    ? Number(options.mixedPort)
    : await findFreePort();
  const controllerPort = Number.isInteger(options.controllerPort) && Number(options.controllerPort) > 0
    ? Number(options.controllerPort)
    : await findFreePort();

  const proxyName = 'runtime-node';
  const controllerUrl = `http://127.0.0.1:${controllerPort}`;
  const payload = parseVmessLink(link);
  const config = buildMihomoRuntimeConfig(payload, { mixedPort, controllerPort });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'autovpn-mihomo-'));
  const configPath = path.join(tempDir, 'config.json');
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  const command = await resolveMihomoCommand(options.runtimePath, options.env ?? process.env);
  const child = (options.spawn ?? defaultSpawn)(command, ['-f', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: stripProxyEnv(options.env ?? process.env)
  });
  let rejectStartupError: ((error: Error) => void) | undefined;
  const startupError = new Promise<never>((_resolve, reject) => {
    rejectStartupError = reject;
  });
  const onStartupError = (error: Error): void => {
    rejectStartupError?.(error);
  };
  child.once('error', onStartupError);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await closeChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  };

  try {
    const waitForPort = options.waitForPort ?? defaultWaitForPort;
    await Promise.race([waitForPort(mixedPort, startupWaitSeconds + 4), startupError]);
    await Promise.race([waitForPort(controllerPort, startupWaitSeconds + 4), startupError]);
    await Promise.race([(options.selectProxy ?? ((url, name, timeoutSeconds) => selectMihomoProxy(url, name, timeoutSeconds)))(
      controllerUrl,
      proxyName,
      startupWaitSeconds + 4
    ), startupError]);
    child.off('error', onStartupError);
    child.on('error', () => {});
  } catch (error) {
    child.off('error', onStartupError);
    child.on('error', () => {});
    await close();
    if (
      error instanceof Error
      && error.name !== 'AbortError'
      && /^proxy port \d+ did not open in time$/.test(error.message)
    ) {
      (error as Error & { code?: string }).code = 'AUTOVPN_INTERNAL_TIMEOUT';
    }
    throw error;
  }

  return {
    process: child,
    proxies: {
      http: `http://127.0.0.1:${mixedPort}`,
      https: `http://127.0.0.1:${mixedPort}`
    },
    configPath,
    controllerUrl,
    proxyName,
    close
  };
}
