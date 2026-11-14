import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildWorkerArtifacts } from '../../dist/pipeline/obfuscate.js';

/**
 * The obfuscate stage rewrites two shapes in the template: the
 * `searchParams.get("<key>")` call and the `=== "<value>"` comparison. It keys
 * on those literals, so a template that reads the key from `env` instead ships
 * a bundle whose secret is the placeholder — and every deployment would then
 * accept that placeholder as the subscription key.
 *
 * The template therefore keeps the literals, and the *profile* stays keyless:
 * `secret_query` resolves from the environment, and this asserts the rewrite
 * still happens and the shipped bundle carries the resolved value.
 */

const TEMPLATE = readFileSync(new URL('../../../../templates/vmess_node.js', import.meta.url), 'utf8');

test('the template still carries the shapes the obfuscate stage rewrites', () => {
  assert.match(TEMPLATE, /searchParams\.get\("__SUBSCRIPTION_PARAM__"\)/, 'the key-name sentinel shape is gone');
  assert.match(TEMPLATE, /===\s*"__SUBSCRIPTION_KEY__"/, 'the value-comparison sentinel shape is gone');
});

test('both sentinels are replaced by the resolved values', () => {
  const artifacts = buildWorkerArtifacts(TEMPLATE, { enable_keyword_fragmentation: false }, 'serect_key=resolved-value');
  assert.doesNotMatch(
    artifacts.transformed_source,
    /__SUBSCRIPTION_KEY__/,
    'the bundle still contains the value sentinel, so the sentinel is the key'
  );
  assert.doesNotMatch(
    artifacts.transformed_source,
    /__SUBSCRIPTION_PARAM__/,
    'the bundle still contains the parameter sentinel'
  );
  assert.match(artifacts.transformed_source, /resolved-value/, 'the bundle does not carry the resolved key');
});

test('the template in the repository contains no key of its own', () => {
  // A literal here would be published: the file is in the repository and is
  // also the source of the deployed worker.
  assert.doesNotMatch(TEMPLATE, /serect_key=/, 'the template carries a key literal');
  assert.doesNotMatch(TEMPLATE, /===\s*"swimmingliu"/, 'the template carries the legacy key');
});
