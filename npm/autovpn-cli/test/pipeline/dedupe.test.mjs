import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalVmessKey, dedupeVmessLinks, dedupeVmessLinksWithBackend, parseVmessLink } from '../../dist/pipeline/dedupe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'npm', 'autovpn-cli', 'test', 'fixtures', 'node-migration', 'pipeline', 'dedupe');

const sameNodeA = 'vmess://eyJ2IjoiMiIsImFkZCI6IjEuMS4xLjEiLCJwb3J0IjoiNDQzIiwiaWQiOiJ1dWlkIiwibmV0Ijoid3MiLCJob3N0IjoiMS4xLjEuMSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMiLCJzbmkiOiIiLCJwcyI6IkEifQ==';
const sameNodeB = 'vmess://eyJ2IjoiMiIsImFkZCI6IjEuMS4xLjEiLCJwb3J0IjoiNDQzIiwiaWQiOiJ1dWlkIiwibmV0Ijoid3MiLCJob3N0IjoiMS4xLjEuMSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMiLCJzbmkiOiIiLCJwcyI6IkIifQ==';
const differentPort = 'vmess://eyJ2IjoiMiIsImFkZCI6IjEuMS4xLjEiLCJwb3J0IjoiODQ0MyIsImlkIjoidXVpZCIsIm5ldCI6IndzIiwiaG9zdCI6IjEuMS4xLjEiLCJwYXRoIjoiL3dzIiwidGxzIjoidGxzIiwic25pIjoiIiwicHMiOiJDIn0=';

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

test('dedupeVmessLinks removes duplicate canonical endpoints while preserving first link', () => {
  assert.deepEqual(dedupeVmessLinks([sameNodeA, sameNodeB, differentPort]), [sameNodeA, differentPort]);
});

test('canonicalVmessKey matches Python canonical fields and ignores display name', () => {
  assert.equal(canonicalVmessKey(parseVmessLink(sameNodeA)), canonicalVmessKey(parseVmessLink(sameNodeB)));
  assert.notEqual(canonicalVmessKey(parseVmessLink(sameNodeA)), canonicalVmessKey(parseVmessLink(differentPort)));
});

test('dedupe fixture output matches Python golden output', async () => {
  const input = lines(await readFile(path.join(fixtureDir, 'input.txt'), 'utf8'));
  const expected = lines(await readFile(path.join(fixtureDir, 'output.txt'), 'utf8'));

  assert.deepEqual(dedupeVmessLinks(input), expected);
});

test('dedupe backend API runs the Node implementation', async () => {
  assert.deepEqual(await dedupeVmessLinksWithBackend([sameNodeA, sameNodeB]), [sameNodeA]);
});
