/**
 * The proxy links `autovpn verge` accepts.
 *
 * A link is `scheme://userinfo@host:port#name`, where the userinfo is
 * `user` or `user:secret`. The URI form is not
 * uniform — `socks5h` and `https` are what people and panels write, but mihomo
 * only knows `socks5` / `http`, and it rejects the whole config for a type it
 * does not recognize. The normalization therefore happens here, once.
 *
 * Error messages report a line number and never the line: the line holds the
 * credential, and the message goes to a terminal.
 */

export type ExitType = 'socks5' | 'http';

/** One mihomo proxy, as the extension script's `STATIC_EXITS` holds it. */
export interface StaticExit {
  name: string;
  type: ExitType;
  server: string;
  port: number;
  username?: string;
  /** mihomo's credential field, under a name that is safe to log. */
  credential?: string;
  tls?: boolean;
  udp?: boolean;
}

const PROXY_TYPES: Record<string, ExitType> = {
  socks5: 'socks5',
  socks5h: 'socks5',
  socks: 'socks5',
  http: 'http',
  https: 'http',
  'http+tls': 'http',
};

const DEFAULT_PORTS: Record<string, number> = { socks5: 1080, http: 80, https: 443, 'http+tls': 443 };

const SUPPORTED = 'socks5, socks5h, socks, http, https, http+tls';

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // An unencoded `%` in a credential is legal input; use it as written.
    return value;
  }
}

function portDigits(text: string): boolean {
  // Decimal only: Number('1e3') and Number('0x10') are both plausible ports.
  return /^\d+$/.test(text);
}

export function parseExitUri(raw: string): StaticExit {
  const line = String(raw).trim();
  if (!line) {
    throw new Error('empty line');
  }

  // The fragment is the display name. A `#` inside the credential must be
  // written %23; that is the URI rule, not a choice made here.
  const hash = line.indexOf('#');
  const name = hash >= 0 ? decode(line.slice(hash + 1).trim()) : '';
  const body = hash >= 0 ? line.slice(0, hash) : line;

  const schemeAt = body.indexOf('://');
  if (schemeAt <= 0) {
    throw new Error(`missing scheme://  (supported: ${SUPPORTED})`);
  }
  const scheme = body.slice(0, schemeAt).toLowerCase();
  // Never echo what sits before `://`: a line missing its scheme carries the
  // credential there. `Object.hasOwn` rather than `in`, so `constructor://`
  // cannot walk the prototype chain.
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || !Object.hasOwn(PROXY_TYPES, scheme)) {
    throw new Error(`unsupported proxy scheme (supported: ${SUPPORTED})`);
  }

  let rest = body.slice(schemeAt + 3);
  const slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.slice(0, slash);
  const question = rest.indexOf('?');
  if (question >= 0) rest = rest.slice(0, question);

  let username = '';
  let credential = '';
  let hostPort = rest;
  // Split on the last `@`, as curl does, so an unescaped one in the credential
  // still parses.
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const userInfo = rest.slice(0, at);
    hostPort = rest.slice(at + 1);
    const colon = userInfo.indexOf(':');
    if (colon >= 0) {
      username = userInfo.slice(0, colon);
      credential = userInfo.slice(colon + 1);
    } else {
      username = userInfo;
    }
    username = decode(username);
    credential = decode(credential);
  }

  let host = hostPort;
  let portText = '';
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close < 0) {
      throw new Error('IPv6 host is missing its closing bracket');
    }
    host = hostPort.slice(0, close + 1);
    const tail = hostPort.slice(close + 1);
    if (tail.startsWith(':')) portText = tail.slice(1);
    else if (tail) throw new Error('unexpected text after the IPv6 host');
  } else {
    const colon = hostPort.lastIndexOf(':');
    if (colon >= 0) {
      host = hostPort.slice(0, colon);
      portText = hostPort.slice(colon + 1);
    }
  }

  if (!host) {
    throw new Error('missing host');
  }
  if (portText !== '' && !portDigits(portText)) {
    throw new Error('port must be an integer between 1 and 65535');
  }
  const port = portText === '' ? DEFAULT_PORTS[scheme] : Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('port must be an integer between 1 and 65535');
  }

  const exit: StaticExit = {
    name: name || `${host}:${port}`,
    type: PROXY_TYPES[scheme],
    server: host,
    port,
  };
  if (scheme === 'https' || scheme === 'http+tls') exit.tls = true;
  if (username) exit.username = username;
  if (credential) exit.credential = credential;
  exit.udp = exit.type === 'socks5';
  return exit;
}

/**
 * Parse every link in a text block. Blank lines, `#` comments and `//`
 * comments are skipped; a bad line aborts with its number only.
 */
export function readExitText(text: string): StaticExit[] {
  const exits: StaticExit[] = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) return;
      try {
        exits.push(parseExitUri(trimmed));
      } catch (error) {
        throw new Error(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  if (exits.length === 0) {
    throw new Error('no proxy links found');
  }
  return exits;
}

/** The only form of an exit that may be printed. */
export function describeExit(exit: StaticExit): string {
  const credentials = exit.username || exit.credential ? '***@' : '';
  return `${exit.type}://${credentials}${exit.server}:${exit.port}`;
}

/**
 * A curl-compatible proxy URL built from the parsed fields.
 *
 * The raw line cannot go to curl: an unencoded `:` or `#` in the credential
 * makes curl split the authority differently than this parser does.
 */
export function curlProxyUrl(exit: StaticExit): string {
  const scheme = exit.type === 'http' ? (exit.tls ? 'https' : 'http') : 'socks5h';
  let credentials = '';
  if (exit.username !== undefined) {
    credentials = encodeURIComponent(exit.username);
    if (exit.credential !== undefined) credentials += `:${encodeURIComponent(exit.credential)}`;
    credentials += '@';
  }
  return `${scheme}://${credentials}${exit.server}:${exit.port}`;
}
