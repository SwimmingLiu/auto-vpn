import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * The runner workflow is one job of shell steps that share state only through
 * the filesystem and the environment. That sharing is where it failed: the
 * import step and the measure step each resolve `<runtime-root>/accounts.db`,
 * and only one of them set `VPN_AUTOMATION_RUNTIME_ROOT`.
 *
 * The failure is invisible from either step alone. The import reported 631
 * rows and 631 active; the run then failed every source in about 20 ms with
 * "account pool has no active <brand> account", because it was reading a
 * different — and newly created, empty — database.
 *
 * `--project-root` does not redirect the pool: `AccountStore` resolves the
 * path from the environment alone. So the assertion is that every step which
 * touches the pool names the same runtime root.
 */

const WORKFLOW_PATH = new URL('../../../.github/workflows/cloudflare-subscription.yml', import.meta.url);
const raw = readFileSync(WORKFLOW_PATH, 'utf8');

/** Split into `- name:` blocks, keeping each step's body. */
function steps(text) {
  const parts = text.split(/^\s{6}- name:/m);
  const head = parts.shift();
  return parts.map((body) => {
    const [nameLine, ...rest] = body.split('\n');
    return { name: nameLine.trim(), body: rest.join('\n'), head };
  });
}

const RUNNER_ROOT = '${{ runner.temp }}/autovpn';

test('the import step writes the pool where the measure step reads it', () => {
  const poolSteps = steps(raw).filter((step) =>
    /\bautovpn accounts import\b|\bautovpn run\b|\bretry-stage\b/.test(step.body)
  );
  assert.ok(poolSteps.length >= 2, `expected at least two pool-touching steps, found ${poolSteps.length}`);

  for (const step of poolSteps) {
    assert.match(
      step.body,
      /VPN_AUTOMATION_RUNTIME_ROOT:\s*\$\{\{\s*runner\.temp\s*\}\}\/autovpn/,
      `"${step.name}" does not set VPN_AUTOMATION_RUNTIME_ROOT to ${RUNNER_ROOT}, ` +
        'so it resolves a different accounts.db than the other steps'
    );
  }
});

test('the import is required to leave active rows, not merely to parse them', () => {
  const importStep = steps(raw).find((step) => /\bautovpn accounts import\b/.test(step.body));
  assert.ok(importStep, 'no step runs `autovpn accounts import`');
  assert.match(
    importStep.body,
    /stats\?\.active\s*>\s*0/,
    'the import step does not fail when the pool has no active rows; ' +
      'that state reaches the crawl as "no accounts" instead'
  );
});

test('the pool is assembled from pinned bytes, not from an unverified split', () => {
  const assemble = steps(raw).find((step) => /assemble-account-pool\.mjs/.test(step.body));
  assert.ok(assemble, 'no step assembles the account pool');
  for (const name of ['ACCOUNTS_POOL_BYTES', 'ACCOUNTS_POOL_SHA256', 'ACCOUNTS_PARTS']) {
    assert.match(assemble.body, new RegExp(name), `the assembler step does not read ${name}`);
  }
});
