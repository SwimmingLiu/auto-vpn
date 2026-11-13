import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseSecretQuery, parseTemplateSecret, secretQueryMismatch } from '../src/profile-guard.mjs';

const PROFILE = readFileSync(new URL('../profile.cloudflare.toml', import.meta.url), 'utf8');
const TEMPLATE = readFileSync(new URL('../../../templates/vmess_node.js', import.meta.url), 'utf8');

test('the shipped profile and template agree on the secret', () => {
  // This is the pairing that gets published. If it fails, the deploy would
  // bake a Worker that serves random bytes to the advertised URL and the
  // payload to whoever still has the old key.
  assert.equal(secretQueryMismatch(PROFILE, TEMPLATE), '');
});

test('the profile parses to a key=value query', () => {
  const query = parseSecretQuery(PROFILE);
  assert.ok(query.includes('='), `secret_query has no '=': ${query}`);
  assert.equal(query.split('=')[0], 'serect_key');
});

test('a rotated secret is caught before the run, with both lengths', () => {
  // Append inside the quotes: a character after the closing quote would leave
  // the parsed value unchanged and make this test pass for the wrong reason.
  const rotated = PROFILE.replace(/^(\s*secret_query\s*=\s*"[^"]*)"/m, '$1x"');
  assert.notEqual(rotated, PROFILE, 'the rotation fixture did not apply');
  const complaint = secretQueryMismatch(rotated, TEMPLATE);
  assert.match(complaint, /does not match the template guard/);
  assert.match(complaint, /12 chars/);
  assert.match(complaint, /11 chars/);
});

test('a profile with no secret_query is refused', () => {
  const stripped = PROFILE.replace(/^\s*secret_query\s*=.*$/m, '');
  assert.match(secretQueryMismatch(stripped, TEMPLATE), /no secret_query/);
});

test('a template with no guard is refused', () => {
  // A template edit that renames the comparison would otherwise publish a
  // bundle with no secret at all.
  const noGuard = TEMPLATE.replace(/===\s*"[^"]*"/, '=== derivedSecret()');
  assert.match(secretQueryMismatch(PROFILE, noGuard), /no `=== "..."` secret guard/);
});

test('the template literal parser reads the comparison, not the query name', () => {
  // `searchParams.get("<key>")` also contains a quoted string; the guard value
  // is the one after `===`, and picking the wrong one would compare the key.
  assert.equal(parseTemplateSecret(TEMPLATE), parseSecretQuery(PROFILE).split('=').slice(1).join('='));
  assert.notEqual(parseTemplateSecret(TEMPLATE), 'serect_key');
});
