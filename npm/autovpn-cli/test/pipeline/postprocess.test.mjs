import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decorateLinkWithCountry,
  decorateNodeName,
  postprocessLinksWithBackend,
  runPostprocess,
  selectLinksByCountryLimit
} from '../../dist/pipeline/postprocess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'npm', 'autovpn-cli', 'test', 'fixtures', 'node-migration', 'pipeline', 'postprocess');

const sampleLink = 'vmess://eyJ2IjoiMiIsInBzIjoiVVMgb2xkLW5hbWUiLCJhZGQiOiIxLjEuMS4xIiwicG9ydCI6IjQ0MyIsImlkIjoiNDE4MDQ4YWYtYTI5My00Yjk5LTliMGMtOThjYTM1ODBkZDI0IiwiYWlkIjoiMCIsInNjeSI6Im5vbmUiLCJuZXQiOiJ3cyIsInR5cGUiOiJkdGxzIiwiaG9zdCI6Ind3dy5leGFtcGxlLmNvbSIsInBhdGgiOiIvcGF0aC9kZW1vIiwidGxzIjoidGxzIiwic25pIjoid3d3LmV4YW1wbGUuY29tIn0=';

test('decorateNodeName prefixes emoji and replaces existing country prefix', () => {
  assert.equal(decorateNodeName('Node-1', 'US', '🇺🇸'), '🇺🇸 US Node-1');
  assert.equal(decorateNodeName('US 772', 'US', '🇺🇸'), '🇺🇸 US 772');
});

test('decorateLinkWithCountry keeps unknown and invalid country codes neutral', () => {
  const updated = decorateLinkWithCountry(sampleLink, 'ZZ');
  const encoded = updated.slice('vmess://'.length);
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));

  assert.equal(payload.ps, '🏳️ ZZ old-name');

  for (const country of ['', 'USA', '1A']) {
    const invalid = decorateLinkWithCountry(sampleLink, country);
    const invalidPayload = JSON.parse(Buffer.from(invalid.slice('vmess://'.length), 'base64url').toString('utf8'));
    assert.equal(invalidPayload.ps, '🏳️ ZZ old-name');
  }
});

test('selectLinksByCountryLimit excludes configured countries and applies per-country limits', () => {
  const rankedLinks = [
    { link: 'vmess://1', country_code: 'HK' },
    { link: 'vmess://2', country_code: 'HK' },
    { link: 'vmess://3', country_code: 'CN' },
    { link: 'vmess://4', country_code: 'US' }
  ];

  assert.deepEqual(selectLinksByCountryLimit(rankedLinks, {
    excluded_country_codes: ['CN'],
    per_country_limit: { HK: 1 }
  }), ['vmess://1', 'vmess://4']);
});

test('postprocess uses default filters when filters are omitted', async () => {
  const payload = { ranked_links: [{ link: sampleLink, country_code: 'CN' }] };

  assert.deepEqual(runPostprocess(payload), { links: [] });
  assert.deepEqual(await postprocessLinksWithBackend(payload), { links: [] });
});

test('postprocess keeps filter defaults for explicit empty and partial filters', async () => {
  const cnOnly = { ranked_links: [{ link: sampleLink, country_code: 'CN' }], filters: {} };
  const partial = { ranked_links: [{ link: sampleLink, country_code: 'CN' }], filters: { per_country_limit: { US: 1 } } };

  assert.deepEqual(runPostprocess(cnOnly), { links: [] });
  assert.deepEqual(runPostprocess(partial), { links: [] });

  assert.deepEqual(await postprocessLinksWithBackend(cnOnly), { links: [] });
  assert.deepEqual(await postprocessLinksWithBackend(partial), { links: [] });
});

test('postprocess fixture output matches Python golden output', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const expected = JSON.parse(await readFile(path.join(fixtureDir, 'output.json'), 'utf8'));

  assert.deepEqual(runPostprocess(input).links, expected.links);
});

test('postprocess backend API runs the Node implementation', async () => {
  const payload = { ranked_links: [{ link: sampleLink, country_code: 'US' }], filters: {} };
  const result = await postprocessLinksWithBackend(payload);
  assert.equal(result.links.length, 1);
});
