// Find out what the vendor actually says when the sweep's login is refused.
//
// Use this before trusting a sweep's retirement count: `accounts refresh-expiry`
// reports `login rejected` for every account it retires, and that string is the
// store's label, not the vendor's words. The vendor's answer is encrypted and
// the diagnostics redact it (it can carry a token), so read it here — decrypt
// with the key `/api/eversion` proves and print only code/msg/level/endtime.
//
// Written after a sweep retired 49 heidong rows; the answer turned out to be
// `{"code":128,"msg":"登录失败,账号或者密码错误"}`, a genuine credential
// rejection, so the retirements were correct. Run this before restoring.
import { DatabaseSync } from 'node:sqlite';

const mod = await import('/www/server/nodejs/v22.20.0/lib/node_modules/@swimmingliu/autovpn/dist/pipeline/credential-source.js');
const { fetchCredentialSourceLinks, fingerprintKeyFor, createFingerprintMemo, credentialKeyCandidates } = mod;
const { brandSite } = await import('/www/server/nodejs/v22.20.0/lib/node_modules/@swimmingliu/autovpn/dist/pool/brands.js');
const { decryptPayload } = await import('/www/server/nodejs/v22.20.0/lib/node_modules/@swimmingliu/autovpn/dist/pipeline/extract.js');
const { FingerprintStore, resolveFingerprintCacheDir } = await import('/www/server/nodejs/v22.20.0/lib/node_modules/@swimmingliu/autovpn/dist/pipeline/brand-cache.js');
const { resolveUserRuntimeRoot } = await import('/www/server/nodejs/v22.20.0/lib/node_modules/@swimmingliu/autovpn/dist/runtime/paths.js');

const env = process.env;
// Args: [brand] [limit] [backend_brand]. Defaults mirror the deployment host's
// 黑洞 row, which reads the 雷霆 data plane.
const BRAND = process.argv[2] ?? 'heidong';
const LIMIT = Math.max(1, Number(process.argv[3] ?? 25));
const BACKEND = process.argv[4] ?? (BRAND === 'heidong' ? 'leiting' : '');
const store = new FingerprintStore({ cacheDir: resolveFingerprintCacheDir(resolveUserRuntimeRoot(env)), now: () => new Date() });
const memo = createFingerprintMemo(store, fingerprintKeyFor(BRAND, { official_site: 'x', ...(BACKEND ? { brand_override: BACKEND } : {}) }));
const keys = credentialKeyCandidates({ official_site: 'x' }, memo.get() ?? undefined);

const db = new DatabaseSync(process.env.VPN_AUTOMATION_ACCOUNTS_DB ?? '/home/lighthouse/.auto-vpn/accounts.db');
const accounts = db.prepare(
  "SELECT id,account,password FROM accounts WHERE brand=? AND status='active' ORDER BY id LIMIT ?"
).all(BRAND, LIMIT);

function decodeLogin(bodies) {
  let key = null;
  for (const b of bodies) {
    if (!b.url.includes('eversion')) continue;
    for (const k of keys) {
      try { JSON.parse(decryptPayload(b.body, k)); key = k; break; } catch {}
    }
    if (key) break;
  }
  if (!key) return { note: 'key unresolved' };
  const login = bodies.find((b) => /eapilogin|\/login/i.test(b.url));
  if (!login) return { note: 'no login call' };
  try {
    const plain = JSON.parse(decryptPayload(login.body, key));
    return { code: plain.code, msg: String(plain.msg ?? '').slice(0, 40), level: plain.level, endtime: plain.endtime };
  } catch { return { note: 'login body not JSON' }; }
}

const tally = new Map();
for (const acct of accounts) {
  const bodies = [];
  const loggingFetch = async (url, init) => {
    const res = await globalThis.fetch(url, init);
    bodies.push({ url: String(url), body: await res.clone().text().catch(() => '') });
    return res;
  };
  const out = await fetchCredentialSourceLinks({
    source_name: BRAND,
    source: {
      mode: 'credential', official_site: brandSite(BRAND),
      ...(BACKEND ? { backend_brand: BACKEND } : {}),
      account: acct.account, password: acct.password, platforms: ['android'],
      max_iterations: 1, areas_per_round: 1, plateau_limit: 1
    }
  }, { env, memo, fingerprintStore: store, fetchImpl: loggingFetch });
  const d = out.diagnostics;
  const answer = d.login_ok ? { code: 0 } : decodeLogin(bodies);
  const key = JSON.stringify({ ok: d.login_ok, cred: d.credential_rejected, expired: d.membership_expired, ...answer });
  tally.set(key, (tally.get(key) ?? 0) + 1);
  console.log(JSON.stringify({ id: acct.id, ...JSON.parse(key) }));
}
console.log('TALLY', JSON.stringify([...tally.entries()]));
