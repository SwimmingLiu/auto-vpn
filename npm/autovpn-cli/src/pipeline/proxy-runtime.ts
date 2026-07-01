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
