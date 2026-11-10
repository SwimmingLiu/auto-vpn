import net from 'node:net';
import tls from 'node:tls';

/**
 * Shared helpers for the hand-rolled HTTP transports in the pipeline.
 *
 * These transports talk to a local mihomo mixed port with raw sockets so the
 * per-node measurement path never goes through the crawl proxy (see
 * speedtest.ts / availability.ts). Everything here is deliberately small and
 * side-effect free so it can be unit-tested without a live proxy.
 */

/** Head sections larger than this are treated as a non-HTTP response. */
export const HTTP_HEAD_LIMIT_BYTES = 64 * 1024;

/** Line-oriented rendering of an HTTP response head, safe to put in an Error. */
export function httpStatusLine(head: Buffer | string): string {
  const text = typeof head === 'string' ? head : head.toString('latin1');
  const line = text.split('\r\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}...` : line;
}

/**
 * Parse the status code out of an HTTP response head.
 *
 * Returns null instead of throwing: callers invoke this from socket 'data'
 * listeners, where a throw would be an uncaught exception that takes down the
 * whole process. A captive portal / block page body simply yields null and the
 * caller fails that one link.
 */
export function safeParseHttpStatus(head: Buffer | string): number | null {
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)(?:\s|$)/i.exec(httpStatusLine(head));
  if (!match) {
    return null;
  }
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

/** Split a buffered HTTP response into its head and any already-received body bytes. */
export function splitHttpResponseHead(buffer: Buffer): { head: Buffer; body: Buffer } | undefined {
  const marker = buffer.indexOf('\r\n\r\n');
  if (marker < 0) {
    return undefined;
  }
  return {
    head: buffer.subarray(0, marker),
    body: buffer.subarray(marker + 4)
  };
}

export interface ProxyEndpoint {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  /** Ready-to-send `Basic ...` credential, or '' when the URL carries no userinfo. */
  authorization: string;
}

function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Normalize a proxy URL for the raw-socket transports.
 *
 * The old call sites used `proxy.port || 80` regardless of scheme and dropped
 * userinfo entirely. Default the port from the scheme, forward Basic
 * credentials, and reject schemes this transport cannot speak.
 */
export function parseProxyEndpoint(proxyUrl: string | URL): ProxyEndpoint {
  let proxy: URL;
  try {
    if (proxyUrl instanceof URL) {
      proxy = proxyUrl;
    } else {
      const raw = String(proxyUrl);
      proxy = new URL(raw.includes('://') ? raw : `http://${raw}`);
    }
  } catch (error) {
    throw new Error(`invalid proxy URL: ${String(proxyUrl)}`, { cause: error });
  }
  const protocol = proxy.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`unsupported proxy protocol: ${proxy.protocol}`);
  }
  const port = Number(proxy.port || (protocol === 'https:' ? 443 : 80));
  const user = decodeUserInfo(proxy.username);
  const secret = decodeUserInfo(proxy.password);
  const authorization = user || secret
    ? `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`
    : '';
  return { protocol, hostname: proxy.hostname, port, authorization };
}

function connectSocket(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`proxy connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('error', fail);
      // Keep a permanent sink: the caller attaches its request-scoped listener
      // a moment later, and an error in that gap must not be uncaught.
      socket.on('error', () => {});
      resolve(socket);
    });
    socket.once('error', fail);
  });
}

function secureProxySocket(socket: net.Socket, hostname: string, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      servername: net.isIP(hostname) ? undefined : hostname
    });
    let settled = false;
    const cleanup = (): void => {
      secureSocket.off('secureConnect', onSecureConnect);
      secureSocket.off('error', onError);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      secureSocket.destroy();
      socket.destroy();
      reject(error);
    };
    const onSecureConnect = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(secureSocket);
    };
    const onError = (error: Error): void => {
      fail(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`proxy TLS handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    secureSocket.once('secureConnect', onSecureConnect);
    secureSocket.once('error', onError);
  });
}

/**
 * Open the transport socket to the proxy, performing TLS first for https:// proxies.
 * The returned socket is owned by the caller and must be destroyed on every
 * terminal branch of the request it serves.
 */
export async function connectProxySocket(endpoint: ProxyEndpoint, timeoutMs: number): Promise<net.Socket> {
  const socket = await connectSocket(endpoint.hostname, endpoint.port, timeoutMs);
  if (endpoint.protocol === 'http:') {
    return socket;
  }
  try {
    return await secureProxySocket(socket, endpoint.hostname, timeoutMs);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export interface BoundedLogRing {
  /** Keep only the last `maxBytes` bytes; the ring never grows past that. */
  append(chunk: Buffer | string): void;
  /** Current ring content as UTF-8 text. */
  text(): string;
  /** Current ring size in bytes. */
  bytes(): number;
  clear(): void;
}

/**
 * Bounded byte ring used to retain a short diagnostic tail from a child
 * process. Reading the pipe is mandatory (an unread 64 KB pipe stalls the
 * child), but retaining all of it would grow without bound on a chatty runtime.
 */
export function createBoundedLogRing(maxBytes = 8192): BoundedLogRing {
  const limit = Math.max(1, Math.trunc(maxBytes));
  let parts: Buffer[] = [];
  let total = 0;

  const trimFront = (excess: number): void => {
    while (excess > 0 && parts.length > 0) {
      const first = parts[0];
      if (first.byteLength <= excess) {
        parts.shift();
        total -= first.byteLength;
        excess -= first.byteLength;
      } else {
        parts[0] = first.subarray(excess);
        total -= excess;
        excess = 0;
      }
    }
  };

  const compact = (): void => {
    if (parts.length > 64) {
      const merged = Buffer.concat(parts, total);
      parts = [merged];
    }
  };

  return {
    append(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (buffer.byteLength === 0) {
        return;
      }
      if (buffer.byteLength >= limit) {
        parts = [buffer.subarray(buffer.byteLength - limit)];
        total = limit;
        return;
      }
      parts.push(buffer);
      total += buffer.byteLength;
      if (total > limit) {
        trimFront(total - limit);
      }
      compact();
    },
    text(): string {
      return Buffer.concat(parts, total).toString('utf8');
    },
    bytes(): number {
      return total;
    },
    clear(): void {
      parts = [];
      total = 0;
    }
  };
}
