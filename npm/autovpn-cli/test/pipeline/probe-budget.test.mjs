import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The streaming speed-test path submits links as they are extracted, so it can
 * never see the final set. `max_probe_candidates` was honoured only on the
 * batch path, which production does not use — one night pushed all 1,409 links
 * into the pool and spent over an hour in the speed test.
 *
 * This mirrors the admission rule that now guards the pool.
 */
function makeGate(budget) {
  let accepted = 0;
  let skipped = 0;
  return {
    shouldSubmit() {
      if (budget <= 0) { accepted += 1; return true; }
      if (accepted < budget) { accepted += 1; return true; }
      skipped += 1;
      const stride = Math.max(2, Math.floor(skipped / Math.max(1, budget)) + 1);
      if (skipped % stride === 0) { accepted += 1; return true; }
      return false;
    },
    get accepted() { return accepted; }
  };
}

test('a budget of zero admits everything, so the old behaviour is reachable', () => {
  const gate = makeGate(0);
  for (let i = 0; i < 5000; i += 1) gate.shouldSubmit();
  assert.equal(gate.accepted, 5000);
});

test('the first `budget` links are always admitted', () => {
  const gate = makeGate(600);
  for (let i = 0; i < 600; i += 1) assert.equal(gate.shouldSubmit(), true, `link ${i} was refused inside the budget`);
  assert.equal(gate.accepted, 600);
});

test('a sweep far past the budget is bounded, and roughly matches it', () => {
  // The real night: 1,409 deduped links against a 600 budget.
  const gate = makeGate(600);
  for (let i = 0; i < 1409; i += 1) gate.shouldSubmit();
  assert.ok(gate.accepted > 600, 'no links past the budget were admitted, so the sample is a prefix');
  assert.ok(gate.accepted < 1409, `admitted ${gate.accepted} of 1409 — the budget had no effect`);
  // The stride grows, so the overshoot stays a fraction of the budget rather
  // than doubling it.
  assert.ok(gate.accepted < 600 * 2, `admitted ${gate.accepted}, more than twice the budget`);
});

test('admitted links are spread across the sweep, not clustered at its start', () => {
  const gate = makeGate(100);
  const kept = [];
  for (let i = 0; i < 1000; i += 1) if (gate.shouldSubmit()) kept.push(i);
  // The tail must be represented: a prefix would stop at index ~99.
  assert.ok(kept[kept.length - 1] > 900, `last admitted index is ${kept[kept.length - 1]}, so the tail was dropped`);
  // And the gaps must not be one enormous block in the middle.
  const gaps = kept.slice(1).map((v, i) => v - kept[i]);
  const maxGap = Math.max(...gaps);
  assert.ok(maxGap < 200, `largest gap between admitted links is ${maxGap}`);
});

test('the gate is monotonic: it never re-admits everything after slowing down', () => {
  const gate = makeGate(50);
  const first = [];
  for (let i = 0; i < 200; i += 1) first.push(gate.shouldSubmit());
  assert.ok(first.slice(0, 50).every(Boolean), 'a link inside the budget was refused');
  assert.ok(first.slice(50).some((v) => v === false), 'nothing past the budget was ever refused');
});
