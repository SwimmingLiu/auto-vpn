import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVmessLinkForPreview } from '../lib/artifact-preview.js';

function vmess(name) {
  return `vmess://${Buffer.from(JSON.stringify({ ps: name, add: '203.0.113.1', path: '/' })).toString('base64url')}`;
}

test('unknown and invalid country labels are presented as other', () => {
  assert.equal(parseVmessLinkForPreview(vmess('🏳️ ZZ node')).regionCode, 'OTHER');
  assert.equal(parseVmessLinkForPreview(vmess('node without country')).regionCode, 'OTHER');
});

test('real US labels remain US', () => {
  assert.equal(parseVmessLinkForPreview(vmess('🇺🇸 US node')).regionCode, 'US');
});
