import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { completedSummary } from '../src/run-log.mjs';

/**
 * A run id names one attempt, and its JSONL log is the only durable record of
 * that attempt. The Durable Object can lose the reply to a `/run` it
 * successfully posted — an eviction between the request and the phase write —
 * and retry the same id minutes later. `startRun` refuses to restart an id
 * whose log already ends in a summary; these tests pin the reading that
 * decision depends on.
 */

async function logWith(lines) {
  const dir = await mkdtemp(path.join(tmpdir(), 'autovpn-run-'));
  const logPath = path.join(dir, 'cron-x-deploy.jsonl');
  await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
  return logPath;
}

test('a successful run is recognised by its summary', async () => {
  const summary = await completedSummary(await logWith([
    JSON.stringify({ type: 'stage', stage: 'render', status: 'success' }),
    JSON.stringify({ type: 'summary', run_status: 'success', artifact_dir: '/data/x' })
  ]));
  assert.equal(summary.run_status, 'success');
  assert.equal(summary.artifact_dir, '/data/x');
});

test('a failed run is replayed as failed, not restarted as a fresh deploy', async () => {
  const summary = await completedSummary(await logWith([
    JSON.stringify({ type: 'summary', run_status: 'failed', error: 'Cloudflare deployment failed' })
  ]));
  assert.equal(summary.run_status, 'failed');
  assert.match(summary.error, /deployment failed/);
});

test('a run still writing has no summary', async () => {
  // The file ends mid-object, exactly as it does while the CLI appends.
  const summary = await completedSummary(await logWith([
    JSON.stringify({ type: 'stage', stage: 'deploy', status: 'running' }),
    '{"type":"summary","run_status":"succ'
  ]));
  assert.equal(summary, null);
});

test('an empty log is not a finished run', async () => {
  assert.equal(await completedSummary(await logWith([''])), null);
});

test('an absent log is not a finished run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'autovpn-run-'));
  assert.equal(await completedSummary(path.join(dir, 'never-started.jsonl')), null);
});
