import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  apiLineValue,
  apiLinkValues,
  loginSignature,
  parseRouteGroups,
  resolveBrandLayout
} from '../../dist/pipeline/credential-source.js';
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

test('蜜蜂 layout adds no flag block and no viewport', () => {
  const params = commonParams(
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

test('apiLineValue accepts a plain string and the 旋风 object list', () => {
  assert.equal(apiLineValue('https://a.example:20000/myapi/apinodelist?level=2'), 'https://a.example:20000/myapi/apinodelist?level=2');
  assert.equal(
    apiLineValue([{ key: '黄金线路', value: 'https://b.example:20000/myapi/apinodelist?level=2', desc: '' }]),
    'https://b.example:20000/myapi/apinodelist?level=2'
  );
  assert.equal(apiLineValue(undefined), '');
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
