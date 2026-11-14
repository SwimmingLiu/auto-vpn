import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  parseSecretQuery,
  parseTemplateSecret,
  resolveKeyFromEnv,
  SECRET_QUERY_ENV,
  SECRET_QUERY_SENTINEL,
  secretQueryMismatch
} from '../src/profile-guard.mjs';

const PROFILE = readFileSync(new URL('../profile.cloudflare.toml', import.meta.url), 'utf8');
const TEMPLATE = readFileSync(new URL('../../../templates/vmess_node.js', import.meta.url), 'utf8');

/** The environment a deployed run is expected to have. */
const WITH_KEY = { [SECRET_QUERY_ENV]: 'serect_key=resolved-value' };

test('the shipped profile defers its key to the environment', () => {
  // The repository is public. A literal here is a published subscription key,
  // and the same file is uploaded as a Worker secret.
  assert.equal(parseSecretQuery(PROFILE), SECRET_QUERY_SENTINEL);
});

test('nothing in the profile is a usable key on its own', () => {
  // A reader of the repository must not be able to build the subscription URL.
  assert.doesNotMatch(PROFILE, /serect_key=[A-Za-z0-9]/, 'the profile carries a real key');
});

test('the shipped pair builds when the key is in the environment', () => {
  assert.equal(secretQueryMismatch(PROFILE, TEMPLATE, WITH_KEY), '');
});

test('the run is refused when the profile defers and the variable is unset', () => {
  // This is the case that failed in production: the profile deferred, the
  // secret was not set (the job started 14 s before it was created), and the
  // bundle would have guarded the sentinel — which is written in the public
  // profile, so anyone could have read it.
  const complaint = secretQueryMismatch(PROFILE, TEMPLATE, {});
  assert.match(complaint, /defers its key to VPN_AUTOMATION_SUBSCRIPTION_KEY, which is unset/);
});

test('a key that is not key=value is refused', () => {
  assert.match(
    secretQueryMismatch(PROFILE, TEMPLATE, { [SECRET_QUERY_ENV]: 'no-separator' }),
    /is not key=value/
  );
});

test('a profile with no secret_query is refused', () => {
  const stripped = PROFILE.replace(/^\s*secret_query\s*=.*$/m, '');
  assert.match(secretQueryMismatch(stripped, TEMPLATE, WITH_KEY), /no secret_query/);
});

test('a template with no guard is refused', () => {
  const noGuard = TEMPLATE.replace(/===\s*"[^"]*"/, '=== derivedSecret()');
  assert.match(secretQueryMismatch(PROFILE, noGuard, WITH_KEY), /no `=== "..."` secret guard/);
});

test('a template guard that is not the sentinel is refused', () => {
  // A template edited back to a literal would skip the rewrite, and the bundle
  // would guard that literal instead of the configured key.
  const literal = TEMPLATE.replace(/===\s*"__SUBSCRIPTION_KEY__"/, '=== "some-other-key"');
  assert.match(secretQueryMismatch(PROFILE, literal, WITH_KEY), /not the sentinel/);
});

test('a literal profile still works, so the VPS profile is unaffected', () => {
  const literal = PROFILE.replace(/^(\s*secret_query\s*=\s*)"[^"]*"/m, '$1"serect_key=legacy"');
  assert.equal(secretQueryMismatch(literal, TEMPLATE, {}), '');
  assert.equal(resolveKeyFromEnv(literal, {}), 'serect_key=legacy');
});

test('the environment wins over a literal when both are present', () => {
  // A stale literal left in a profile must not silently outrank the secret the
  // deployment was told to use.
  assert.equal(
    resolveKeyFromEnv({ toString: () => `secret_query = "${SECRET_QUERY_SENTINEL}"` }.toString(), WITH_KEY),
    'serect_key=resolved-value'
  );
});

test('the template literal parser reads the comparison, not the query name', () => {
  assert.equal(parseTemplateSecret(TEMPLATE), '__SUBSCRIPTION_KEY__');
  assert.notEqual(parseTemplateSecret(TEMPLATE), '__SUBSCRIPTION_PARAM__');
});
