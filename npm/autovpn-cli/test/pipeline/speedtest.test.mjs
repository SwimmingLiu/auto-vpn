import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  aggregateSpeedMeasurements,
  downloadUrlViaHttpProxy,
  probeSpeedtestLinksInNode,
  selectSpeedtestCandidates,
  speedtestLinksWithBackend
} from '../../dist/pipeline/speedtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'npm', 'autovpn-cli', 'test', 'fixtures', 'node-migration', 'pipeline', 'speedtest');

function streamingBody(byteLength) {
  let sent = false;
  return {
    getReader: () => ({
      read: async () => {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: new Uint8Array(byteLength) };
      },
      cancel: async () => {},
      releaseLock: () => {}
    })
  };
}

test('speedtest fixture output matches Python golden output', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const expected = JSON.parse(await readFile(path.join(fixtureDir, 'output.json'), 'utf8'));

  assert.equal(aggregateSpeedMeasurements(input.measurements), expected.average_download_mb_s);
  assert.deepEqual(selectSpeedtestCandidates(input.probes, input.config.max_download_candidates), expected.selected_links);

  const results = await speedtestLinksWithBackend({
    links: input.links,
    config: input.config
  }, {
    env: {},
    probeLinks: async () => input.probes,
    testLink: async (link) => input.full_results.find((result) => result.link === link)
  });

  assert.deepEqual(results, expected.results);
});

test('selectSpeedtestCandidates uses Python-compatible latency and link ordering', () => {
  assert.deepEqual(selectSpeedtestCandidates([
    { link: 'vmess://z', reachable: true, latency_ms: 0, error: '' },
    { link: 'vmess://b', reachable: true, latency_ms: 10, error: '' },
    { link: 'vmess://a', reachable: true, latency_ms: 10, error: '' },
    { link: 'vmess://down', reachable: false, latency_ms: 0, error: 'timeout' }
  ], 0), ['vmess://a', 'vmess://b', 'vmess://z']);
});

test('Node direct probe retries a transient 502 and succeeds on 204', async () => {
  const statuses = [502, 204];
  const results = await probeSpeedtestLinksInNode({
    links: ['vmess://retry'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 1,
      concurrency: 1,
      probe_url: 'https://probe.example/204'
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    now: (() => {
      const values = [100, 120, 200, 225];
      return () => values.shift();
    })(),
    fetch: async () => {
      const status = statuses.shift();
      return { ok: status === 204, status };
    }
  });

  assert.equal(statuses.length, 0);
  assert.deepEqual(results, [{ link: 'vmess://retry', reachable: true, latency_ms: 25, error: '' }]);
});

test('Node direct probe exhausts bounded retries for a permanent 502', async () => {
  let attempts = 0;
  const results = await probeSpeedtestLinksInNode({
    links: ['vmess://down'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 1,
      concurrency: 1,
      probe_url: 'https://probe.example/204'
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    fetch: async () => {
      attempts += 1;
      return { ok: false, status: 502 };
    }
  });

  assert.equal(attempts, 2);
  assert.deepEqual(results, [{ link: 'vmess://down', reachable: false, latency_ms: 0, error: 'unexpected status 502' }]);
});

test('Node direct probe does not retry a permanent 4xx response', async () => {
  let attempts = 0;
  const results = await probeSpeedtestLinksInNode({
    links: ['vmess://rejected'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 1,
      concurrency: 1,
      probe_url: 'https://probe.example/204'
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    fetch: async () => {
      attempts += 1;
      return { ok: false, status: 403 };
    }
  });

  assert.equal(attempts, 1);
  assert.deepEqual(results, [{ link: 'vmess://rejected', reachable: false, latency_ms: 0, error: 'unexpected status 403' }]);
});

test('Node direct probe retries a tagged internal timeout error', async () => {
  let attempts = 0;
  const results = await probeSpeedtestLinksInNode({
    links: ['vmess://timeout'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 1,
      concurrency: 1,
      probe_url: 'https://probe.example/204'
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('request timed out');
        error.code = 'AUTOVPN_INTERNAL_TIMEOUT';
        throw error;
      }
      return { ok: true, status: 204 };
    }
  });

  assert.equal(attempts, 2);
  assert.equal(results[0].reachable, true);
});

test('Node direct probe does not retry a caller AbortError', async () => {
  let attempts = 0;
  const results = await probeSpeedtestLinksInNode({
    links: ['vmess://caller-abort'],
    config: { min_download_mb_s: 1, timeout_seconds: 1, concurrency: 1, probe_url: 'https://probe.example/204' }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    fetch: async () => {
      attempts += 1;
      const error = new Error('The operation was aborted by the caller');
      error.name = 'AbortError';
      throw error;
    }
  });

  assert.equal(attempts, 1);
  assert.equal(results[0].reachable, false);
});

test('Node direct probe does not retry malformed socket configuration text', async () => {
  let attempts = 0;
  await probeSpeedtestLinksInNode({
    links: ['vmess://malformed'],
    config: { min_download_mb_s: 1, timeout_seconds: 1, concurrency: 1, probe_url: 'https://probe.example/204' }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    fetch: async () => {
      attempts += 1;
      throw new Error('malformed socket configuration');
    }
  });

  assert.equal(attempts, 1);
});

test('Node Mihomo probe retries an unexpected 5xx controller response', async () => {
  let attempts = 0;
  let closes = 0;
  const results = await probeSpeedtestLinksInNode({
    links: ['vmess://mihomo-retry'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 1,
      concurrency: 1,
      probe_url: 'https://probe.example/204'
    },
    runtime_path: '/opt/mihomo'
  }, {
    env: {},
    openMihomoRuntime: async () => ({
      controllerUrl: 'http://127.0.0.1:9090',
      proxyName: 'runtime-node',
      proxies: { http: 'http://127.0.0.1:8080', https: 'http://127.0.0.1:8080' },
      close: async () => { closes += 1; }
    }),
    probeMihomoProxyDelay: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('mihomo proxy delay probe failed with status 502');
      }
      return 24;
    }
  });

  assert.equal(attempts, 2);
  assert.equal(closes, 2);
  assert.deepEqual(results, [{ link: 'vmess://mihomo-retry', reachable: true, latency_ms: 24, error: '' }]);
});

test('Node Mihomo probe retries an actual startup timeout and then succeeds', async () => {
  let attempts = 0;
  const results = await probeSpeedtestLinksInNode({
    links: ['vmess://mihomo-startup-timeout'],
    config: { min_download_mb_s: 1, timeout_seconds: 1, concurrency: 1, probe_url: 'https://probe.example/204' },
    runtime_path: '/opt/mihomo'
  }, {
    env: {},
    openMihomoRuntime: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('proxy port 42123 did not open in time');
        error.code = 'AUTOVPN_INTERNAL_TIMEOUT';
        throw error;
      }
      return {
        controllerUrl: 'http://127.0.0.1:9090',
        proxyName: 'runtime-node',
        proxies: { http: 'http://127.0.0.1:8080', https: 'http://127.0.0.1:8080' },
        close: async () => {}
      };
    },
    probeMihomoProxyDelay: async () => 18
  });

  assert.equal(attempts, 2);
  assert.equal(results[0].reachable, true);
});

test('Node Mihomo probe exhausts bounded retries for startup timeouts', async () => {
  let attempts = 0;
  const results = await probeSpeedtestLinksInNode({
    links: ['vmess://mihomo-startup-timeout'],
    config: { min_download_mb_s: 1, timeout_seconds: 1, concurrency: 1, probe_url: 'https://probe.example/204' },
    runtime_path: '/opt/mihomo'
  }, {
    env: {},
    openMihomoRuntime: async () => {
      attempts += 1;
      const error = new Error('proxy port 42123 did not open in time');
      error.code = 'AUTOVPN_INTERNAL_TIMEOUT';
      throw error;
    }
  });

  assert.equal(attempts, 2);
  assert.equal(results[0].reachable, false);
  assert.equal(results[0].error, 'proxy port 42123 did not open in time');
});

for (const [name, makeError] of [
  ['malformed config', () => new Error('malformed vmess configuration')],
  ['caller abort', () => Object.assign(new Error('The operation was aborted by the caller'), { name: 'AbortError' })]
]) {
  test(`Node Mihomo probe does not retry ${name}`, async () => {
    let attempts = 0;
    await probeSpeedtestLinksInNode({
      links: [`vmess://${name}`],
      config: { min_download_mb_s: 1, timeout_seconds: 1, concurrency: 1, probe_url: 'https://probe.example/204' },
      runtime_path: '/opt/mihomo'
    }, {
      env: {},
      openMihomoRuntime: async () => {
        attempts += 1;
        throw makeError();
      }
    });
    assert.equal(attempts, 1);
  });
}

test('Node direct download uses an alternate URL after the primary fails', async () => {
  const calls = [];
  const timeline = [0, 1000, 2000, 3000];
  const results = await speedtestLinksWithBackend({
    links: ['vmess://alternate'],
    config: {
      min_download_mb_s: 2,
      timeout_seconds: 1,
      concurrency: 1,
      urls: ['https://primary.example/bytes', 'https://alternate.example/bytes'],
      max_download_bytes: 2 * 1024 * 1024,
      max_download_candidates: 1
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    probeLinks: async (links) => links.map((link) => ({ link, reachable: true, latency_ms: 10, error: '' })),
    now: () => timeline.shift(),
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes('primary')) {
        throw new Error('fetch failed');
      }
      return { ok: true, status: 200, body: streamingBody(2 * 1024 * 1024) };
    }
  });

  assert.deepEqual(calls, ['https://primary.example/bytes', 'https://alternate.example/bytes']);
  assert.equal(results[0].reachable, true);
  assert.equal(results[0].average_download_mb_s, 2);
  assert.match(results[0].error, /primary.*fetch failed/);
  assert.equal(results[0].average_download_mb_s >= 2, true);
});

test('Node direct download fails when all configured URLs fail', async () => {
  const results = await speedtestLinksWithBackend({
    links: ['vmess://all-down'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 1,
      concurrency: 1,
      urls: ['https://one.example/bytes', 'https://two.example/bytes'],
      max_download_candidates: 1
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    probeLinks: async (links) => links.map((link) => ({ link, reachable: true, latency_ms: 10, error: '' })),
    fetch: async (url) => {
      throw new Error(`failed ${new URL(String(url)).hostname}`);
    }
  });

  assert.equal(results[0].reachable, false);
  assert.equal(results[0].average_download_mb_s, 0);
  assert.match(results[0].error, /one\.example/);
  assert.match(results[0].error, /two\.example/);
});

test('Node direct download averages only successful endpoint samples', async () => {
  const timeline = [0, 1000, 2000, 3000, 4000, 5000];
  const results = await speedtestLinksWithBackend({
    links: ['vmess://samples'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 1,
      concurrency: 1,
      urls: ['https://one.example/bytes', 'https://failed.example/bytes', 'https://three.example/bytes'],
      max_download_bytes: 3 * 1024 * 1024,
      max_download_candidates: 1
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    probeLinks: async (links) => links.map((link) => ({ link, reachable: true, latency_ms: 10, error: '' })),
    now: () => timeline.shift(),
    fetch: async (url) => {
      if (String(url).includes('failed')) {
        throw new Error('fetch failed');
      }
      const bytes = String(url).includes('one.') ? 1024 * 1024 : 3 * 1024 * 1024;
      return { ok: true, status: 200, body: streamingBody(bytes) };
    }
  });

  assert.equal(results[0].average_download_mb_s, 2);
});

test('Node direct download cancels a streaming reader immediately at the byte cap', async () => {
  let reads = 0;
  let cancels = 0;
  let releases = 0;
  const results = await speedtestLinksWithBackend({
    links: ['vmess://capped-stream'],
    config: {
      min_download_mb_s: 0,
      timeout_seconds: 1,
      concurrency: 1,
      urls: ['https://speed.example/bytes'],
      max_download_bytes: 1024,
      max_download_candidates: 1
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    probeLinks: async (links) => links.map((link) => ({ link, reachable: true, latency_ms: 10, error: '' })),
    fetch: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { done: false, value: new Uint8Array(1024) };
          },
          cancel: async () => { cancels += 1; },
          releaseLock: () => { releases += 1; }
        })
      }
    })
  });

  assert.equal(results[0].reachable, true);
  assert.equal(reads, 1);
  assert.equal(cancels, 1);
  assert.equal(releases, 1);
});

test('Node direct download rejects non-streaming arrayBuffer responses', async () => {
  const results = await speedtestLinksWithBackend({
    links: ['vmess://non-streaming'],
    config: {
      min_download_mb_s: 0,
      timeout_seconds: 1,
      concurrency: 1,
      urls: ['https://speed.example/bytes'],
      max_download_bytes: 1024,
      max_download_candidates: 1
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    probeLinks: async (links) => links.map((link) => ({ link, reachable: true, latency_ms: 10, error: '' })),
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(2048).buffer })
  });

  assert.equal(results[0].reachable, false);
  assert.match(results[0].error, /streaming response body required/);
});

test('Node speedtest backend preserves order semantics, emits progress and events', async () => {
  const events = [];
  const progress = [];
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));

  const results = await speedtestLinksWithBackend({
    links: input.links,
    config: input.config,
    runtime_path: '/opt/mihomo'
  }, {
    env: {},
    probeLinks: async (links, config, options) => {
      assert.deepEqual(links, input.links);
      assert.equal(config.probe_url, input.config.probe_url);
      assert.equal(options.runtime_path, '/opt/mihomo');
      return input.probes;
    },
    testLink: async (link) => input.full_results.find((result) => result.link === link),
    progressCallback: (message) => progress.push(message),
    eventCallback: (eventType, payload) => events.push({ type: eventType, ...payload })
  });

  assert.deepEqual(results.map((result) => result.link), ['vmess://c', 'vmess://b', 'vmess://d']);
  assert.equal(progress[0], '[speedtest] runtime_core=mihomo probe_url=https://www.gstatic.com/generate_204');
  assert.match(progress.at(-1), /\[speedtest\] 2\/2 reachable=true speed=1.7MB\/s/);
  assert.deepEqual(events.map((event) => event.type), [
    'speedtest_runtime',
    'speedtest_probe_result',
    'speedtest_probe_result',
    'speedtest_probe_result',
    'speedtest_probe_result',
    'speedtest_selected',
    'speedtest_result',
    'speedtest_result'
  ]);
  assert.equal(events[5].candidate_count, 2);
  assert.deepEqual(
    events.filter((event) => event.type === 'speedtest_probe_result').map((event) => event.link),
    input.links
  );
});

test('Node speedtest backend runs full download candidates with configured concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const completions = [];
  const results = await speedtestLinksWithBackend({
    links: ['vmess://a', 'vmess://b', 'vmess://c'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 20,
      concurrency: 2,
      urls: ['https://speed.example/bytes'],
      max_download_candidates: 3
    }
  }, {
    env: {},
    probeLinks: async (links) => links.map((link, index) => ({ link, reachable: true, latency_ms: 10 + index, error: '' })),
    testLink: async (link) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, link.endsWith('a') ? 30 : 5));
      active -= 1;
      return { link, reachable: true, average_download_mb_s: 2, latency_ms: 0, error: '' };
    },
    eventCallback: (eventType, payload) => {
      if (eventType === 'speedtest_result') {
        completions.push(payload.completed);
      }
    }
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(results.map((result) => result.link), ['vmess://a', 'vmess://b', 'vmess://c']);
  assert.deepEqual(completions, [1, 2, 3]);
});

test('Node speedtest backend can run direct fetch runtime without Python fallback', async () => {
  const calls = [];
  const timeline = [1000, 1030, 2000, 2100];
  const results = await speedtestLinksWithBackend({
    links: ['vmess://direct'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 20,
      concurrency: 1,
      urls: ['https://speed.example/bytes'],
      probe_url: 'https://probe.example/204',
      max_download_bytes: 1024,
      max_download_candidates: 1
    }
  }, {
    env: { AUTOVPN_NO_PYTHON: '1', AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
    now: () => timeline.shift(),
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://probe.example/204') {
        return { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { ok: true, status: 200, body: streamingBody(1024) };
    }
  });

  assert.deepEqual(calls, ['https://probe.example/204', 'https://speed.example/bytes']);
  assert.deepEqual(results, [{
    link: 'vmess://direct',
    reachable: true,
    average_download_mb_s: 0.01,
    latency_ms: 30,
    error: ''
  }]);
});

test('Node speedtest backend defaults to Mihomo runtime so speed tests use each candidate link', async () => {
  const opened = [];
  const downloads = [];
  const results = await speedtestLinksWithBackend({
    links: ['vmess://default-mihomo'],
    config: {
      min_download_mb_s: 0.001,
      timeout_seconds: 20,
      concurrency: 1,
      urls: ['http://speed.example/bytes'],
      probe_url: 'https://probe.example/204',
      max_download_bytes: 1024,
      max_download_candidates: 1
    },
    runtime_path: '/opt/mihomo'
  }, {
    env: {},
    now: (() => {
      const timeline = [1000, 2000];
      return () => timeline.shift();
    })(),
    openMihomoRuntime: async (link, options) => {
      opened.push({ link, options });
      return {
        controllerUrl: 'http://controller/default',
        proxyName: 'runtime-node',
        proxies: {
          http: 'http://127.0.0.1:18080',
          https: 'http://127.0.0.1:18080'
        },
        close: async () => {}
      };
    },
    probeMihomoProxyDelay: async () => 25,
    downloadUrlViaHttpProxy: async (url, proxyUrl, maxBytes, timeoutSeconds) => {
      downloads.push({ url, proxyUrl, maxBytes, timeoutSeconds });
      return 1024;
    }
  });

  assert.deepEqual(opened.map((item) => item.link), ['vmess://default-mihomo', 'vmess://default-mihomo']);
  assert.deepEqual(opened.map((item) => item.options.runtimePath), ['/opt/mihomo', '/opt/mihomo']);
  assert.deepEqual(downloads, [{
    url: 'http://speed.example/bytes',
    proxyUrl: 'http://127.0.0.1:18080',
    maxBytes: 1024,
    timeoutSeconds: 20
  }]);
  assert.deepEqual(results, [{
    link: 'vmess://default-mihomo',
    reachable: true,
    average_download_mb_s: 0.001,
    latency_ms: 25,
    error: ''
  }]);
});

test('Node speedtest backend times out stalled response bodies', async () => {
  const stalledBody = new ReadableStream({
    pull() {
      return new Promise(() => {});
    }
  });
  const started = Date.now();

  const result = await Promise.race([
    speedtestLinksWithBackend({
      links: ['vmess://stalled'],
      config: {
        min_download_mb_s: 1,
        timeout_seconds: 1,
        concurrency: 1,
        urls: ['https://speed.example/stalled'],
        probe_url: 'https://probe.example/204',
        max_download_bytes: 1024,
        max_download_candidates: 1
      }
    }, {
      env: { AUTOVPN_NO_PYTHON: '1', AUTOVPN_SPEEDTEST_RUNTIME: 'direct' },
      fetch: async (url) => {
        if (String(url) === 'https://probe.example/204') {
          return { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        return { ok: true, status: 200, body: stalledBody };
      }
    }),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 1500))
  ]);

  assert.notEqual(result, 'hung');
  assert.ok(Date.now() - started < 1400);
  assert.deepEqual(result, [{
    link: 'vmess://stalled',
    reachable: false,
    average_download_mb_s: 0,
    latency_ms: 0,
    error: 'https://speed.example/stalled: response body timed out after 1000ms'
  }]);
});

test('Node speedtest backend can probe links through Mihomo runtime when requested', async () => {
  const opened = [];
  const closed = [];
  const results = await speedtestLinksWithBackend({
    links: ['vmess://ok', 'vmess://down'],
    config: {
      min_download_mb_s: 1,
      timeout_seconds: 20,
      concurrency: 1,
      urls: ['https://speed.example/bytes'],
      probe_url: 'https://probe.example/204',
      max_download_candidates: 1
    },
    runtime_path: '/opt/mihomo'
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'mihomo' },
    openMihomoRuntime: async (link, options) => {
      opened.push({ link, options });
      return {
        controllerUrl: `http://controller/${link.slice('vmess://'.length)}`,
        proxyName: 'runtime-node',
        close: async () => closed.push(link)
      };
    },
    probeMihomoProxyDelay: async (controllerUrl, proxyName, probeUrl, timeoutSeconds) => {
      assert.equal(proxyName, 'runtime-node');
      assert.equal(probeUrl, 'https://probe.example/204');
      assert.equal(timeoutSeconds, 20);
      if (controllerUrl.endsWith('/down')) {
        throw new Error('mihomo delay failed');
      }
      return 42;
    },
    testLink: async (link) => ({ link, reachable: true, average_download_mb_s: 2, latency_ms: 0, error: '' })
  });

  assert.deepEqual(opened.map((item) => item.link), ['vmess://ok', 'vmess://down']);
  assert.deepEqual(opened.map((item) => item.options.runtimePath), ['/opt/mihomo', '/opt/mihomo']);
  assert.deepEqual(closed, ['vmess://ok', 'vmess://down']);
  assert.deepEqual(results, [
    { link: 'vmess://down', reachable: false, average_download_mb_s: 0, latency_ms: 0, error: 'mihomo delay failed' },
    { link: 'vmess://ok', reachable: true, average_download_mb_s: 2, latency_ms: 42, error: '' }
  ]);
});

test('downloadUrlViaHttpProxy downloads bytes through an HTTP proxy', async () => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, '/bytes');
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(Buffer.alloc(1024, 7));
  });
  const proxyRequests = [];
  const proxy = http.createServer((clientRequest, clientResponse) => {
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
    clientRequest.pipe(upstreamRequest);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const proxyPort = proxy.address().port;

  try {
    const bytes = await downloadUrlViaHttpProxy(
      `http://127.0.0.1:${upstreamPort}/bytes`,
      `http://127.0.0.1:${proxyPort}`,
      512,
      5
    );

    assert.equal(bytes, 512);
    assert.deepEqual(proxyRequests, [`http://127.0.0.1:${upstreamPort}/bytes`]);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('Node speedtest backend downloads candidate URLs through Mihomo proxy when requested', async () => {
  const downloads = [];
  const closed = [];
  const results = await speedtestLinksWithBackend({
    links: ['vmess://ok'],
    config: {
      min_download_mb_s: 0.001,
      timeout_seconds: 20,
      concurrency: 1,
      urls: ['http://speed.example/bytes'],
      probe_url: 'https://probe.example/204',
      max_download_bytes: 1024,
      max_download_candidates: 1
    }
  }, {
    env: { AUTOVPN_SPEEDTEST_RUNTIME: 'mihomo' },
    now: (() => {
      const timeline = [1000, 2000];
      return () => timeline.shift();
    })(),
    openMihomoRuntime: async (link) => ({
      controllerUrl: 'http://controller/ok',
      proxyName: 'runtime-node',
      proxies: {
        http: 'http://127.0.0.1:18080',
        https: 'http://127.0.0.1:18080'
      },
      close: async () => closed.push(link)
    }),
    probeMihomoProxyDelay: async () => 33,
    downloadUrlViaHttpProxy: async (url, proxyUrl, maxBytes, timeoutSeconds) => {
      downloads.push({ url, proxyUrl, maxBytes, timeoutSeconds });
      return 1024;
    }
  });

  assert.deepEqual(downloads, [{
    url: 'http://speed.example/bytes',
    proxyUrl: 'http://127.0.0.1:18080',
    maxBytes: 1024,
    timeoutSeconds: 20
  }]);
  assert.deepEqual(closed, ['vmess://ok', 'vmess://ok']);
  assert.deepEqual(results, [{
    link: 'vmess://ok',
    reachable: true,
    average_download_mb_s: 0.001,
    latency_ms: 33,
    error: ''
  }]);
});

test('speedtest backend API preserves Node dependency injection', async () => {
  const input = { links: ['vmess://node'], config: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 1, urls: [] } };

  assert.deepEqual(await speedtestLinksWithBackend(input, {
    probeLinks: async () => [{ link: 'vmess://node', reachable: true, latency_ms: 10, error: '' }],
    testLink: async (link) => ({ link, reachable: true, average_download_mb_s: 0, latency_ms: 10, error: '' })
  }), [{ link: 'vmess://node', reachable: true, average_download_mb_s: 0, latency_ms: 10, error: '' }]);
});
