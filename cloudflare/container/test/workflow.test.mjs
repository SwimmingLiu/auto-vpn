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
 * touches the pool names the same runtime root — and, since the pool moved to
 * a shared Postgres table, the same database.
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

test('the sync step writes the pool where the measure step reads it', () => {
  const poolSteps = steps(raw).filter((step) =>
    /\bautovpn accounts sync\b|\bautovpn run\b|\bretry-stage\b/.test(step.body)
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

test('the sync is required to leave active rows, not merely to connect', () => {
  const syncStep = steps(raw).find((step) => /\bautovpn accounts sync\b/.test(step.body));
  assert.ok(syncStep, 'no step runs `autovpn accounts sync`');
  assert.match(
    syncStep.body,
    /stats\??\.active\s*>\s*0/,
    'the sync step does not fail when the pool has no active rows; ' +
      'that state reaches the crawl as "no accounts" instead'
  );
});

/**
 * The pool used to be assembled from base64 halves of a 57 KB file in
 * repository secrets. That mechanism is gone: the rows live in the operator's
 * Postgres database, and a host reaches it with one URL. A step that still
 * reads `ACCOUNTS_PART_*` would be a second source of truth, and a test that
 * still accepted it would let that split come back.
 */
test('the pool comes from the shared database, not from split secrets', () => {
  const sync = steps(raw).find((step) => /\bautovpn accounts sync\b/.test(step.body));
  assert.ok(sync, 'no step syncs the account pool');
  assert.match(sync.body, /AUTOVPN_ACCOUNTS_DB_URL:\s*\$\{\{\s*secrets\.AUTOVPN_ACCOUNTS_DB_URL\s*\}\}/);
  assert.doesNotMatch(raw, /ACCOUNTS_PART_\d|assemble-account-pool/);

  const measure = steps(raw).find((step) => /\bautovpn run\b/.test(step.body));
  assert.ok(measure, 'no step runs the pipeline');
  assert.match(
    measure.body,
    /AUTOVPN_ACCOUNTS_DB_URL:\s*\$\{\{\s*secrets\.AUTOVPN_ACCOUNTS_DB_URL\s*\}\}/,
    'the measure step cannot push its retirements back to the shared pool'
  );
});

test('the CLI is built from this checkout, not installed by version number', () => {
  // A published version cannot contain a fix that is still a branch commit, so
  // installing by number silently runs code the workflow was never tested
  // against. The first runner night did exactly that and failed on a bug the
  // branch had already fixed.
  const install = steps(raw).find((step) => /npm\/autovpn-cli run build/.test(step.body));
  assert.ok(install, 'no step builds the CLI from this checkout');
  assert.doesNotMatch(
    install.body,
    /npm install -g[^\n]*@swimmingliu\/autovpn@/,
    'the CLI is installed from npm by version; build it from the checkout instead'
  );
  assert.match(install.body, /npm install -g[^\n]*\.\/npm\/autovpn-cli/, 'the built CLI is not installed');
});

test('the uploaded log is the redacted one, and nothing uploads the raw log', () => {
  // A public repository's artifacts are downloadable without authentication.
  // The raw log carries one event per link with the full vmess payload, so
  // uploading it as-is publishes the subscription.
  const upload = steps(raw).find((step) => /upload-artifact/.test(step.body));
  assert.ok(upload, 'no upload-artifact step');
  assert.match(upload.body, /run\.redacted\.jsonl/, 'the raw run log is what gets uploaded');
  assert.doesNotMatch(
    upload.body,
    /\$\{\{ runner\.temp \}\}\/run\.jsonl/,
    'the upload path still names the unredacted log'
  );
  const redact = steps(raw).find((step) => /redact-run-log\.mjs/.test(step.body));
  assert.ok(redact, 'nothing redacts the log before upload');
  assert.match(redact.body, /grep -qE/, 'the redaction step does not verify its own output');
});

test('every step that can reach the obfuscate stage has the subscription key', () => {
  // The obfuscate stage resolves the key from the environment, and it runs
  // inside `autovpn run` (Measure), not only at publish. A run that cleared the
  // floor at 54 links then died in obfuscate because only the Publish step had
  // the variable.
  const steps = raw.split(/^\s{6}- name:/m).slice(1).map((body) => {
    const [nameLine, ...rest] = body.split('\n');
    return { name: nameLine.trim(), body: rest.join('\n') };
  });
  const reachable = steps.filter((step) => /\bautovpn run\b/.test(step.body) || /retry-stage/.test(step.body));
  assert.ok(reachable.length >= 2, `expected Measure and Publish, found ${reachable.length}`);
  for (const step of reachable) {
    assert.match(
      step.body,
      /VPN_AUTOMATION_SUBSCRIPTION_KEY:/,
      `"${step.name}" can reach the obfuscate stage but does not set VPN_AUTOMATION_SUBSCRIPTION_KEY`
    );
  }
});
