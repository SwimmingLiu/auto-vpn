import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decorateLinkWithCountry,
  decorateNodeName,
  postprocessLinksWithBackend,
  runPostprocess,
  selectLinksByCountryLimit,
  selectPipelineStageBackend
} from '../../dist/pipeline/postprocess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'node-migration', 'pipeline', 'postprocess');

const sampleLink = 'vmess://eyJ2IjoiMiIsInBzIjoiVVMgb2xkLW5hbWUiLCJhZGQiOiIxLjEuMS4xIiwicG9ydCI6IjQ0MyIsImlkIjoiNDE4MDQ4YWYtYTI5My00Yjk5LTliMGMtOThjYTM1ODBkZDI0IiwiYWlkIjoiMCIsInNjeSI6Im5vbmUiLCJuZXQiOiJ3cyIsInR5cGUiOiJkdGxzIiwiaG9zdCI6Ind3dy5leGFtcGxlLmNvbSIsInBhdGgiOiIvcGF0aC9kZW1vIiwidGxzIjoidGxzIiwic25pIjoid3d3LmV4YW1wbGUuY29tIn0=';

test('decorateNodeName prefixes emoji and replaces existing country prefix', () => {
  assert.equal(decorateNodeName('Node-1', 'US', '🇺🇸'), '🇺🇸 US Node-1');
  assert.equal(decorateNodeName('US 772', 'US', '🇺🇸'), '🇺🇸 US 772');
});

test('decorateLinkWithCountry normalizes invalid country codes to US', () => {
  const updated = decorateLinkWithCountry(sampleLink, 'ZZ');
  const encoded = updated.slice('vmess://'.length);
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));

  assert.equal(payload.ps, '🇺🇸 US old-name');
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

test('postprocess defaults match Python FilterConfig when filters are omitted', async () => {
  const payload = { ranked_links: [{ link: sampleLink, country_code: 'CN' }] };

  assert.deepEqual(runPostprocess(payload), { links: [] });

  const result = await postprocessLinksWithBackend(payload, {
    env: { AUTOVPN_STAGE_BACKEND_POSTPROCESS: 'python' },
    resolvePythonCli: () => ({ command: '/opt/autovpn/.venv/bin/autovpn', args: [] }),
    spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write(chunk) {
          this.input = String(chunk);
        },
        end() {
          const helperInput = JSON.parse(this.input);
          assert.deepEqual(helperInput.filters, { excluded_country_codes: ['CN'], per_country_limit: {} });
          child.stdout.emit('data', `${JSON.stringify({ links: [] })}\n`);
          child.emit('close', 0, null);
        }
      };
      return child;
    }
  });

  assert.deepEqual(result, { links: [] });
});

test('postprocess keeps Python filter defaults for explicit empty and partial filters', async () => {
  const cnOnly = { ranked_links: [{ link: sampleLink, country_code: 'CN' }], filters: {} };
  const partial = { ranked_links: [{ link: sampleLink, country_code: 'CN' }], filters: { per_country_limit: { US: 1 } } };

  assert.deepEqual(runPostprocess(cnOnly), { links: [] });
  assert.deepEqual(runPostprocess(partial), { links: [] });

  const helperInputs = [];
  async function runFallback(input) {
    return postprocessLinksWithBackend(input, {
      env: { AUTOVPN_STAGE_BACKEND_POSTPROCESS: 'python' },
      resolvePythonCli: () => ({ command: '/opt/autovpn/.venv/bin/autovpn', args: [] }),
      spawn: (command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {
          write(chunk) {
            this.input = String(chunk);
          },
          end() {
            const helperInput = JSON.parse(this.input);
            helperInputs.push(helperInput);
            assert.deepEqual(helperInput.filters.excluded_country_codes, ['CN']);
            child.stdout.emit('data', `${JSON.stringify({ links: [] })}\n`);
            child.emit('close', 0, null);
          }
        };
        return child;
      }
    });
  }

  assert.deepEqual(await runFallback(cnOnly), { links: [] });
  assert.deepEqual(await runFallback(partial), { links: [] });
  assert.deepEqual(helperInputs.map((input) => input.filters.per_country_limit), [{}, { US: 1 }]);
});

test('postprocess fixture output matches Python golden output', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const expected = JSON.parse(await readFile(path.join(fixtureDir, 'output.json'), 'utf8'));

  assert.deepEqual(runPostprocess(input).links, expected.links);
});

test('postprocess backend selection supports Node default and Python rollback flags', async () => {
  assert.equal(selectPipelineStageBackend('postprocess', {}), 'node');
  assert.equal(selectPipelineStageBackend('postprocess', { AUTOVPN_PIPELINE_BACKEND: ' HYBRID ' }), 'node');
  assert.equal(selectPipelineStageBackend('postprocess', { AUTOVPN_PIPELINE_BACKEND: ' PYTHON ' }), 'python');
  assert.equal(selectPipelineStageBackend('postprocess', { AUTOVPN_STAGE_BACKEND_POSTPROCESS: ' python ' }), 'python');
  assert.equal(selectPipelineStageBackend('postprocess', { AUTOVPN_PIPELINE_BACKEND: 'python', AUTOVPN_STAGE_BACKEND_POSTPROCESS: '' }), 'python');

  const payload = { ranked_links: [{ link: sampleLink, country_code: 'US' }], filters: {} };
  const pythonCalls = [];
  const fallback = async (input) => {
    pythonCalls.push(input);
    return { links: ['python-result'] };
  };

  assert.deepEqual((await postprocessLinksWithBackend(payload, { env: {}, pythonPostprocess: fallback })).links.length, 1);
  assert.deepEqual(await postprocessLinksWithBackend(payload, {
    env: { AUTOVPN_STAGE_BACKEND_POSTPROCESS: 'python' },
    pythonPostprocess: fallback
  }), { links: ['python-result'] });
  assert.deepEqual(pythonCalls, [payload]);
});

test('Python postprocess rollback adapter invokes backend venv Python when no callback is injected', async () => {
  const payload = { ranked_links: [{ link: sampleLink, country_code: 'US' }], filters: {} };
  const spawns = [];
  const result = await postprocessLinksWithBackend(payload, {
    env: { AUTOVPN_STAGE_BACKEND_POSTPROCESS: 'python' },
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
          const helperInput = JSON.parse(this.input);
          child.stdout.emit('data', `${JSON.stringify({ links: [helperInput.ranked_links[0].link] })}\n`);
          child.emit('close', 0, null);
        }
      };
      return child;
    }
  });

  assert.deepEqual(result, { links: [sampleLink] });
  assert.equal(spawns[0].command, '/opt/autovpn/.venv/bin/python');
  assert.equal(spawns[0].args[0], '-c');
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});
