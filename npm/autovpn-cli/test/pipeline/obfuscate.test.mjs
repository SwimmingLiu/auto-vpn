import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildWorkerArtifacts, buildWorkerArtifactsWithBackend, fragmentLiteral, stableIdentifierPrefix } from '../../dist/pipeline/obfuscate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'npm', 'autovpn-cli', 'test', 'fixtures', 'node-migration', 'pipeline', 'obfuscate');

const renderedSource = `const SUBSCRIPTION_PAYLOAD = \`payload\`;
const secretToken = url.searchParams.get("serect_key");
const responsePayload = secretToken === "swimmingliu" ? SUBSCRIPTION_PAYLOAD : "noise";
const randomBytes = new Uint8Array(8);
try { throw new Error("x"); } catch (error) { console.log(error); }
`;

test('stableIdentifierPrefix matches Python normalization rules', () => {
  assert.equal(stableIdentifierPrefix('edge-demo'), 'edge_demo');
  assert.equal(stableIdentifierPrefix('123 bad prefix'), 'sg_123_bad_prefix');
  assert.equal(stableIdentifierPrefix('---'), 'sg');
  assert.equal(stableIdentifierPrefix(''), 'sg');
});

test('fragmentLiteral matches Python split and quote formatting', () => {
  assert.equal(fragmentLiteral('serect_key', true), "['ser', 'ect', '_key'].join('')");
  assert.equal(fragmentLiteral('swimmingliu', true), "['swim', 'ming', 'liu'].join('')");
  assert.equal(fragmentLiteral('token', true), "['toke', 'n'].join('')");
  assert.equal(fragmentLiteral('abc', true), "['abc'].join('')");
  assert.equal(fragmentLiteral('serect_key', false), '"serect_key"');
});

test('buildWorkerArtifacts applies identifier randomization and module manifest defaults', () => {
  const artifacts = buildWorkerArtifacts(renderedSource, { variable_prefix: 'edge-demo' }, 'serect_key=swimmingliu');

  assert.match(artifacts.transformed_source, /^\/\/ subscription worker: returns encoded payload/m);
  assert.match(artifacts.transformed_source, /edge_demo_secret_token/);
  assert.match(artifacts.transformed_source, /searchParams\.get\(\['ser', 'ect', '_key'\]\.join\(''\)\)/);
  assert.deepEqual(Object.keys(artifacts.modules).sort(), [
    'modules/guard.js',
    'modules/noise.js',
    'modules/payload.js',
    'modules/runtime.js'
  ]);
  assert.deepEqual(artifacts.manifest.modules, Object.keys(artifacts.modules).sort());
});

test('buildWorkerArtifacts honors disabled obfuscation switches', () => {
  const artifacts = buildWorkerArtifacts(renderedSource, {
    enable_identifier_randomization: false,
    enable_keyword_fragmentation: false,
    comment_template: 'generated ({environment_name})',
    environment_name: 'review'
  }, 'serect_key=swimmingliu');

  assert.match(artifacts.transformed_source, /^\/\/ generated \(review\)/);
  assert.match(artifacts.transformed_source, /const secretToken = url\.searchParams\.get\("serect_key"\)/);
  assert.match(artifacts.transformed_source, /secretToken === "swimmingliu"/);
  assert.equal(artifacts.modules['modules/guard.js'], 'export const secretParam = "serect_key";\nexport const secretValue = "swimmingliu";\n');
});

test('obfuscate fixture output matches Python golden output', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const expected = JSON.parse(await readFile(path.join(fixtureDir, 'output.json'), 'utf8'));

  assert.deepEqual(buildWorkerArtifacts(input.rendered_source, input.config, input.secret_query), expected);
});

test('obfuscate backend API runs the Node implementation', async () => {
  const input = { rendered_source: renderedSource, config: {}, secret_query: 'serect_key=swimmingliu' };
  const result = await buildWorkerArtifactsWithBackend(input);
  assert.match(result.transformed_source, /SUBSCRIPTION_PAYLOAD/);
  assert.ok(Object.keys(result.modules).length > 0);
});
