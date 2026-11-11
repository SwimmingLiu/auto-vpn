import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  apiDomainIndex,
  appsFingerprint,
  commonParams,
  flattenRouteGroups,
  isPlaceholderNode,
  LOGIN_SALT,
  pathAndQuery,
  selectApiDomain,
  transformNodeId
} from '../../dist/pipeline/brand-protocol.js';
import {
  apiLineValues,
  apiLinkValues,
  credentialBrandKey,
  fetchCredentialSourceLinks,
  isCredentialLoginRejection,
  loginSignature,
  membershipDate,
  parseRouteGroups,
  resolveBrandLayout,
  resolveCredentialPlatforms,
  resolveRoundPolicy,
  shouldStartRound,
  shouldStopOnPlateau
} from '../../dist/pipeline/credential-source.js';
import { selectForeignRoutes, isFreeRoute, isChinaRoute } from '../../dist/pipeline/brand-protocol.js';
import { AccountStore } from '../../dist/pool/account-store.js';
import { isCredentialSource } from '../../dist/pipeline/extract.js';

const identity = {
  seed_domains: ['https://a.example:20000', 'https://b.example:20000', 'https://c.example:20000'],
  package_name: 'com.leiting.lt1794098243',
  version_name: '3.17940.98243',
  cert_sha1: '0390D4D33CB1C0E52DEC94D26726249AF384D553',
  protocol: 'v7',
  core_version: '5.12.1',
  lite_version: '5.29.4'
};
const device = { device_id: '6C3B3033-4FAD-42FA-B8AD-DF3EDBCFA872', install_date: '2026-11-08' };

test('credential discovery sends official-site text and APK bytes through the configured upstream proxy', async (t) => {
  const requested = [];
  const events = [];
  const apk = Buffer.alloc(1_000_001);
  apk.write('PK');
  // These origins deliberately cannot resolve directly. Only the loopback
  // proxy can serve their homepage, CDN config and binary download.
  const proxy = createServer((request, response) => {
    const url = new URL(request.url);
    requested.push(url);
    if (url.pathname === '/') {
      response.end('<html>official download page</html>');
    } else if (url.pathname === '/cdn.js') {
      response.end('var cdnurl="http://download.invalid"; const apk_interval=1;');
    } else if (url.pathname.endsWith('.apk')) {
      response.setHeader('Content-Length', apk.length);
      response.end(apk);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  });
  const port = proxy.address().port;
  await fetchCredentialSourceLinks({
    source_name: 'leiting',
    source: { mode: 'credential', official_site: 'http://official.invalid', account: 'fixture-user', password: 'fixture-password', timeout_ms: 500 }
  }, {
    env: { VPN_AUTOMATION_USE_UPSTREAM_PROXY: '1', VPN_AUTOMATION_UPSTREAM_PROXY: `http://127.0.0.1:${port}` },
    eventCallback: (type, payload) => events.push({ type, ...payload })
  });
  assert.ok(requested.some((url) => url.hostname === 'official.invalid'), 'the configured proxy must receive official-site requests');
  assert.ok(requested.some((url) => url.hostname === 'download.invalid' && url.pathname.endsWith('.apk')), 'the configured proxy must receive the APK request');
  assert.ok(events.some((event) => event.type === 'extract_substage' && event.substage === 'apk_download' && event.status === 'success'), 'APK response bytes must reach inspection');
});

test('apiDomainIndex uses the character code, not the hex value', () => {
  const digest = createHash('md5').update(device.device_id).digest('hex');
  assert.equal(apiDomainIndex(device.device_id, 3), digest.charCodeAt(0) % 3);
  // A digest starting with a hex letter is where the two readings diverge: 'b'
  // is character code 98, so 98 % 3 = 2, while its hex value 11 % 3 = 2 only by
  // coincidence.  With four seeds the readings must differ.
  const hexDigit = Number.parseInt(digest[0], 16);
  if (digest.charCodeAt(0) > 57) {
    assert.notEqual(digest.charCodeAt(0) % 4 === hexDigit % 4, true);
  }
  assert.equal(apiDomainIndex(device.device_id, 4) === hexDigit % 4, false);
});

test('selectApiDomain walks back into the seed list', () => {
  const expected = identity.seed_domains[apiDomainIndex(device.device_id, 3)];
  assert.equal(selectApiDomain(identity.seed_domains, device.device_id), expected);
  assert.equal(selectApiDomain([], device.device_id), '');
});

test('appsFingerprint upper-cases the concatenation before hashing', () => {
  const expected = createHash('md5')
    .update(`${identity.cert_sha1}${device.device_id}`.toUpperCase())
    .digest('hex');
  assert.equal(appsFingerprint(identity.cert_sha1, device.device_id), expected);
});

test('commonParams keeps the field order each brand concatenates', () => {
  const params = commonParams({ identity, device, platform: 'android', timestampMs: 1700000000000, code: '' }, {});
  assert.equal(
    params,
    '&proto=v7&platform=android&core=5.12.1&lite=5.29.4&ver=3.17940.98243'
    + '&deviceid=6C3B3033-4FAD-42FA-B8AD-DF3EDBCFA872&unicode=6C3B3033-4FAD-42FA-B8AD-DF3EDBCFA872'
    + '&t=1700000000000&code=&recomm_code=&f=2026-11-08&install=2026-11-08'
    + '&token=&package=com.leiting.lt1794098243&isvip=1&unlimit=1'
    + `&apps=${appsFingerprint(identity.cert_sha1, device.device_id)}`
  );
});

test('雷霆 layout puts the viewport block before isvip and the flag after package', () => {
  const params = commonParams(
    { identity, device, platform: 'android', timestampMs: 1 },
    resolveBrandLayout({ brand: '雷霆', official_site: 'x', account: 'a', password: 'b' })
  );
  assert.ok(params.includes('&package=com.leiting.lt1794098243&newlt=1&width=392.7&height=830.9&w=1178&h=2493&isvip=1&unlimit=1&update_action=web&apps='));
});

test('旋风 layout emits vip first and omits isvip', () => {
  const params = commonParams(
    { identity, device, platform: 'android', timestampMs: 1 },
    resolveBrandLayout({ brand: '旋风', official_site: 'x', account: 'a', password: 'b' })
  );
  assert.ok(params.startsWith('&vip=1&proto=v7'));
  assert.ok(params.includes('&width=392.7'));
  assert.ok(!params.includes('&isvip='));
});

test('黑洞 layout only adds the newhd flag', () => {
  const params = commonParams(
    { identity, device, platform: 'android', timestampMs: 1 },
    resolveBrandLayout({ brand: '黑洞', official_site: 'x', account: 'a', password: 'b' })
  );
  assert.ok(params.includes('&package=com.leiting.lt1794098243&newhd=1&isvip=1&unlimit=1&apps='));
  assert.ok(!params.includes('width='));
});

test('a redirected 黑洞 row speaks the 雷霆 parameter layout', () => {
  // 黑洞's own Android channel answers the vendor's placeholder for every area,
  // and its iOS channel maps 31 areas onto 8 hosts. Sent to the 雷霆 backend the
  // same pooled account receives one machine per area, but only if the request
  // carries 雷霆's flag block: the backend decides by parameter shape, so the
  // storefront's `newhd=1` would be a different, unrecognised client.
  const params = commonParams(
    { identity, device, platform: 'android', timestampMs: 1 },
    resolveBrandLayout({ brand: '黑洞', brand_override: '雷霆', official_site: 'x' })
  );
  assert.ok(params.includes('&newlt=1'));
  assert.ok(params.includes('&update_action=web'));
  assert.ok(params.includes('width=392.7'));
  assert.ok(!params.includes('newhd=1'));
});

test('the 黑洞 layout is unchanged when no backend redirects it', () => {
  const params = commonParams(
    { identity, device, platform: 'android', timestampMs: 1 },
    resolveBrandLayout({ brand: '黑洞', official_site: 'x' })
  );
  assert.ok(params.includes('&newhd=1'));
  assert.ok(!params.includes('newlt=1'));
});

test('蜜蜂 layout adds no flag block and no viewport', () => {  const params = commonParams(
    { identity, device, platform: 'android', timestampMs: 1 },
    resolveBrandLayout({ brand: '蜜蜂', official_site: 'x', account: 'a', password: 'b' })
  );
  assert.ok(params.includes('&package=com.leiting.lt1794098243&isvip=1&unlimit=1&apps='));
  assert.ok(!params.includes('width='));
});

test('an explicit brand_flags literal overrides the inferred layout', () => {
  const layout = resolveBrandLayout({
    brand: '雷霆',
    official_site: 'x',
    account: 'a',
    password: 'b',
    brand_flags: 'newhd=1'
  });
  assert.deepEqual(layout, { afterPackage: '&newhd=1' });
});

test('loginSignature matches MD5(account + password + salt)', () => {
  const expected = createHash('md5').update(`userpass${LOGIN_SALT}`, 'utf8').digest('hex');
  assert.equal(loginSignature('user', 'pass'), expected);
});

test('pathAndQuery drops the host but keeps the query', () => {
  assert.equal(
    pathAndQuery('https://www.hy1sed.info:20000/myapi/apinodelist?level=2'),
    '/myapi/apinodelist?level=2'
  );
  assert.equal(pathAndQuery('/myapi/apinodelist?level=2'), '/myapi/apinodelist?level=2');
});

test('flattenRouteGroups mirrors the open==2 rendering rule', () => {
  const groups = [
    { cid: 48, cname: '免费线路', open: 2, nodes: [{ id: 84, name: '专线01', enable: 1, enable_desc: '' }] },
    { cid: 2, cname: '美国', open: 1, nodes: [{ id: 3, name: '加州', enable: 1, enable_desc: '' }] }
  ];
  const nodes = flattenRouteGroups(groups);
  // open==2 contributes children only; open==1 contributes the group row too.
  assert.deepEqual(nodes.map((node) => node.area), [84, 2, 3]);
  assert.equal(nodes[1].name, '美国');
});

test('parseRouteGroups tolerates a malformed body', () => {
  assert.deepEqual(parseRouteGroups('not json'), []);
  assert.deepEqual(parseRouteGroups('{"res":[]}'), []);
});

test('parseRouteGroups reads cid, cname, open and the child ids', () => {
  const groups = parseRouteGroups(JSON.stringify({
    res: [{ cid: 48, cname: '免费线路', open: 2, data: [{ id: 84, name: '专线01', enable: 1, enable_desc: '' }] }]
  }));
  assert.deepEqual(groups, [{
    cid: 48,
    cname: '免费线路',
    open: 2,
    nodes: [{ id: 84, name: '专线01', enable: 1, enable_desc: '' }]
  }]);
});

test('apiLinkValues accepts both the string and the {key,value} shapes', () => {
  assert.deepEqual(
    apiLinkValues(['https://a.example:20000', 'https://b.example:20000']),
    ['https://a.example:20000', 'https://b.example:20000']
  );
  assert.deepEqual(
    apiLinkValues([{ key: '黄金线路', value: 'https://a.example:20000', desc: '' }]),
    ['https://a.example:20000']
  );
  assert.deepEqual(apiLinkValues(undefined), []);
});

test('apiLineValues keeps every 旋风 route table, not just the first', () => {
  assert.deepEqual(
    apiLineValues('https://a.example:20000/myapi/apinodelist?level=2'),
    ['https://a.example:20000/myapi/apinodelist?level=2']
  );
  assert.deepEqual(
    apiLineValues([
      { key: '黄金线路', value: 'https://b.example:20000/myapi/apinodelist?level=2', desc: '' },
      { key: '白金线路', value: 'https://b.example:20000/myapi/apinodelist?level=3', desc: '' }
    ]),
    [
      'https://b.example:20000/myapi/apinodelist?level=2',
      'https://b.example:20000/myapi/apinodelist?level=3'
    ]
  );
  // A repeated endpoint is one table, not two round trips per round.
  assert.deepEqual(apiLineValues(['https://c.example/x', 'https://c.example/x']), ['https://c.example/x']);
  assert.deepEqual(apiLineValues(undefined), []);
  assert.deepEqual(apiLineValues(''), []);
});

test('isPlaceholderNode recognises the server template', () => {
  assert.equal(isPlaceholderNode('1.1.1.1'), true);
  assert.equal(isPlaceholderNode(' 1.1.1.1 '), true);
  assert.equal(isPlaceholderNode('45.58.178.3'), false);
});

test('transformNodeId swaps each four-character pair', () => {
  assert.equal(
    transformNodeId('12345678-1234-1234-1234-123456789abc'),
    '34127856-3412-3412-3412-34127856bc9a'
  );
});

test('isCredentialSource prefers mode and falls back to the field shape', () => {
  assert.equal(isCredentialSource({ url: '', key: '', mode: 'credential' }), true);
  assert.equal(isCredentialSource({ url: 'https://x', key: 'k', mode: 'url' }), false);
  assert.equal(isCredentialSource({ url: '', key: '', account: 'a', password: 'p' }), true);
  assert.equal(isCredentialSource({ url: 'https://x', key: 'k', account: 'a' }), false);
});

test('the round policy defaults to the cursor-run budget', () => {
  const policy = resolveRoundPolicy({});
  // A round is one cursor step (one area by default), so the shipped budget is
  // 200 rounds with a 50-round meaningful-novelty plateau.
  assert.equal(policy.max_iterations, 200);
  assert.equal(policy.min_iterations, 0);
  assert.equal(policy.plateau_limit, 50);
  assert.equal(policy.max_runtime_seconds, 0);
});

test('min_iterations is clamped to max_iterations', () => {
  const policy = resolveRoundPolicy({ max_iterations: 3, min_iterations: 99 });
  assert.equal(policy.max_iterations, 3);
  assert.equal(policy.min_iterations, 3);
});

test('a non-positive cap floors at one round and a malformed cap uses the default', () => {
  assert.equal(resolveRoundPolicy({ max_iterations: 0 }).max_iterations, 1);
  assert.equal(resolveRoundPolicy({ max_iterations: -5 }).max_iterations, 1);
  // A non-numeric cap is "unset", so it falls back to the shipped default
  // rather than silently disabling the run.
  assert.equal(resolveRoundPolicy({ max_iterations: Number.NaN }).max_iterations, 200);
  assert.equal(resolveRoundPolicy({ plateau_limit: 0 }).plateau_limit, 1);
});

test('rounds past the cap never start', () => {
  const policy = resolveRoundPolicy({ max_iterations: 4 });
  assert.equal(shouldStartRound(4, policy, 0), true);
  assert.equal(shouldStartRound(5, policy, 0), false);
});

test('the runtime budget cannot cut the floor rounds', () => {
  const policy = resolveRoundPolicy({ max_iterations: 10, min_iterations: 3, max_runtime_seconds: 60 });
  // Already over budget, but the floor still runs.
  assert.equal(shouldStartRound(1, policy, 999), true);
  assert.equal(shouldStartRound(3, policy, 999), true);
  assert.equal(shouldStartRound(4, policy, 999), false);
  assert.equal(shouldStartRound(4, policy, 59), true);
});

test('a zero runtime budget means unlimited', () => {
  const policy = resolveRoundPolicy({ max_iterations: 10, min_iterations: 0, max_runtime_seconds: 0 });
  assert.equal(shouldStartRound(10, policy, 1e9), true);
});

test('the plateau stop waits for the floor rounds', () => {
  const policy = resolveRoundPolicy({ max_iterations: 20, min_iterations: 5, plateau_limit: 2 });
  // Two dry rounds in a row, but the floor has not run yet.
  assert.equal(shouldStopOnPlateau(3, 2, policy), false);
  assert.equal(shouldStopOnPlateau(5, 2, policy), true);
  // One dry round is below the limit.
  assert.equal(shouldStopOnPlateau(9, 1, policy), false);
});

test('one brand reached by two profile entries shares a cache key', () => {
  // The APK, certificate and seeds do not depend on the profile entry name, so
  // `leiting` and `leiting_backup` must resolve to the same fingerprint.
  const site = { official_site: 'https://www.68123836.com' };
  assert.equal(credentialBrandKey('leiting', site), credentialBrandKey('leiting_backup', site));
});

test('the brand key falls back to the source name without a site', () => {
  assert.equal(credentialBrandKey('leiting', {}), 'lt');
  assert.equal(credentialBrandKey('custom_brand', {}), 'custom_brand');
  assert.equal(credentialBrandKey('', {}), 'unknown');
});

test('both client channels run by default and only the request can narrow them', () => {
  assert.deepEqual(resolveCredentialPlatforms({}), ['android', 'ios']);
  assert.deepEqual(resolveCredentialPlatforms({ platforms: ['ios'] }), ['ios']);
  assert.deepEqual(resolveCredentialPlatforms({ platforms: ['ios', 'ios', 'nope'] }), ['ios']);
  assert.deepEqual(resolveCredentialPlatforms({ platforms: [] }), ['android', 'ios']);
});

test('only a real credential rejection retires a pooled account', () => {
  assert.equal(isCredentialLoginRejection('账号或密码错误'), true);
  assert.equal(isCredentialLoginRejection('密码错误'), true);
  assert.equal(isCredentialLoginRejection('user does not exist'), true);
  assert.equal(isCredentialLoginRejection('请求过于频繁，请稍后再试'), false);
  assert.equal(isCredentialLoginRejection(''), false);
});

test('membership dates accept epoch seconds, milliseconds and ISO text', () => {
  assert.equal(membershipDate(1812363833), '2027-06-07');
  assert.equal(membershipDate(1812363833000), '2027-06-07');
  assert.equal(membershipDate('2027-06-05'), '2027-06-05');
  assert.equal(membershipDate(''), '');
  assert.equal(membershipDate(0), '');
});

test('free and mainland routes are dropped, and two tables merge by area', () => {
  const routes = [
    { area: 48, name: '永久免费专线01', region: '免费线路', cid: 48, enabled: true },
    { area: 2, name: '美国', region: '美国', cid: 2, enabled: true },
    { area: 3, name: '加州', region: '美国', cid: 2, enabled: true },
    { area: 9, name: '上海', region: '中国', cid: 9, enabled: true },
    { area: 10, name: '回国专线', region: '回国线路', cid: 10, enabled: true },
    { area: 2, name: '美国-白金', region: '美国', cid: 2, enabled: true },
    { area: 11, name: '日本', region: '日本', cid: 11, enabled: false }
  ];
  assert.equal(isFreeRoute(routes[0]), true);
  assert.equal(isChinaRoute(routes[3]), true);
  assert.equal(isChinaRoute({ region: '香港', name: '香港01' }), false);
  const selected = selectForeignRoutes(routes);
  assert.deepEqual(selected.routes.map((route) => route.area), [2, 3]);
  assert.deepEqual(
    [selected.dropped_free, selected.dropped_china, selected.dropped_disabled, selected.dropped_duplicate],
    [1, 2, 1, 1]
  );
  // The overrides are for a profile pinning a specific table.
  assert.equal(selectForeignRoutes(routes, { includeFree: true, includeChina: true, includeDisabled: true }).routes.length, 6);
});

test('a brand run without an active pooled account reports why and stops', async () => {
  const store = new AccountStore({ dbPath: ':memory:' });
  const result = await fetchCredentialSourceLinks(
    { source_name: 'leiting', source: { mode: 'credential', official_site: 'https://www.68123836.com' } },
    { accountStore: store, fetchImpl: async () => ({ ok: false, status: 500, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }) }
  );
  assert.equal(result.links.length, 0);
  assert.match(result.diagnostics.errors.join('; '), /account pool has no active leiting account/);
  store.close();
});

test('an unreported membership level is not evidence of a free account', () => {
  // Reading a missing `level` as 0 sent isvip=0 and then retired a paid account
  // as "no paid membership" once the round loop produced nothing.
  const level = (info) => {
    const detail = (info.info ?? {});
    const raw = detail.level ?? info.level;
    return raw === undefined || raw === null || String(raw).trim() === '' ? undefined : Number(raw);
  };
  assert.equal(level({ info: { endtime: 1812363833 } }), undefined);
  assert.equal(level({ info: {} }), undefined);
  assert.equal(level({ info: { level: 2 } }), 2);
  assert.equal(level({ info: { level: 0 } }), 0);
});

test('a throttling message is not a credential rejection', () => {
  // Retiring an account for a vendor rate limit burns a healthy credential and
  // walks the whole brand's pool.
  for (const message of [
    '账号登录过于频繁，请稍后再试',
    '请求过于频繁',
    '操作太频繁',
    '服务器繁忙',
    'server error, try again later',
    'too many requests'
  ]) {
    assert.equal(isCredentialLoginRejection(message), false, message);
  }
  for (const message of ['密码错误', '账号或密码错误', '账号不存在', 'user does not exist', 'invalid password']) {
    assert.equal(isCredentialLoginRejection(message), true, message);
  }
});
