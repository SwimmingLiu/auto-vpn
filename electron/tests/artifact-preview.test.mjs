import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVmessLinkForPreview } from '../lib/artifact-preview.js';

function vmess(name) {
  return `vmess://${Buffer.from(JSON.stringify({ ps: name, add: '203.0.113.1', path: '/' })).toString('base64url')}`;
}

test('unknown and invalid country labels default to US', () => {
  assert.equal(parseVmessLinkForPreview(vmess('🏳️ ZZ node')).regionCode, 'US');
  assert.equal(parseVmessLinkForPreview(vmess('node without country')).regionCode, 'US');
});

test('real US labels remain US', () => {
  assert.equal(parseVmessLinkForPreview(vmess('🇺🇸 US node')).regionCode, 'US');
});

test('preview only trusts an explicit flag and ISO country prefix', () => {
  assert.equal(parseVmessLinkForPreview(vmess('🇩🇪 DE Frankfurt')).regionCode, 'DE');
  assert.equal(parseVmessLinkForPreview(vmess('DE Frankfurt')).regionCode, 'US');
  assert.equal(parseVmessLinkForPreview(vmess('node JP premium')).regionCode, 'US');
  assert.equal(parseVmessLinkForPreview(vmess('🇶🇶 QQ fake')).regionCode, 'US');
});
