import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactLatest, artifactList } from '../dist/artifacts/list.js';

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
