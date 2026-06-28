import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalVmessKey, dedupeVmessLinks, dedupeVmessLinksWithBackend, parseVmessLink, selectPipelineStageBackend } from '../../dist/pipeline/dedupe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'node-migration', 'pipeline', 'dedupe');

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

test('dedupe stage backend selection supports Node default and Python rollback flags', async () => {
  assert.equal(selectPipelineStageBackend('dedupe', {}), 'node');
  assert.equal(selectPipelineStageBackend('dedupe', { AUTOVPN_PIPELINE_BACKEND: ' Hybrid ' }), 'node');
  assert.equal(selectPipelineStageBackend('dedupe', { AUTOVPN_PIPELINE_BACKEND: ' Python ' }), 'python');
  assert.equal(selectPipelineStageBackend('dedupe', { AUTOVPN_STAGE_BACKEND_DEDUPE: ' PYTHON ' }), 'python');
  assert.equal(selectPipelineStageBackend('dedupe', { AUTOVPN_PIPELINE_BACKEND: 'python', AUTOVPN_STAGE_BACKEND_DEDUPE: '' }), 'python');

  const pythonCalls = [];
  const fallback = async (links) => {
    pythonCalls.push(links);
    return ['python-result'];
  };

  assert.deepEqual(await dedupeVmessLinksWithBackend([sameNodeA, sameNodeB], { env: {}, pythonDedupe: fallback }), [sameNodeA]);
  assert.deepEqual(await dedupeVmessLinksWithBackend([sameNodeA, sameNodeB], {
    env: { AUTOVPN_STAGE_BACKEND_DEDUPE: 'python' },
    pythonDedupe: fallback
  }), ['python-result']);
  assert.deepEqual(pythonCalls, [[sameNodeA, sameNodeB]]);
});

test('Python rollback adapter invokes backend venv Python when no callback is injected', async () => {
  const spawns = [];
  const result = await dedupeVmessLinksWithBackend([sameNodeA, sameNodeB], {
    env: { AUTOVPN_STAGE_BACKEND_DEDUPE: 'python' },
    resolvePythonCli: () => ({ command: '/opt/autovpn/.venv/bin/autovpn', args: [] }),
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write(chunk) {
          this.input = String(chunk);
        },
        end() {
          const payload = JSON.parse(this.input);
          child.stdout.emit('data', `${JSON.stringify([payload.links[0]])}\n`);
          child.emit('close', 0, null);
        }
      };
      return child;
    }
  });

  assert.deepEqual(result, [sameNodeA]);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/opt/autovpn/.venv/bin/python');
  assert.equal(spawns[0].args[0], '-c');
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});
