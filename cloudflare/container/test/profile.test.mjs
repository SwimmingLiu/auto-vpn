import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

/**
 * The Cloudflare profile is the input two separate systems act on, and both
 * fail silently when it is wrong:
 *
 *   - `deploy.sh` uploads it as a Worker secret, and a secret over 5 KB is
 *     rejected by the API *after* the ten-minute image build.
 *   - The CLI parses it at run time, and `min_iterations` / a mistyped
 *     availability URL turn a night into `final_links = 0` with a green
 *     schedule.
 *
 * So these are assertions about the file's bytes, not about a loader: a test
 * that shares the loader would agree with any loader bug.
 */

const PROFILE_PATH = new URL('../profile.cloudflare.toml', import.meta.url);
const raw = readFileSync(PROFILE_PATH, 'utf8');

/** The exact transformation `deploy.sh` applies before uploading. */
function strippedBytes(text) {
  return Buffer.byteLength(
    text.split('\n').filter((line) => !/^\s*#/.test(line) && !/^\s*$/.test(line)).join('\n'),
    'utf8'
  );
}

test('the profile fits a Worker secret even without comment stripping', () => {
  // 5120 is the platform cap; stripping is belt-and-braces, not the plan.
  const bytes = Buffer.byteLength(raw, 'utf8');
  assert.ok(bytes <= 5120, `profile is ${bytes} bytes raw, over the 5120-byte secret cap`);
  assert.ok(strippedBytes(raw) <= 5120, 'stripped profile is over the secret cap');
});

test('every source can act on its runtime budget', () => {
  const blocks = raw.split(/^\[/m).filter((block) => block.startsWith('sources.'));
  assert.equal(blocks.length, 4, `expected 4 sources, found ${blocks.length}`);
  for (const block of blocks) {
    const name = block.slice(0, block.indexOf(']'));
    // `max_runtime_seconds` and the plateau stop are only consulted at or past
    // `min_iterations` (legacy rounds) or `dry_laps` (lap mode). A floor above
    // the ceiling means the crawl runs until the platform kills it and nothing
    // is published.
    const floor = Number(/^min_iterations\s*=\s*(\d+)/m.exec(block)?.[1]);
    const ceiling = Number(/^max_iterations\s*=\s*(\d+)/m.exec(block)?.[1]);
    const budget = Number(/^max_runtime_seconds\s*=\s*(\d+)/m.exec(block)?.[1]);
    assert.ok(Number.isFinite(floor), `${name} has no min_iterations`);
    assert.ok(floor < ceiling, `${name}: min_iterations ${floor} >= max_iterations ${ceiling}`);
    assert.ok(floor > 0 && floor <= 200, `${name}: min_iterations ${floor} is not reachable in a nightly run`);
    assert.ok(budget > 0 && budget <= 1800, `${name}: max_runtime_seconds ${budget} does not bound the run`);

    // Lap mode changes what "enough" means: one round is a full sweep of the
    // area list, so a nightly run is bounded by laps and by dry laps, not by
    // the legacy round count. Leaving these out silently runs the legacy
    // policy, which measured 266 raw links against the VPS's 566 on the same
    // subscription.
    const laps = Number(/^max_laps\s*=\s*(\d+)/m.exec(block)?.[1]);
    const dryLaps = Number(/^dry_laps\s*=\s*(\d+)/m.exec(block)?.[1]);
    assert.ok(Number.isFinite(laps) && laps > 0, `${name}: no max_laps, so it runs the legacy round policy`);
    assert.ok(Number.isFinite(dryLaps) && dryLaps > 0, `${name}: no dry_laps`);
    assert.ok(dryLaps <= laps, `${name}: dry_laps ${dryLaps} > max_laps ${laps}`);
    // A dry-lap count of 1 stops after the first empty sweep, which throws away
    // the tail of the pool; the VPS uses 20 and that is what the numbers above
    // are measured against.
    assert.ok(dryLaps >= 10, `${name}: dry_laps ${dryLaps} stops too early to fill the pool`);
  }
});

test('the claude availability target is the trace endpoint', () => {
  const block = raw.split(/^\[/m).find((item) => item.startsWith('availability_targets.claude]'));
  assert.ok(block, 'no [availability_targets.claude] section');
  // The claude evaluator reads a `loc=` line from the body (availability.ts
  // `extractTraceLocation`). `https://claude.ai/` answers 403 with an HTML
  // challenge through every exit measured, which has no `loc=` — every
  // candidate then fails and the run dies with "No links passed availability".
  assert.match(block, /url\s*=\s*"https:\/\/claude\.ai\/cdn-cgi\/trace"/);
});

test('the deploy target is not the project the VPS publishes to', () => {
  // `wrangler pages deploy` replaces the whole production deployment of the
  // project it names. The two installations must stay separate: this one has
  // its own project (`sub-nodes-cf`), and the VPS keeps `sub-nodes-04`.
  // deploy.sh enforces the same pair, so a profile edit cannot quietly merge
  // them into one blast radius.
  const project = /^project_name\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? '';
  assert.ok(project, 'the profile names no project');
  assert.notEqual(project, 'sub-nodes-04', 'this would replace the VPS subscription');
  assert.notEqual(project, 'sub-links-auto', 'this names the retired VPS project');
});

test('the account file is small enough to survive the route body limit', () => {
  // 631 accounts is ~57 KB; the container route accepts 32 MB. This guards
  // against a profile edit that copies a pool in, not against the real file.
  assert.ok(statSync(PROFILE_PATH).size < 5120);
});
