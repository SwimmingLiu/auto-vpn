import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactLatest, artifactList } from '../dist/artifacts/list.js';
import { parseFinalNode, previewArtifact } from '../dist/artifacts/preview.js';

function vmess(ps, extra = {}) {
  const payload = { v: '2', ps, add: '203.0.113.7', port: '443', id: 'fixture-uuid', net: 'ws', path: '/edge', ...extra };
  return 'vmess://' + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

test('artifactLatest restores missing counts from artifact files', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-artifact-latest-'));
  const artifactsRoot = path.join(projectRoot, 'artifacts');
  const artifactDir = path.join(artifactsRoot, '20260709-012000');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), {
    run_status: '',
    stage_status: { dedupe: 'success', speedtest: 'running' },
    counts: { raw_links: 0, speedtest_links: 1 },
    source_counts: {}
  });
  fs.writeFileSync(path.join(artifactDir, 'vpn_node_raw.txt'), 'raw-1\nraw-2\nraw-3\n', 'utf8');
  fs.writeFileSync(path.join(artifactDir, 'vpn_node_deduped.txt'), 'deduped-1\n\ndeduped-2\n', 'utf8');
  fs.writeFileSync(path.join(artifactDir, 'vpn_node_speedtest.txt'), 'speed-1\nspeed-2\n', 'utf8');

  const result = artifactLatest(projectRoot, { VPN_AUTOMATION_ARTIFACTS_ROOT: artifactsRoot });

  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, {
    raw_links: 3,
    speedtest_links: 1,
    deduped_links: 2
  });
});

test('artifactList restores missing counts from each artifact directory', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-artifact-list-'));
  const artifactsRoot = path.join(projectRoot, 'artifacts');
  const artifactDir = path.join(artifactsRoot, '20260709-013000');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), {
    run_status: '',
    stage_status: { availability: 'running' },
    counts: {},
    source_counts: {}
  });
  fs.writeFileSync(path.join(artifactDir, 'vpn_node_deduped.txt'), 'deduped-1\ndeduped-2\ndeduped-3\n', 'utf8');
  fs.writeFileSync(path.join(artifactDir, 'vpn_node_availability.txt'), 'available-1\n', 'utf8');

  const result = artifactList(projectRoot, { VPN_AUTOMATION_ARTIFACTS_ROOT: artifactsRoot });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].counts, {
    deduped_links: 3,
    availability_links: 1
  });
});

test('daily node activity includes retained runs beyond the twenty retry choices', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-activity-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const artifactsRoot = path.join(projectRoot, 'artifacts');
  for (let day = 1; day <= 25; day += 1) {
    const stamp = '202611' + String(day).padStart(2, '0');
    writeJson(path.join(artifactsRoot, stamp + '-120000', 'pipeline_report.json'), {
      run_status: 'success', counts: { final_links: day }
    });
  }
  writeJson(path.join(artifactsRoot, '20261101-130000', 'pipeline_report.json'), { counts: { final_links: 5 } });
  const result = artifactList(projectRoot, { VPN_AUTOMATION_ARTIFACTS_ROOT: artifactsRoot });
  assert.equal(result.items.length, 20);
  assert.equal(result.activity.length, 25);
  assert.deepEqual(result.activity[0], { date: '2026-11-01', nodes: 6, runs: 2 });
  assert.equal(result.activity.reduce((sum, day) => sum + day.nodes, 0), 330);
});

test('activity counts final output and isolates damaged or intermediate-only history', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-activity-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactsRoot = path.join(root, 'artifacts');
  const old = path.join(artifactsRoot, '20261001-120000');
  writeJson(path.join(old, 'pipeline_report.json'), {});
  fs.writeFileSync(path.join(old, 'pipeline_report.json'), '{');
  fs.utimesSync(old, 1, 1);
  for (let day = 1; day <= 21; day += 1) writeJson(path.join(artifactsRoot, '202611' + String(day).padStart(2, '0') + '-120000', 'pipeline_report.json'), { counts: { final_links: 1 } });
  const final = path.join(artifactsRoot, '20261122-120000');
  writeJson(path.join(final, 'pipeline_report.json'), { counts: { availability_links: 17, postprocess_links: 3 } });
  fs.writeFileSync(path.join(final, 'vpn_node_emoji.txt'), 'one\ntwo\nthree\n');
  writeJson(path.join(artifactsRoot, '20261123-120000', 'pipeline_report.json'), { run_status: 'failed', counts: { availability_links: 17 } });
  const result = artifactList(root, { VPN_AUTOMATION_ARTIFACTS_ROOT: artifactsRoot });
  assert.equal(result.activity.find((day) => day.date === '2026-11-22').nodes, 3);
  assert.equal(result.activity.some((day) => day.date === '2026-11-23'), false);
  assert.equal(result.activityUnavailable, 2);
});

test('final node rows carry the decorated country so the browser UI can chart it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-preview-rows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, 'artifacts', '20261111-042453');
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, 'pipeline_report.json'), { run_status: 'success', counts: { final_links: 4 } });
  fs.writeFileSync(path.join(artifactDir, 'vpn_node_emoji.txt'), [
    vmess('🇺🇸 US 76'),
    vmess('🇺🇸 US 77'),
    vmess('🇹🇼 TW 972'),
    vmess('🇩🇪 DE Frankfurt', { path: '/path/350214042616' })
  ].join('\n') + '\n', 'utf8');

  const preview = previewArtifact(artifactDir, { includeNodeRows: true });
  assert.equal(preview.nodeRows.length, 4);
  assert.deepEqual(preview.nodeRows.map((row) => row.regionCode), ['US', 'US', 'TW', 'DE']);
  assert.deepEqual(preview.nodeRows[3], {
    name: '🇩🇪 DE Frankfurt',
    address: '203.0.113.7',
    protocol: 'vmess',
    path: '/path/350214042616',
    link: vmess('🇩🇪 DE Frankfurt', { path: '/path/350214042616' }),
    regionCode: 'DE'
  });
  assert.deepEqual(preview.safe_node_counts, {
    node_source: 'vpn_node_emoji.txt',
    final_node_count: 4,
    regions: [{ region_code: 'DE', count: 1 }, { region_code: 'TW', count: 1 }, { region_code: 'US', count: 2 }]
  });
  // The CLI's own `artifact preview` stays compact: counts and regions only.
  assert.equal('nodeRows' in previewArtifact(artifactDir), false);
});

test('a node name without a decorated prefix is unknown, not silently a country', () => {
  // The old region reader matched the first two-letter token anywhere in the
  // name, so a vendor name like "US" or a bare token became a false country.
  // Postprocess always writes `<flag> <CC> name`; anything else is OTHER.
  assert.equal(parseFinalNode(vmess('US 76')).regionCode, 'OTHER');
  assert.equal(parseFinalNode(vmess('plain node')).regionCode, 'OTHER');
  assert.equal(parseFinalNode(vmess('🇶🇶 QQ fake')).regionCode, 'OTHER');
  assert.equal(parseFinalNode('ps|{"ps":"🇯🇵 JP 1"}').regionCode, 'OTHER');
  assert.equal(parseFinalNode('vmess://not-base64!!').regionCode, 'OTHER');
  assert.equal(parseFinalNode('trojan://example').protocol, 'trojan');
});
