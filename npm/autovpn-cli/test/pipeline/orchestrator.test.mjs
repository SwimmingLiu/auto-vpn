import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runNodePipeline } from '../../dist/pipeline/orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'node-migration', 'pipeline', 'orchestrator');

function vmessLink(name, address) {
  return `vmess://${Buffer.from(JSON.stringify({
    v: 2,
    ps: name,
    add: address,
    port: '443',
    id: '11111111-1111-1111-1111-111111111111',
    aid: '0',
    scy: 'auto',
    net: 'ws',
    type: 'dtls',
    host: address,
    path: '/',
    tls: 'tls',
    sni: address
  }), 'utf8').toString('base64url')}`;
}

function vmessName(link) {
  return JSON.parse(Buffer.from(link.replace(/^vmess:\/\//, ''), 'base64url').toString('utf8')).ps;
}

async function makeProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-node-run-'));
  await mkdir(path.join(projectRoot, 'templates'), { recursive: true });
  await mkdir(path.join(projectRoot, 'state'), { recursive: true });
  await writeFile(path.join(projectRoot, 'pyproject.toml'), '[project]\nname = "fixture"\n', 'utf8');
  await writeFile(path.join(projectRoot, 'state', 'profile.toml'), await readFile(path.join(fixtureDir, 'profile.toml'), 'utf8'), 'utf8');
  await writeFile(path.join(projectRoot, 'templates', 'vmess_node.js'), await readFile(path.join(fixtureDir, 'template.js'), 'utf8'), 'utf8');
  return projectRoot;
}

test('runNodePipeline emits compatible events and writes non-deploy artifacts', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const firstLink = vmessLink('first', 'one.example');
  const secondLink = vmessLink('second', 'two.example');
  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink, firstLink, secondLink] }),
      speedtest: async (links) => links.map((link, index) => ({ link, reachable: true, average_download_mb_s: index === 0 ? 3 : 2, latency_ms: 20 + index, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: { custom: { provider: 'custom', passed: true, reason: 'ok', status_code: 200, final_url: 'https://custom.example/', matched_phrase: '' } } })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { main_module: '_worker.js', modules: [] } })
    }
  });

  assert.equal(result.run_status, 'success');
  assert.equal(result.counts.raw_links, 3);
  assert.equal(result.counts.deduped_links, 2);
  assert.equal(result.counts.speedtest_links, 2);
  assert.equal(result.counts.availability_links, 2);
  assert.equal(result.counts.final_links, 2);
  assert.deepEqual(events.map((event) => event.type).filter((type) => type === 'summary'), ['summary']);

  const artifactDir = result.artifact_dir;
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_raw.txt'), 'utf8')).trim().split(/\n/).length, 3);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_deduped.txt'), 'utf8')).trim().split(/\n/).length, 2);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_speedtest.txt'), 'utf8')).trim().split(/\n/).length, 2);
  assert.equal((await readFile(path.join(artifactDir, 'vpn_node_availability.txt'), 'utf8')).trim().split(/\n/).length, 2);
  const decoratedNames = (await readFile(path.join(artifactDir, 'vpn_node_emoji.txt'), 'utf8')).trim().split(/\n/).map(vmessName);
  assert.deepEqual(decoratedNames, ['\u{1F1FA}\u{1F1F8} US first', '\u{1F1FA}\u{1F1F8} US second']);
  assert.equal(JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8')).run_status, 'success');
});

test('runNodePipeline loads project .env before resolving profile and artifacts paths', async () => {
  const projectRoot = await makeProject();
  const artifactsRoot = path.join(projectRoot, 'env-artifacts');
  await writeFile(path.join(projectRoot, '.env'), [
    `VPN_AUTOMATION_PROFILE_PATH=${path.join(projectRoot, 'state', 'profile.toml')}`,
    `VPN_AUTOMATION_ARTIFACTS_ROOT=${artifactsRoot}`,
    ''
  ].join('\n'), 'utf8');

  const firstLink = vmessLink('first', 'one.example');
  const result = await runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    now: () => new Date('2026-06-29T01:02:03Z'),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async (links) => links.map((link) => ({ link, reachable: true, average_download_mb_s: 3, latency_ms: 20, error: '' })),
      availability: async (results) => results.map((speedResult) => ({ ...speedResult, all_passed: true, provider_results: {} })),
      countryLookup: () => 'US',
      obfuscate: async ({ transformedSource }) => ({ transformed_source: transformedSource, modules: {}, manifest: { modules: [] } })
    }
  });

  assert.equal(result.run_status, 'success');
  assert.equal(path.dirname(result.artifact_dir), artifactsRoot);
});

test('runNodePipeline marks the active stage failed and writes a summary on errors', async () => {
  const projectRoot = await makeProject();
  const events = [];
  const firstLink = vmessLink('first', 'one.example');

  await assert.rejects(() => runNodePipeline({
    projectRoot,
    skipDeploy: true,
    skipVerify: true,
    output: 'jsonl'
  }, {
    env: {
      VPN_AUTOMATION_RUNTIME_ROOT: path.join(projectRoot, '.runtime'),
      VPN_AUTOMATION_PROFILE_PATH: path.join(projectRoot, 'state', 'profile.toml')
    },
    now: () => new Date('2026-06-29T01:02:03Z'),
    emit: (event) => events.push(event),
    stages: {
      extract: async () => ({ source_name: 'fixture', requested_iterations: 1, successful_iterations: 1, failed_iterations: 0, links: [firstLink] }),
      speedtest: async () => {
        throw new Error('speedtest fixture boom');
      }
    }
  }), /speedtest fixture boom/);

  const artifactDir = events.find((event) => event.type === 'run_started').artifact_dir;
  const report = JSON.parse(await readFile(path.join(artifactDir, 'pipeline_report.json'), 'utf8'));
  assert.equal(report.run_status, 'failed');
  assert.equal(report.stage_status.speedtest, 'failed');
  assert.match(report.error, /speedtest fixture boom/);
  assert.equal(events.at(-1).type, 'summary');
  assert.equal(events.at(-1).run_status, 'failed');
});
