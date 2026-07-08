import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import QRCode from 'qrcode';

import { ServeOptions } from './options.js';
import { ServerRuntime } from './runtime.js';
import { renderWebAdapterScript } from './web-adapter.js';
import { redactText } from '../runtime/redaction.js';

export interface AutoVpnServer {
  origin: string;
  close(): Promise<void>;
}

export interface CreateAutoVpnServerOptions extends ServeOptions {
  runtime: ServerRuntime;
  version?: string;
  backendKind?: string;
}

const LABELED_SECRET_KEYS = new Map([
  ['cloudflare_api_token', '<Cloudflare Token>'],
  ['cloudflare_global_key', '<Cloudflare Token>'],
  ['pages_secret_admin', '<Pages Secret ADMIN>']
]);

type RedactionMode = 'full' | 'config';

function redactPayload(value: unknown, parentKey = '', mode: RedactionMode = 'full'): unknown {
  if (typeof value === 'string') {
    const label = LABELED_SECRET_KEYS.get(parentKey.toLowerCase());
    if (label) {
      return value ? label : '';
    }
    return mode === 'config' ? value : redactText(value);
  }
  if (value === null || ['number', 'boolean'].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item, parentKey, mode));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactPayload(item, key, mode)])
    );
  }
  return null;
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown, mode: RedactionMode = 'full'): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(redactPayload(payload, '', mode)));
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function rendererRoot(): string {
  return path.resolve(fileURLToPath(new URL('../web/renderer', import.meta.url)));
}

async function writeStaticFile(response: http.ServerResponse, statusCode: number, filePath: string, body?: string | Buffer): Promise<void> {
  const payload = body ?? await fs.readFile(filePath);
  response.writeHead(statusCode, { 'Content-Type': contentType(filePath) });
  response.end(payload);
}

async function serveRendererIndex(response: http.ServerResponse): Promise<void> {
  const indexPath = path.join(rendererRoot(), 'index.html');
  const html = await fs.readFile(indexPath, 'utf8');
  const injected = html
    .replace('<body data-page="dashboard">', '<body data-page="dashboard" data-runtime="web">')
    .replace(
      '<script type="module" src="./app.js"></script>',
      '<script src="/web-adapter.js"></script>\n    <script type="module" src="./app.js"></script>'
    );
  await writeStaticFile(response, 200, indexPath, injected);
}

async function serveRendererAsset(url: URL, response: http.ServerResponse): Promise<boolean> {
  if (url.pathname === '/') {
    await serveRendererIndex(response);
    return true;
  }
  const decodedPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!decodedPath || decodedPath.includes('..') || path.isAbsolute(decodedPath)) {
    return false;
  }
  const filePath = path.join(rendererRoot(), decodedPath);
  const relative = path.relative(rendererRoot(), filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  try {
    await writeStaticFile(response, 200, filePath);
    return true;
  } catch {
    return false;
  }
}

function timingSafeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(request: http.IncomingMessage, url: URL, auth: ServeOptions['auth']): boolean {
  if (!auth.enabled) {
    return true;
  }
  const authorization = request.headers.authorization ?? '';
  if (authorization.startsWith('Bearer ') && timingSafeEqualText(authorization.slice(7), auth.token)) {
    return true;
  }
  return timingSafeEqualText(url.searchParams.get('token') ?? '', auth.token);
}

function clientIp(request: http.IncomingMessage): string {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1024 * 1024) {
      throw new Error('request_body_too_large');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export async function createAutoVpnServer(options: CreateAutoVpnServerOptions): Promise<AutoVpnServer> {
  const authFailures = new Map<string, { failures: number; banned: boolean }>();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${options.host}:${options.port}`}`);
    const ip = clientIp(request);
    const authState = authFailures.get(ip);

    if (authState?.banned) {
      writeJson(response, 403, { ok: false, error: 'ip_banned' });
      return;
    }

    try {
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const password = String((await readJsonBody(request)).password ?? '');
        if (!options.auth.enabled || !options.auth.password || timingSafeEqualText(password, options.auth.password)) {
          authFailures.delete(ip);
          writeJson(response, 200, { ok: true, token: options.auth.token });
          return;
        }
        const nextFailures = (authState?.failures ?? 0) + 1;
        if (nextFailures >= options.auth.maxAttempts) {
          authFailures.set(ip, { failures: nextFailures, banned: true });
          writeJson(response, 403, { ok: false, error: 'ip_banned' });
          return;
        }
        authFailures.set(ip, { failures: nextFailures, banned: false });
        writeJson(response, 401, {
          ok: false,
          error: 'invalid_password',
          attemptsRemaining: options.auth.maxAttempts - nextFailures
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/web-adapter.js') {
        await writeStaticFile(response, 200, 'web-adapter.js', renderWebAdapterScript({
          passwordEnabled: Boolean(options.auth.enabled && options.auth.password)
        }));
        return;
      }

      if (url.pathname.startsWith('/api/') && !isAuthorized(request, url, options.auth)) {
        writeJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        writeJson(response, 200, {
          status: 'ok',
          version: options.version ?? '',
          backend: options.backendKind ?? '',
          projectRoot: options.projectRoot
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        writeJson(response, 200, await options.runtime.loadState(), 'config');
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/profile') {
        const body = await readJsonBody(request);
        writeJson(response, 200, await options.runtime.saveProfile?.(body) ?? { ok: false, error: 'profile_save_unavailable' }, 'config');
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/qr') {
        const body = await readJsonBody(request);
        const text = String(body.text ?? '');
        writeJson(response, 200, {
          ok: true,
          dataUrl: await QRCode.toDataURL(text, { margin: 1, width: 220 })
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });
        response.flushHeaders();
        const unsubscribe = options.runtime.subscribe?.((event) => {
          response.write(`data: ${JSON.stringify(redactPayload(event))}\n\n`);
        }) ?? (() => {});
        request.on('close', unsubscribe);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/runs') {
        const body = await readJsonBody(request);
        writeJson(response, 202, await options.runtime.startRun?.({
          skipDeploy: Boolean(body.skipDeploy),
          skipVerify: Boolean(body.skipVerify),
          resumeLatest: Boolean(body.resumeLatest)
        }) ?? { ok: false, error: 'run_unavailable' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/runs/current/stop') {
        writeJson(response, 200, await options.runtime.stopRun?.() ?? { ok: true, requested: false });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/runs/retry-stage') {
        const body = await readJsonBody(request);
        writeJson(response, 202, await options.runtime.startRetry?.({
          artifactDir: String(body.artifactDir ?? ''),
          stage: String(body.stage ?? '')
        }) ?? { ok: false, error: 'retry_stage_unavailable' });
        return;
      }

      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (await serveRendererAsset(url, response)) {
          return;
        }
      }

      writeJson(response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const originHost = options.host === '0.0.0.0' ? '127.0.0.1' : options.host;

  return {
    origin: `http://${originHost}:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })
  };
}
