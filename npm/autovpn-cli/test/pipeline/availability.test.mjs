import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  availabilityResultToDict,
  checkLinkAvailabilityBatchWithBackend,
  evaluateProviderResponse,
  normalizeProviderTargets,
  selectPipelineStageBackend
} from '../../dist/pipeline/availability.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'node-migration', 'pipeline', 'availability');

const speedResult = {
  link: 'vmess://node',
  reachable: true,
  average_download_mb_s: 3.5,
  latency_ms: 80,
  error: ''
};

test('normalizeProviderTargets matches Python defaults and custom target handling', () => {
  assert.deepEqual(normalizeProviderTargets().map((target) => target.name), ['gemini', 'chatgpt_ios', 'chatgpt_web', 'claude']);
  const targets = normalizeProviderTargets({
    gemini: { url: 'https://gemini.example/', enabled: false, allowed_hosts: ['gemini.example'], negative_phrases: ['blocked'] },
    tmailor: { url: 'https://tmailor.example/', enabled: true, allowed_hosts: [], negative_phrases: ['not supported'] }
  });

  assert.deepEqual(targets, [{
    name: 'tmailor',
    url: 'https://tmailor.example/',
    allowed_hosts: ['tmailor.example'],
    negative_phrases: []
  }]);
});

test('evaluateProviderResponse rejects challenge pages, bad hosts, http errors, and negative phrases', () => {
  const target = {
    name: 'custom',
    url: 'https://custom.example/',
    allowed_hosts: ['custom.example'],
    negative_phrases: ['blocked']
  };

  assert.equal(evaluateProviderResponse(target, {
    final_url: 'https://custom.example/',
    status_code: 200,
    title: 'Just a moment',
    body: 'Checking your browser before accessing this site.'
  }).reason, 'challenge_page');
  assert.equal(evaluateProviderResponse(target, {
    final_url: 'https://example.com/blocked',
    status_code: 302,
    title: 'redirect',
    body: 'redirect'
  }).reason, 'unexpected_host');
  assert.equal(evaluateProviderResponse(target, {
    final_url: 'https://custom.example/',
    status_code: 403,
    title: 'forbidden',
    body: 'forbidden'
  }).reason, 'http_error');
  assert.equal(evaluateProviderResponse(target, {
    final_url: 'https://custom.example/',
    status_code: 200,
    title: 'ok',
    body: 'service is blocked'
  }).matched_phrase, 'blocked');
});

test('availability fixture output matches Python golden output', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const expected = JSON.parse(await readFile(path.join(fixtureDir, 'output.json'), 'utf8'));
  const providerResult = evaluateProviderResponse(input.target, input.response);
  const availabilityResult = availabilityResultToDict({
    speed_result: input.speed_result,
    provider_results: { custom: providerResult }
  });

  assert.deepEqual(providerResult, expected.provider_result);
  assert.deepEqual(availabilityResult, expected.availability_result);
});

test('Node availability batch preserves order, emits events, and downgrades runtime errors', async () => {
  const events = [];
  const progress = [];
  const results = [
    { ...speedResult, link: 'vmess://good' },
    { ...speedResult, link: 'vmess://bad' }
  ];
  const targets = normalizeProviderTargets({
    custom: { url: 'https://custom.example/', enabled: true, allowed_hosts: ['custom.example'], negative_phrases: [] }
  });

  const batch = await checkLinkAvailabilityBatchWithBackend({
    results,
    config: { concurrency: 2, timeout_seconds: 20, startup_wait_seconds: 1 },
    targets
  }, {
    env: {},
    checkLinkAvailability: async (speed) => {
      if (speed.link === 'vmess://bad') {
        throw new Error('proxy bootstrap failed');
      }
      return {
        speed_result: speed,
        provider_results: {
          custom: { provider: 'custom', passed: true, reason: 'ok', status_code: 200, final_url: 'https://custom.example/', matched_phrase: '' }
        }
      };
    },
    progressCallback: (message) => progress.push(message),
    eventCallback: (eventType, payload) => events.push({ type: eventType, ...payload })
  });

  assert.deepEqual(batch.map((item) => item.link), ['vmess://good', 'vmess://bad']);
  assert.equal(batch[0].all_passed, true);
  assert.equal(batch[1].provider_results.custom.reason, 'runtime_error');
  assert.equal(batch[1].provider_results.custom.matched_phrase, 'proxy bootstrap failed');
  assert.equal(progress.length, 2);
  assert.deepEqual(events.map((event) => event.type), ['availability_link_result', 'availability_link_result']);
});

test('availability backend selection supports Node default and Python rollback flags', async () => {
  assert.equal(selectPipelineStageBackend('availability', {}), 'node');
  assert.equal(selectPipelineStageBackend('availability', { AUTOVPN_PIPELINE_BACKEND: ' HYBRID ' }), 'node');
  assert.equal(selectPipelineStageBackend('availability', { AUTOVPN_PIPELINE_BACKEND: ' PYTHON ' }), 'python');
  assert.equal(selectPipelineStageBackend('availability', { AUTOVPN_STAGE_BACKEND_AVAILABILITY: ' python ' }), 'python');
  assert.equal(selectPipelineStageBackend('availability', { AUTOVPN_PIPELINE_BACKEND: 'python', AUTOVPN_STAGE_BACKEND_AVAILABILITY: '' }), 'python');

  const fallbackCalls = [];
  const fallback = async (input) => {
    fallbackCalls.push(input);
    return [{ ...speedResult, all_passed: true, provider_results: {} }];
  };
  const input = { results: [speedResult], config: { concurrency: 1, timeout_seconds: 20 }, targets: [] };

  assert.equal((await checkLinkAvailabilityBatchWithBackend(input, {
    env: {},
    checkLinkAvailability: async (speed) => ({ speed_result: speed, provider_results: {} })
  }))[0].all_passed, true);
  assert.deepEqual(await checkLinkAvailabilityBatchWithBackend(input, {
    env: { AUTOVPN_STAGE_BACKEND_AVAILABILITY: 'python' },
    pythonAvailability: fallback
  }), [{ ...speedResult, all_passed: true, provider_results: {} }]);
  assert.deepEqual(fallbackCalls, [input]);
});

test('Python availability rollback adapter invokes backend venv Python when no callback is injected', async () => {
  const spawns = [];
  const input = { results: [speedResult], config: { concurrency: 1, timeout_seconds: 20 }, targets: [] };
  const result = await checkLinkAvailabilityBatchWithBackend(input, {
    env: { AUTOVPN_STAGE_BACKEND_AVAILABILITY: 'python' },
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
          child.stdout.emit('data', `${JSON.stringify([{ ...helperInput.results[0], all_passed: true, provider_results: {} }])}\n`);
          child.emit('close', 0, null);
        }
      };
      return child;
    }
  });

  assert.equal(result[0].link, 'vmess://node');
  assert.equal(spawns[0].command, '/opt/autovpn/.venv/bin/python');
  assert.equal(spawns[0].args[0], '-c');
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});
