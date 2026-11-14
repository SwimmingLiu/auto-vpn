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

    // Lap mode is in force, so the round-policy keys are not read at all.
    // `resolveLapRoundPolicy` builds the policy from max_laps/dry_laps/min_laps
    // and sets `min_iterations = min_laps` — a `min_iterations` in the file
    // would be silently ignored, which is the trap this asserts against.
    const laps = Number(/^max_laps\s*=\s*(\d+)/m.exec(block)?.[1]);
    const dryLaps = Number(/^dry_laps\s*=\s*(\d+)/m.exec(block)?.[1]);
    const minLaps = Number(/^min_laps\s*=\s*(\d+)/m.exec(block)?.[1]);
    const budget = Number(/^max_runtime_seconds\s*=\s*(\d+)/m.exec(block)?.[1]);

    assert.ok(Number.isFinite(laps) && laps > 0, `${name}: no max_laps, so it runs the legacy round policy`);
    assert.ok(Number.isFinite(dryLaps) && dryLaps > 0, `${name}: no dry_laps`);
    assert.ok(dryLaps <= laps, `${name}: dry_laps ${dryLaps} > max_laps ${laps}`);
    // A dry-lap count of 1 stops after the first empty sweep, which throws away
    // the tail of the pool.
    assert.ok(dryLaps >= 10, `${name}: dry_laps ${dryLaps} stops too early to fill the pool`);

    // `shouldStartRound` ignores `max_runtime_seconds` only while
    // `round <= min_iterations`, and in lap mode that floor comes from
    // `min_laps`. Without it the budget cuts every source mid-sweep: measured
    // 272 links in 20 minutes against 10,790 from an unbounded run.
    assert.ok(
      Number.isFinite(minLaps) && minLaps > 0,
      `${name}: no min_laps, so max_runtime_seconds cuts the sweep at a few laps`
    );
    assert.ok(minLaps <= laps, `${name}: min_laps ${minLaps} > max_laps ${laps}`);
    assert.ok(budget > 0 && budget <= 1800, `${name}: max_runtime_seconds ${budget} does not bound the run`);

    // The legacy keys are dead in lap mode; leaving them in reads as
    // configuration and invites the mistake above.
    for (const dead of ['min_iterations', 'max_iterations', 'plateau_limit', 'areas_per_round']) {
      assert.doesNotMatch(
        block,
        new RegExp(`^${dead}\\s*=`, 'm'),
        `${name}: ${dead} is ignored in lap mode; remove it or the file misleads`
      );
    }
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

test('probing is bounded, so a large sweep cannot run past the job timeout', () => {
  // Probing runs before the download test, so `max_download_candidates` cannot
  // bound it. A runner night extracted 10,790 links; at 8 concurrent and up to
  // 60 s each that is hours, and the job is killed before it publishes.
  const block = /\[speed_test\]([\s\S]*?)(?=\n\[)/.exec(raw)?.[1] ?? '';
  const cap = Number(/^max_probe_candidates\s*=\s*(\d+)/m.exec(block)?.[1]);
  assert.ok(Number.isFinite(cap), 'no max_probe_candidates: the probe stage runs unbounded');
  assert.ok(cap > 0, 'max_probe_candidates = 0 means probe everything');
  // The floor is 40 and good nights land at 49-60, so a cap below a few
  // hundred would start discarding links that would have passed.
  assert.ok(cap >= 400, `max_probe_candidates = ${cap} is closer to the floor than a night's yield`);
});
