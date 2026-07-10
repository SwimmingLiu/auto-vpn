import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildRuntimeSourceUrl,
  decryptPayload,
  extractLinksFromPlaintext,
  fetchSourceLinksWithBackend,
  selectPipelineStageBackend,
  transformNodeId
} from '../../dist/pipeline/extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'node-migration', 'pipeline', 'extract');

test('buildRuntimeSourceUrl rewrites time and randomized area like Python', () => {
  const source = { url: 'https://example.com/api?area=2&t=123', key: 'abc', use_random_area: true, area_min: 30, area_max: 20 };
  const first = buildRuntimeSourceUrl(source, 0, { timeNow: () => 42.123456, randomInt: () => 25 });
  const second = buildRuntimeSourceUrl(source, 1, { timeNow: () => 42.123456, randomInt: (start, end) => {
    assert.deepEqual([start, end], [20, 30]);
    return 25;
  } });

  assert.equal(first, 'https://example.com/api?area=2&t=42.123456');
  assert.equal(second, 'https://example.com/api?area=25&t=42.123456');
});

test('transformNodeId and decryptPayload match Python helpers', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));

  assert.equal(transformNodeId('12345678-1234-1234-1234-123456789abc'), '34127856-3412-3412-3412-34127856bc9a');
  assert.equal(decryptPayload(input.cipher_text, input.key), input.plain);
});

test('extract fixture output matches Python golden output', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const expected = JSON.parse(await readFile(path.join(fixtureDir, 'output.json'), 'utf8'));

  assert.deepEqual(extractLinksFromPlaintext(input.source_name, input.plaintext), expected.links);
  assert.deepEqual(extractLinksFromPlaintext(input.source_name, expected.links[0]), expected.links);
  assert.deepEqual(extractLinksFromPlaintext(input.source_name, 'not enough parts'), []);
});

test('extract backend selection always uses the Node engine', async () => {
  assert.equal(selectPipelineStageBackend('extract', {}), 'node');
  assert.equal(selectPipelineStageBackend('extract', { AUTOVPN_PIPELINE_BACKEND: ' HYBRID ' }), 'node');
  assert.equal(selectPipelineStageBackend('extract', { AUTOVPN_PIPELINE_BACKEND: ' PYTHON ' }), 'node');
  assert.equal(selectPipelineStageBackend('extract', { AUTOVPN_STAGE_BACKEND_EXTRACT: ' python ' }), 'node');
  assert.equal(selectPipelineStageBackend('extract', { AUTOVPN_PIPELINE_BACKEND: 'python', AUTOVPN_STAGE_BACKEND_EXTRACT: '' }), 'node');

  const input = { source_name: 'leiting', source: { url: 'https://example.com/api', key: 'abcdabcdabcdabcd', max_iterations: 0 } };
  const fallbackCalls = [];
  const fallback = async (payload) => {
    fallbackCalls.push(payload);
    return { source_name: payload.source_name, requested_iterations: 0, successful_iterations: 0, failed_iterations: 0, links: ['python-result'] };
  };

  assert.deepEqual(await fetchSourceLinksWithBackend(input, {
    env: {},
    fetchSourceLinks: async (payload) => ({ source_name: payload.source_name, requested_iterations: 0, successful_iterations: 0, failed_iterations: 0, links: ['node-result'] })
  }), { source_name: 'leiting', requested_iterations: 0, successful_iterations: 0, failed_iterations: 0, links: ['node-result'] });
  assert.deepEqual(await fetchSourceLinksWithBackend(input, {
    env: { AUTOVPN_STAGE_BACKEND_EXTRACT: 'python' },
    pythonExtract: fallback,
    fetchSourceLinks: async (payload) => ({ source_name: payload.source_name, requested_iterations: 0, successful_iterations: 0, failed_iterations: 0, links: ['node-result'] })
  }), { source_name: 'leiting', requested_iterations: 0, successful_iterations: 0, failed_iterations: 0, links: ['node-result'] });
  assert.deepEqual(fallbackCalls, []);
});

test('Node extract backend fetches encrypted runtime source without Python fallback', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const calls = [];

  const result = await fetchSourceLinksWithBackend({
    source_name: input.source_name,
    source: {
      url: 'https://fixture.example/source',
      key: input.key,
      max_iterations: 2,
      min_iterations: 1,
      plateau_limit: 1,
      failure_limit: 1,
      max_runtime_seconds: 0
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1' },
    fetch: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => input.cipher_text
      };
    }
  });

  assert.deepEqual(result, {
    source_name: input.source_name,
    requested_iterations: 2,
    successful_iterations: 2,
    failed_iterations: 0,
    links: ['vmess://fixture']
  });
  assert.deepEqual(calls, ['https://fixture.example/source', 'https://fixture.example/source']);
});

test('Node extract backend uses configurable plateau limit per source', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  let calls = 0;

  const result = await fetchSourceLinksWithBackend({
    source_name: 'mifeng',
    source: {
      url: 'https://fixture.example/source',
      key: input.key,
      max_iterations: 5,
      min_iterations: 0,
      plateau_limit: 3,
      failure_limit: 1,
      max_runtime_seconds: 0
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1' },
    fetch: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => input.cipher_text
      };
    }
  });

  assert.equal(calls, 4);
  assert.equal(result.successful_iterations, 4);
  assert.equal(result.links.length, 1);
});

test('Node extract backend emits source progress events while extracting', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const events = [];

  await fetchSourceLinksWithBackend({
    source_name: input.source_name,
    source: {
      url: 'https://fixture.example/source',
      key: input.key,
      max_iterations: 1,
      min_iterations: 1,
      plateau_limit: 1,
      failure_limit: 1,
      max_runtime_seconds: 0
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1' },
    eventCallback: (type, payload) => events.push({ type, ...payload }),
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => input.cipher_text
    })
  });

  assert.deepEqual(events.map((event) => event.type), [
    'extract_source_started',
    'extract_request_result',
    'extract_decrypt_result',
    'extract_iteration',
    'extract_source_completed'
  ]);
  assert.equal(events[1].via, 'direct');
  assert.equal(events[1].url, undefined);
  assert.doesNotMatch(JSON.stringify(events), /fixture\.example\/source/);
  assert.equal(events[3].total_links, 1);
  assert.equal(events[3].deduped_links, 1);
  assert.equal(events[3].new_item_fingerprints.length, 1);
  assert.match(events[3].new_item_fingerprints[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(events[3].new_item_fingerprints), /vmess|fixture/);
});

test('Node extract fingerprints ignore VMess display names when canonical fields match', async () => {
  const key = 'abcdabcdabcdabcd';
  const canonicalFields = {
    add: '203.0.113.10',
    port: '443',
    id: '12345678-1234-1234-1234-123456789abc',
    net: 'ws',
    host: 'edge.example.com',
    path: '/vpn',
    tls: 'tls',
    sni: 'edge.example.com'
  };
  const links = [
    vmessLink({ ...canonicalFields, ps: 'Leiting display name' }),
    vmessLink({ ...canonicalFields, ps: 'Heidong display name' })
  ];
  const fingerprints = [];

  for (const [index, link] of links.entries()) {
    const events = [];
    await fetchSourceLinksWithBackend({
      source_name: index === 0 ? 'leiting' : 'heidong',
      source: {
        url: 'https://fixture.example/source',
        key,
        max_iterations: 1,
        min_iterations: 1,
        plateau_limit: 1,
        failure_limit: 1,
        max_runtime_seconds: 0
      }
    }, {
      env: { AUTOVPN_NO_PYTHON: '1' },
      eventCallback: (type, payload) => events.push({ type, ...payload }),
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => encryptPayload(link, key)
      })
    });
    const iteration = events.find((event) => event.type === 'extract_iteration');
    fingerprints.push(iteration.new_item_fingerprints[0]);
    assert.doesNotMatch(JSON.stringify(iteration), /vmess:\/\//);
    assert.doesNotMatch(JSON.stringify(iteration), new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.notEqual(links[0], links[1]);
  assert.equal(fingerprints[0], fingerprints[1]);
  assert.match(fingerprints[0], /^[a-f0-9]{64}$/);
});

test('Node extract backend uses curl TLS fallback without enabling proxy by default', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const curlCalls = [];

  const result = await fetchSourceLinksWithBackend({
    source_name: input.source_name,
    source: {
      url: 'https://fixture.example/source',
      key: input.key,
      max_iterations: 1,
      min_iterations: 1,
      plateau_limit: 1,
      failure_limit: 1,
      max_runtime_seconds: 0
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1' },
    fetch: async () => {
      throw new Error('certificate has expired');
    },
    curlFetch: async (url, proxyUrl) => {
      curlCalls.push({ url, proxyUrl });
      return input.cipher_text;
    }
  });

  assert.equal(result.successful_iterations, 1);
  assert.deepEqual(curlCalls, [{ url: 'https://fixture.example/source', proxyUrl: '' }]);
});

test('Node extract backend detects TLS failures wrapped inside fetch causes', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const curlCalls = [];

  const result = await fetchSourceLinksWithBackend({
    source_name: input.source_name,
    source: {
      url: 'https://fixture.example/source',
      key: input.key,
      max_iterations: 1,
      min_iterations: 1,
      plateau_limit: 1,
      failure_limit: 1,
      max_runtime_seconds: 0
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1' },
    fetch: async () => {
      const error = new TypeError('fetch failed');
      error.cause = new Error('certificate has expired');
      error.cause.code = 'CERT_HAS_EXPIRED';
      throw error;
    },
    curlFetch: async (_url, proxyUrl) => {
      curlCalls.push(proxyUrl);
      return input.cipher_text;
    }
  });

  assert.equal(result.successful_iterations, 1);
  assert.deepEqual(curlCalls, ['']);
});

test('Node extract backend stops consecutive failures without waiting for oversized min iterations', async () => {
  const events = [];

  const result = await fetchSourceLinksWithBackend({
    source_name: 'leiting',
    source: {
      url: 'https://fixture.example/source',
      key: 'abcdabcdabcdabcd',
      max_iterations: 100,
      min_iterations: 10000,
      plateau_limit: 8,
      failure_limit: 3,
      max_runtime_seconds: 0
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1' },
    eventCallback: (type, payload) => events.push({ type, ...payload }),
    fetch: async () => {
      throw new Error('network unreachable');
    }
  });

  assert.equal(result.failed_iterations, 3);
  assert.equal(events.filter((event) => event.type === 'extract_request_result').length, 3);
});

test('Node extract backend defaults plateau limit to 20 when omitted', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const events = [];

  const result = await fetchSourceLinksWithBackend({
    source_name: 'leiting',
    source: {
      url: 'https://fixture.example/source',
      key: input.key,
      max_iterations: 100,
      min_iterations: 10000,
      failure_limit: 1,
      max_runtime_seconds: 0
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1' },
    eventCallback: (type, payload) => events.push({ type, ...payload }),
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => input.cipher_text
    })
  });

  assert.equal(result.successful_iterations, 21);
  assert.equal(result.links.length, 1);
  assert.equal(events.find((event) => event.type === 'extract_source_started')?.min_iterations, 0);
});

test('curl TLS fallback does not expose source URLs in process argv', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const spawns = [];
  let stdinPayload = '';

  const result = await fetchSourceLinksWithBackend({
    source_name: input.source_name,
    source: {
      url: 'https://fixture.example/source?token=secret',
      key: input.key,
      max_iterations: 1,
      min_iterations: 1,
      plateau_limit: 1,
      failure_limit: 1,
      max_runtime_seconds: 0
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1' },
    fetch: async () => {
      throw new Error('certificate has expired');
    },
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write(chunk) {
          stdinPayload += String(chunk);
        },
        end() {
          child.stdout.emit('data', input.cipher_text);
          child.emit('close', 0, null);
        }
      };
      return child;
    }
  });

  assert.equal(result.successful_iterations, 1);
  assert.equal(spawns[0].command, 'curl');
  assert.doesNotMatch(spawns[0].args.join(' '), /fixture\.example|secret/);
  assert.match(stdinPayload, /fixture\.example\/source\?token=secret/);
});

test('Node extract backend only uses upstream proxy when explicitly enabled', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const curlCalls = [];

  await fetchSourceLinksWithBackend({
    source_name: input.source_name,
    source: {
      url: 'https://fixture.example/source',
      key: input.key,
      max_iterations: 1,
      min_iterations: 1,
      plateau_limit: 1,
      failure_limit: 1,
      max_runtime_seconds: 0
    }
  }, {
    env: {
      AUTOVPN_NO_PYTHON: '1',
      VPN_AUTOMATION_USE_UPSTREAM_PROXY: '1',
      VPN_AUTOMATION_UPSTREAM_PROXY: 'http://127.0.0.1:7897'
    },
    fetch: async () => {
      throw new Error('certificate has expired');
    },
    curlFetch: async (url, proxyUrl) => {
      curlCalls.push({ url, proxyUrl });
      return input.cipher_text;
    }
  });

  assert.deepEqual(curlCalls, [{ url: 'https://fixture.example/source', proxyUrl: 'http://127.0.0.1:7897' }]);
});

test('extract ignores legacy Python rollback env without spawning Python', async () => {
  const spawns = [];
  const input = { source_name: 'leiting', source: { url: 'https://example.com/api', key: 'abcdabcdabcdabcd', max_iterations: 0 } };
  const result = await fetchSourceLinksWithBackend(input, {
    env: { AUTOVPN_STAGE_BACKEND_EXTRACT: 'python' },
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
          child.stdout.emit('data', `${JSON.stringify({ source_name: helperInput.source_name, requested_iterations: 0, successful_iterations: 0, failed_iterations: 0, links: [] })}\n`);
          child.emit('close', 0, null);
        }
      };
      return child;
    }
  });

  assert.equal(result.source_name, 'leiting');
  assert.equal(spawns.length, 0);
});

function vmessLink(payload) {
  return `vmess://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function encryptPayload(plaintext, key) {
  const keyBuffer = Buffer.from(key, 'utf8');
  const input = Buffer.from(plaintext, 'utf8');
  const padded = Buffer.concat([input, Buffer.alloc((16 - (input.length % 16)) % 16)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', keyBuffer, keyBuffer);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}
