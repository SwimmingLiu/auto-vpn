import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'server', 'daily-run.sh');

async function readScript() {
  return fs.readFile(scriptPath, 'utf8');
}

test('the daily run always measures and only deploys above the node gate', async () => {
  const script = await readScript();
  // The measurement run must never deploy on its own: the gate decides that
  // after the final count is known.
  assert.match(script, /cli run --skip-deploy --skip-verify --output jsonl/);
  assert.match(script, /cli retry-stage --artifact-dir "\$artifact_dir" --stage deploy --output jsonl/);
  // The deploy must sit behind the comparison, and the comparison must be
  // strictly greater so the documented "greater than 50" reading holds.
  const gateIndex = script.indexOf('if [ "$final_links" -le "$min_final_nodes" ]');
  const deployIndex = script.indexOf('cli retry-stage --artifact-dir');
  assert.ok(gateIndex > 0, 'the gate comparison is missing');
  assert.ok(deployIndex > gateIndex, 'the deploy must run after the gate');
  assert.match(script, /DEFAULT_MIN_FINAL_NODES=50/);
  assert.match(script, /daily-run\.json/);
});

test('the daily run holds the deployment on a thin sweep without failing the job', async () => {
  const script = await readScript();
  // A held run is an expected outcome: it records the result and exits 0, so
  // cron does not report a broken schedule every night the pool is thin.
  const holdBlock = script.slice(script.indexOf('holding the current deployment'));
  const exitAfterHold = holdBlock.slice(0, holdBlock.indexOf('fi\n') + 3);
  assert.match(exitAfterHold, /"status":"held"/);
  assert.match(exitAfterHold, /exit 0/);
});

test('the daily run serializes ticks and refuses to start without the CLI', async () => {
  const script = await readScript();
  assert.match(script, /flock -n 9/);
  assert.match(script, /CLI entry not found/);
  // A run that produced no summary is a real failure, not a quiet skip — and
  // the script has to survive reaching that branch: under `set -e` a grep with
  // no match would abort the assignment before the check runs.
  assert.match(script, /no summary event/);
  assert.match(script, /"status":"failed"/);
  for (const line of script.split('\n').filter((text) => text.includes("grep -a '\"type\":\"summary\"'"))) {
    assert.match(line, /\|\| true/, `unguarded summary grep under set -e: ${line.trim()}`);
  }
});

test('the daily run reads its threshold from the runtime root', async () => {
  const script = await readScript();
  assert.match(script, /AUTOVPN_RUNTIME_ROOT:-\$HOME\/\.auto-vpn/);
  assert.match(script, /AUTOVPN_DAILY_CONFIG:-\$RUNTIME_ROOT\/daily-run\.json/);
  assert.match(script, /min_final_nodes/);
});

async function runConfigReader(configPath) {
  const script = await readScript();
  // Pull the config reader out of the script and run it with the real node
  // binary so a shape change in either half breaks here, not on the server.
  const match = script.match(/"\$NODE_BIN" -e '\n([\s\S]*?)\n' "\$CONFIG_PATH" "\$DEFAULT_MIN_FINAL_NODES" "\$DEFAULT_SOURCE_RUNTIME_SECONDS"\)"/);
  assert.ok(match, 'the config reader snippet is missing');
  const result = spawnSync(process.execPath, ['-e', match[1], configPath, '50', '900'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('the gate config file parses the way the script reads it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-run-config-'));
  const configPath = path.join(dir, 'daily-run.json');
  await fs.writeFile(configPath, '{"min_final_nodes": 73, "enabled": true}\n', 'utf8');
  assert.equal(await runConfigReader(configPath), '73 900 enabled');

  // A malformed file falls back to the shipped defaults instead of silently
  // disabling the gate (a NaN comparison would deploy everything).
  await fs.writeFile(configPath, '{ not json', 'utf8');
  assert.equal(await runConfigReader(configPath), '50 900 enabled');

  await fs.writeFile(configPath, '{"min_final_nodes": -4}', 'utf8');
  assert.equal(await runConfigReader(configPath), '50 900 enabled');

  await fs.writeFile(configPath, '{"enabled": false}', 'utf8');
  assert.equal(await runConfigReader(configPath), '50 900 disabled');

  // 0 means "no budget", which is a real choice; a bad value is not.
  await fs.writeFile(configPath, '{"source_runtime_seconds": 0}', 'utf8');
  assert.equal(await runConfigReader(configPath), '50 0 enabled');
  await fs.writeFile(configPath, '{"source_runtime_seconds": "soon"}', 'utf8');
  assert.equal(await runConfigReader(configPath), '50 900 enabled');
});

test('the scheduled run bounds each source without editing the live profile', async () => {
  const script = await readScript();
  // Yesterday's unbounded sweep ran for ten hours; a nightly job must not
  // still be extracting when its successor starts.
  assert.match(script, /DEFAULT_SOURCE_RUNTIME_SECONDS=900/);
  assert.match(script, /VPN_AUTOMATION_PROFILE_PATH="\$PROFILE_PATH"/);
  // The staging copy is selected for both the measure and the deploy, so the
  // deploy reads the same budgeted profile the measurement did.
  assert.match(script, /run_env=\(VPN_AUTOMATION_PROFILE_PATH="\$staged_profile"\)/);
  assert.match(script, /env "\$\{run_env\[@\]\}"/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-run-profile-'));
  const profile = path.join(dir, 'profile.toml');
  const staged = path.join(dir, 'staged.toml');
  await fs.writeFile(profile, [
    '[sources.one]',
    'enabled = true',
    'max_runtime_seconds = 0',
    '',
    '[sources.two]',
    'enabled = true',
    'max_runtime_seconds = 0',
    '',
    '[deploy]',
    'project_name = "keep-me"'
  ].join('\n'), 'utf8');
  const match = script.match(/staging_note="\$\("\$NODE_BIN" -e '\n([\s\S]*?)\n' "\$PROFILE_PATH" "\$staged_profile" "\$source_runtime_seconds"\)"/);
  assert.ok(match, 'the profile staging snippet is missing');
  const result = spawnSync(process.execPath, ['-e', match[1], profile, staged, '900'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /across 2 sources/);
  const written = await fs.readFile(staged, 'utf8');
  assert.equal((written.match(/max_runtime_seconds = 900/g) ?? []).length, 2);
  assert.match(written, /project_name = "keep-me"/);
  assert.equal(await fs.readFile(profile, 'utf8'), [
    '[sources.one]',
    'enabled = true',
    'max_runtime_seconds = 0',
    '',
    '[sources.two]',
    'enabled = true',
    'max_runtime_seconds = 0',
    '',
    '[deploy]',
    'project_name = "keep-me"'
  ].join('\n'));
});
