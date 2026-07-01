import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  aggregateSpeedMeasurements,
  selectPipelineStageBackend,
  selectSpeedtestCandidates,
  speedtestLinksWithBackend
} from '../../dist/pipeline/speedtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'node-migration', 'pipeline', 'speedtest');

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
  assert.deepEqual(events.map((event) => event.type), ['speedtest_runtime', 'speedtest_selected', 'speedtest_result', 'speedtest_result']);
  assert.equal(events[1].candidate_count, 2);
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
    env: { AUTOVPN_NO_PYTHON: '1' },
    now: () => timeline.shift(),
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://probe.example/204') {
        return { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(1024).buffer };
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

test('speedtest backend selection supports Node default and Python rollback flags', async () => {
  assert.equal(selectPipelineStageBackend('speedtest', {}), 'node');
  assert.equal(selectPipelineStageBackend('speedtest', { AUTOVPN_PIPELINE_BACKEND: ' HYBRID ' }), 'node');
  assert.equal(selectPipelineStageBackend('speedtest', { AUTOVPN_PIPELINE_BACKEND: ' PYTHON ' }), 'python');
  assert.equal(selectPipelineStageBackend('speedtest', { AUTOVPN_STAGE_BACKEND_SPEEDTEST: ' python ' }), 'python');

  const input = { links: ['vmess://node'], config: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 1, urls: [] } };
  const fallbackCalls = [];
  const fallback = async (payload) => {
    fallbackCalls.push(payload);
    return [{ link: payload.links[0], reachable: true, average_download_mb_s: 0, latency_ms: 10, error: '' }];
  };

  assert.deepEqual(await speedtestLinksWithBackend(input, {
    env: {},
    probeLinks: async () => [{ link: 'vmess://node', reachable: true, latency_ms: 10, error: '' }],
    testLink: async (link) => ({ link, reachable: true, average_download_mb_s: 0, latency_ms: 10, error: '' })
  }), [{ link: 'vmess://node', reachable: true, average_download_mb_s: 0, latency_ms: 10, error: '' }]);
  assert.deepEqual(await speedtestLinksWithBackend(input, {
    env: { AUTOVPN_STAGE_BACKEND_SPEEDTEST: 'python' },
    pythonSpeedtest: fallback
  }), [{ link: 'vmess://node', reachable: true, average_download_mb_s: 0, latency_ms: 10, error: '' }]);
  assert.deepEqual(fallbackCalls, [input]);
});

test('Python speedtest rollback adapter invokes backend venv Python when no callback is injected', async () => {
  const spawns = [];
  const input = { links: [], config: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 1, urls: [] } };
  const result = await speedtestLinksWithBackend(input, {
    env: { AUTOVPN_STAGE_BACKEND_SPEEDTEST: 'python' },
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
          JSON.parse(this.input);
          child.stdout.emit('data', '[]\n');
          child.emit('close', 0, null);
        }
      };
      return child;
    }
  });

  assert.deepEqual(result, []);
  assert.equal(spawns[0].command, '/opt/autovpn/.venv/bin/python');
  assert.equal(spawns[0].args[0], '-c');
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});
