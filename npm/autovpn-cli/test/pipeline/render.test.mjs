import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAIN_DATA_PLACEHOLDER, renderMainDataWithBackend, replaceMainData } from '../../dist/pipeline/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'npm', 'autovpn-cli', 'test', 'fixtures', 'node-migration', 'pipeline', 'render');

test('replaceMainData replaces exactly one placeholder with newline-joined links', () => {
  const template = `const MainData = \`${MAIN_DATA_PLACEHOLDER}\`;\nconst footer = 'keep';`;

  assert.equal(
    replaceMainData(template, ['vmess://a', 'vmess://b']),
    "const MainData = `vmess://a\nvmess://b`;\nconst footer = 'keep';"
  );
});

test('replaceMainData rejects templates without exactly one placeholder', () => {
  assert.throws(() => replaceMainData('const MainData = ``;', ['vmess://a']), /exactly one MainData placeholder/);
  assert.throws(
    () => replaceMainData(`${MAIN_DATA_PLACEHOLDER}\n${MAIN_DATA_PLACEHOLDER}`, ['vmess://a']),
    /exactly one MainData placeholder/
  );
});

test('render fixture output matches Python golden output', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const expected = await readFile(path.join(fixtureDir, 'output.txt'), 'utf8');

  assert.equal(replaceMainData(input.template, input.links), expected);
});

test('render backend API runs the Node implementation', async () => {
  const input = { template: `${MAIN_DATA_PLACEHOLDER}`, links: ['vmess://a'] };
  assert.deepEqual(await renderMainDataWithBackend(input), { rendered_source: 'vmess://a' });
});
