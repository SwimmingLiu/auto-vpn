/**
 * Shape-complete credential fixture.
 *
 * The public flow (site -> APK -> eversion -> login -> route list -> evmess)
 * has no test seam short of a fake control plane, so this module builds one:
 * every response is the AES-wrapped form the real endpoints use, and the vmess
 * payloads go through the same `add|{outbound json}` split the vendor app
 * sends. That lets a test drive `fetchCredentialSourceLinks` end to end and
 * assert on the events it emits while it runs.
 */
import crypto from 'node:crypto';

export const FIXTURE_KEY = 'abcdefgh12345678';

export function encryptControlPlane(plaintext, key = FIXTURE_KEY) {
  const keyBuffer = Buffer.from(key, 'utf8');
  const input = Buffer.from(plaintext, 'utf8');
  const padded = Buffer.concat([input, Buffer.alloc((16 - (input.length % 16)) % 16)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', keyBuffer, keyBuffer);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

/** One `ps|outbound-json` body, which is what `/api/evmess` returns. */
export function evmessBody(address, port, ps = 'fixture-node') {
  const outbound = {
    outbounds: [
      {
        protocol: 'vmess',
        settings: { vnext: [{ address, port, users: [{ id: '11111111-2222-3333-4444-555555555555', alterId: 0, security: 'auto' }] }] },
        streamSettings: { network: 'ws', security: 'tls', wsSettings: { path: '/ws' }, tlsSettings: { serverName: address } }
      }
    ]
  };
  return `${ps}|${JSON.stringify(outbound)}`;
}

export function createControlPlane(options = {}) {
  const rounds = options.rounds ?? 3;
  // Route area -> the addresses it returns per round. A route that runs dry
  // keeps answering, which is what a plateau looks like from the client.
  const perRound = options.perRound ?? {
    2: ['198.51.100.10', '198.51.100.11', '198.51.100.12'],
    3: ['198.51.100.20', '198.51.100.21', '198.51.100.22']
  };
  const requestedAreas = [];
  // The vendor picks a landing host per request, so each (channel, area) pair
  // walks its own address sequence independently. The client's round model is
  // a cursor over a fixed area list, not a full sweep, so the fixture must not
  // assume one round equals one pass over every route.
  const areaCounters = new Map();

  const routeList = {
    res: [
      {
        cid: 1,
        cname: '美国',
        open: 1,
        data: [
          { id: 2, name: '美国-洛杉矶', enable: 1, enable_desc: '' },
          { id: 3, name: '美国-圣何塞', enable: 1, enable_desc: '' }
        ]
      }
    ]
  };

  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const ok = (text) => ({ ok: true, status: 200, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) });

    if (path === '/api/eversion') {
      return ok(encryptControlPlane(JSON.stringify({
        api_links: ['https://api.example:20000'],
        api_lines: 'https://api.example:20000/nodes',
        key: FIXTURE_KEY
      })));
    }
    if (path === '/myapi/eapilogin') {
      return ok(encryptControlPlane(JSON.stringify({ code: 0, token: 'fixture-token', level: 3, endtime: '2027-01-01 00:00:00' })));
    }
    if (path === '/myapi/eapiuserinfo') {
      return ok(encryptControlPlane(JSON.stringify({ info: { level: 3, endtime: 1798761600 }, code_info: { unlimit: '0' } })));
    }
    if (path === '/nodes') {
      return ok(JSON.stringify(routeList));
    }
    if (path === '/api/evmess') {
      const area = Number(parsed.searchParams.get('area'));
      requestedAreas.push(area);
      // One round is one pass over every route by every platform. Each channel
      // asks independently, so its own counter decides which round it is in;
      // `platform` names the channel on the request.
      const caller = parsed.searchParams.get('platform') ?? 'single';
      const key = `${caller}:${area}`;
      const seen = areaCounters.get(key) ?? 0;
      areaCounters.set(key, seen + 1);
      // `rounds` caps how many distinct hosts an area hands out before it runs
      // dry; an exhausted area answers empty, which is what a plateau looks like.
      const list = (perRound[area] ?? []).slice(0, rounds);
      const address = list[seen];
      // `relabel` varies the display name per request while the node identity
      // stays fixed: a relabelled duplicate is a new raw string but the same
      // fingerprint, which is exactly what the early-stop counter must ignore.
      const ps = options.relabel ? `node-${area}-${seen}` : 'fixture-node';
      return ok(address ? encryptControlPlane(evmessBody(address, 443, ps)) : '');
    }
    return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  };

  return { fetchImpl, requestedAreas, rounds };
}
