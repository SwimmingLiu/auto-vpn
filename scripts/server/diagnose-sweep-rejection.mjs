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
//
// Usage, from an installed CLI (the package must be resolvable):
//   node scripts/server/diagnose-sweep-rejection.mjs [brand] [limit] [backend_brand]
// Set AUTOVPN_CLI_DIST to point at another install's dist/ (default: the
// @swimmingliu/autovpn resolved from this script's location), and
// VPN_AUTOMATION_ACCOUNTS_DB when the pool is not under the runtime root.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
function resolveCliDist() {
  const override = String(process.env.AUTOVPN_CLI_DIST ?? '').trim();
  if (override) return override;
  // A checkout: use the package built in this tree.
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'npm', 'autovpn-cli', 'dist');
  if (fs.existsSync(local)) return local;
  // An install: resolve the published package rather than guessing a host path.
  const entry = require.resolve('@swimmingliu/autovpn/package.json');
  return entry.replace(/package\.json$/, 'dist');
}

// Resolution MUST stay fatal. This tool prints a verdict about live credentials,
// so resolving to a stale or wrong build would make it confidently wrong. Do not
// wrap this in try/catch with a fallback: a MODULE_NOT_FOUND here is the correct
// outcome, and the operator should set AUTOVPN_CLI_DIST explicitly instead.
const DIST = resolveCliDist().replace(/\/$/, '');
const mod = await import(`${DIST}/pipeline/credential-source.js`);
const { fetchCredentialSourceLinks, fingerprintKeyFor, createFingerprintMemo, credentialKeyCandidates } = mod;
const { brandSite } = await import(`${DIST}/pool/brands.js`);
const { decryptPayload } = await import(`${DIST}/pipeline/extract.js`);
const { FingerprintStore, resolveFingerprintCacheDir } = await import(`${DIST}/pipeline/brand-cache.js`);
const { resolveUserRuntimeRoot } = await import(`${DIST}/runtime/paths.js`);
const { resolveAccountsDbPath } = await import(`${DIST}/pool/account-store.js`);

const env = process.env;
// Args: [brand] [limit] [backend_brand]. Defaults mirror the deployment host's
// 黑洞 row, which reads the 雷霆 data plane.
const BRAND = process.argv[2] ?? 'heidong';
const LIMIT = Math.max(1, Number(process.argv[3] ?? 25));
const BACKEND = process.argv[4] ?? (BRAND === 'heidong' ? 'leiting' : '');
const store = new FingerprintStore({ cacheDir: resolveFingerprintCacheDir(resolveUserRuntimeRoot(env)), now: () => new Date() });
const memo = createFingerprintMemo(store, fingerprintKeyFor(BRAND, { official_site: 'x', ...(BACKEND ? { brand_override: BACKEND } : {}) }));
const keys = credentialKeyCandidates({ official_site: 'x' }, memo.get() ?? undefined);

const db = new DatabaseSync(resolveAccountsDbPath(env));
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
