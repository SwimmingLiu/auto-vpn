import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  availabilityResultToDict,
  checkLinkAvailabilityBatchWithBackend,
  evaluateProviderResponse,
  fetchUrlViaHttpProxy,
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

function createForwardingHttpProxy(proxyRequests) {
  return http.createServer((clientRequest, clientResponse) => {
    proxyRequests.push(String(clientRequest.url));
    const target = new URL(String(clientRequest.url));
    const upstreamRequest = http.request({
      hostname: target.hostname,
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: clientRequest.method
    }, (upstreamResponse) => {
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(clientResponse);
    });
    upstreamRequest.once('error', (error) => {
      clientResponse.writeHead(502, { 'content-type': 'text/plain' });
      clientResponse.end(error instanceof Error ? error.message : String(error));
    });
    if (clientRequest.method === 'GET' || clientRequest.method === 'HEAD') {
      upstreamRequest.end();
    } else {
      clientRequest.pipe(upstreamRequest);
    }
  });
}

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

test('evaluateProviderResponse accepts the expected ChatGPT iOS availability response', () => {
  const result = evaluateProviderResponse({
    name: 'chatgpt_ios',
    url: 'https://ios.chat.openai.com/',
    allowed_hosts: ['ios.chat.openai.com'],
    negative_phrases: []
  }, {
    final_url: 'https://ios.chat.openai.com/',
    status_code: 403,
    title: '',
    body: 'Request is not allowed. Please try again later.'
  });

  assert.equal(result.passed, true);
  assert.equal(result.reason, 'ok');
});

test('evaluateProviderResponse normalizes spaced ChatGPT iOS target names', () => {
  const result = evaluateProviderResponse({
    name: 'ChatGPT iOS',
    url: 'https://ios.chat.openai.com/',
    allowed_hosts: ['ios.chat.openai.com'],
    negative_phrases: []
  }, {
    final_url: 'https://ios.chat.openai.com/',
    status_code: 403,
    title: '',
    body: 'Request is not allowed. Please try again later.'
  });

  assert.equal(result.passed, true);
  assert.equal(result.reason, 'ok');
});

test('evaluateProviderResponse rejects Gemini blocked regions returned with HTTP 200', () => {
  const result = evaluateProviderResponse({
    name: 'gemini',
    url: 'https://gemini.google.com/',
    allowed_hosts: ['gemini.google.com'],
    negative_phrases: []
  }, {
    final_url: 'https://gemini.google.com/',
    status_code: 200,
    title: '',
    body: 'prefix,2,1,200,"CHNsuffix'
  });

  assert.equal(result.passed, false);
  assert.equal(result.reason, 'unsupported_region');
  assert.equal(result.matched_phrase, 'CHN');
});

test('evaluateProviderResponse rejects ChatGPT Web unsupported countries returned with HTTP 200', () => {
  const result = evaluateProviderResponse({
    name: 'chatgpt_web',
    url: 'https://api.openai.com/compliance/cookie_requirements',
    allowed_hosts: ['api.openai.com'],
    negative_phrases: []
  }, {
    final_url: 'https://api.openai.com/compliance/cookie_requirements',
    status_code: 200,
    title: '',
    body: '{"unsupported_country":true}'
  });

  assert.equal(result.passed, false);
  assert.equal(result.reason, 'unsupported_region');
  assert.equal(result.matched_phrase, 'unsupported_country');
});

test('evaluateProviderResponse rejects Claude blocked regions returned with HTTP 200', () => {
  const result = evaluateProviderResponse({
    name: 'claude',
    url: 'https://claude.ai/cdn-cgi/trace',
    allowed_hosts: ['claude.ai'],
    negative_phrases: []
  }, {
    final_url: 'https://claude.ai/cdn-cgi/trace',
    status_code: 200,
    title: '',
    body: 'loc=CN\n'
  });

  assert.equal(result.passed, false);
  assert.equal(result.reason, 'unsupported_region');
  assert.equal(result.matched_phrase, 'CN');
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

test('Node availability batch checks links with configured concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const results = [
    { ...speedResult, link: 'vmess://a' },
    { ...speedResult, link: 'vmess://b' },
    { ...speedResult, link: 'vmess://c' }
  ];

  const batch = await checkLinkAvailabilityBatchWithBackend({
    results,
    config: { concurrency: 2, timeout_seconds: 20 },
    targets: {
      custom: { url: 'https://custom.example/', enabled: true, allowed_hosts: ['custom.example'], negative_phrases: [] }
    }
  }, {
    env: {},
    checkLinkAvailability: async (speed) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, speed.link.endsWith('a') ? 30 : 5));
      active -= 1;
      return {
        speed_result: speed,
        provider_results: {
          custom: { provider: 'custom', passed: true, reason: 'ok', status_code: 200, final_url: 'https://custom.example/', matched_phrase: '' }
        }
      };
    }
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(batch.map((item) => item.link), ['vmess://a', 'vmess://b', 'vmess://c']);
});

test('Node availability returns an empty result without requiring a runtime checker', async () => {
  assert.deepEqual(await checkLinkAvailabilityBatchWithBackend({
    results: [],
    config: {},
    runtime_path: '/tmp/runtime',
    targets: null
  }, {
    env: { AUTOVPN_NO_PYTHON: '1' }
  }), []);
});

test('Node availability backend can run direct fetch runtime without Python fallback', async () => {
  const calls = [];
  const result = await checkLinkAvailabilityBatchWithBackend({
    results: [speedResult],
    config: { concurrency: 1, timeout_seconds: 20 },
    runtime_path: '/tmp/runtime',
    targets: {
      custom: { url: 'https://custom.example/', enabled: true, allowed_hosts: ['custom.example'], negative_phrases: ['blocked'] }
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1', AUTOVPN_AVAILABILITY_RUNTIME: 'direct' },
    fetch: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        url: String(url),
        text: async () => '<html><title>OK</title><body>available</body></html>'
      };
    }
  });

  assert.deepEqual(calls, ['https://custom.example/']);
  assert.equal(result[0].all_passed, true);
  assert.equal(result[0].provider_results.custom.reason, 'ok');
  assert.equal(result[0].provider_results.custom.final_url, 'https://custom.example/');
});

test('Node availability backend checks providers through Mihomo proxy by default', async () => {
  const opened = [];
  const closed = [];
  const fetches = [];
  const result = await checkLinkAvailabilityBatchWithBackend({
    results: [
      { ...speedResult, link: 'vmess://node-a' },
      { ...speedResult, link: 'vmess://node-b' }
    ],
    config: { concurrency: 2, timeout_seconds: 20, startup_wait_seconds: 1 },
    runtime_path: '/opt/mihomo',
    targets: {
      custom: { url: 'http://custom.example/ok', enabled: true, allowed_hosts: ['custom.example'], negative_phrases: ['blocked'] }
    }
  }, {
    env: {},
    openMihomoRuntime: async (link, options) => {
      opened.push({ link, options });
      const port = link.endsWith('-a') ? 18080 : 18081;
      return {
        proxies: {
          http: `http://127.0.0.1:${port}`,
          https: `http://127.0.0.1:${port}`
        },
        close: async () => closed.push(link)
      };
    },
    fetchUrlViaHttpProxy: async (url, proxyUrl, timeoutSeconds) => {
      fetches.push({ url, proxyUrl, timeoutSeconds });
      return {
        final_url: url,
        status_code: 200,
        body: '<html><title>OK</title><body>available</body></html>'
      };
    }
  });

  assert.deepEqual(opened.map(({ link }) => link).sort(), ['vmess://node-a', 'vmess://node-b']);
  assert.deepEqual(opened.map(({ options }) => options), [
    { runtimePath: '/opt/mihomo', startupWaitSeconds: 1, env: {} },
    { runtimePath: '/opt/mihomo', startupWaitSeconds: 1, env: {} }
  ]);
  assert.deepEqual(fetches.map(({ proxyUrl }) => proxyUrl).sort(), [
    'http://127.0.0.1:18080',
    'http://127.0.0.1:18081'
  ]);
  assert.ok(fetches.every(({ url, timeoutSeconds }) => url === 'http://custom.example/ok' && timeoutSeconds === 20));
  assert.deepEqual(closed.sort(), ['vmess://node-a', 'vmess://node-b']);
  assert.ok(result.every((item) => item.all_passed && item.provider_results.custom.reason === 'ok'));
});

test('fetchUrlViaHttpProxy returns provider status and body through an HTTP proxy', async () => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, '/ok');
    response.writeHead(202, { 'content-type': 'text/html' });
    response.end('<html><title>OK</title><body>available</body></html>');
  });
  const proxyRequests = [];
  const proxy = createForwardingHttpProxy(proxyRequests);
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const proxyPort = proxy.address().port;

  try {
    const response = await fetchUrlViaHttpProxy(
      `http://127.0.0.1:${upstreamPort}/ok`,
      `http://127.0.0.1:${proxyPort}`,
      5
    );

    assert.deepEqual(response, {
      final_url: `http://127.0.0.1:${upstreamPort}/ok`,
      status_code: 202,
      body: '<html><title>OK</title><body>available</body></html>'
    });
    assert.deepEqual(proxyRequests, [`http://127.0.0.1:${upstreamPort}/ok`]);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('fetchUrlViaHttpProxy follows redirects and reports the final provider URL', async () => {
  const upstream = http.createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { location: '/final' });
      response.end();
      return;
    }
    assert.equal(request.url, '/final');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><title>Final</title><body>available</body></html>');
  });
  const proxyRequests = [];
  const proxy = createForwardingHttpProxy(proxyRequests);
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const proxyPort = proxy.address().port;

  try {
    const response = await fetchUrlViaHttpProxy(
      `http://127.0.0.1:${upstreamPort}/start`,
      `http://127.0.0.1:${proxyPort}`,
      5
    );

    assert.deepEqual(response, {
      final_url: `http://127.0.0.1:${upstreamPort}/final`,
      status_code: 200,
      body: '<html><title>Final</title><body>available</body></html>'
    });
    assert.deepEqual(proxyRequests, [
      `http://127.0.0.1:${upstreamPort}/start`,
      `http://127.0.0.1:${upstreamPort}/final`
    ]);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('fetchUrlViaHttpProxy rejects an HTTPS tunnel that closes before a provider response', async () => {
  const proxy = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.end();
    });
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;

  try {
    await assert.rejects(
      () => fetchUrlViaHttpProxy('https://example.com/', `http://127.0.0.1:${proxyPort}`, 1),
      /TLS|socket|closed|ended|reset|hang up/i
    );
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test('availability backend selection always uses the Node engine', async () => {
  assert.equal(selectPipelineStageBackend('availability', {}), 'node');
  assert.equal(selectPipelineStageBackend('availability', { AUTOVPN_PIPELINE_BACKEND: ' HYBRID ' }), 'node');
  assert.equal(selectPipelineStageBackend('availability', { AUTOVPN_PIPELINE_BACKEND: ' PYTHON ' }), 'node');
  assert.equal(selectPipelineStageBackend('availability', { AUTOVPN_STAGE_BACKEND_AVAILABILITY: ' python ' }), 'node');
  assert.equal(selectPipelineStageBackend('availability', { AUTOVPN_PIPELINE_BACKEND: 'python', AUTOVPN_STAGE_BACKEND_AVAILABILITY: '' }), 'node');

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
    pythonAvailability: fallback,
    checkLinkAvailability: async (speed) => ({ speed_result: speed, provider_results: {} })
  }), [{
    link: speedResult.link,
    reachable: speedResult.reachable,
    average_download_mb_s: speedResult.average_download_mb_s,
    latency_ms: speedResult.latency_ms,
    all_passed: true,
    provider_results: {}
  }]);
  assert.deepEqual(fallbackCalls, []);
});

test('availability ignores legacy Python rollback env without spawning Python', async () => {
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
  assert.equal(spawns.length, 0);
});
