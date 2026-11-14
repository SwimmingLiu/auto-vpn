import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * The image installs the published CLI rather than the checkout, because the
 * container build context does not include `npm/autovpn-cli`. That makes the
 * pin a second place the pipeline's version lives: the 2.2.4 pin predated
 * `max_probe_candidates`, so the container path kept the unbounded probe the
 * runner path had already fixed.
 *
 * This keeps the two versions from drifting apart silently.
 */
test('the image pins the CLI version this repository ships', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../../../npm/autovpn-cli/package.json', import.meta.url), 'utf8'));
  const pinned = /^ARG AUTOVPN_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  assert.ok(pinned, 'the Dockerfile no longer declares AUTOVPN_VERSION');
  assert.equal(pinned, pkg.version, `Dockerfile pins ${pinned} but package.json is ${pkg.version}`);
});
