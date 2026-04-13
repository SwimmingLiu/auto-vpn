import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStageModel, toMetricItems } from '../renderer/state.js';

test('buildStageModel marks stages in configured order', () => {
  const rows = buildStageModel({ doctor: 'success', deploy: 'running' });
  assert.equal(rows[0].name, 'doctor');
  assert.equal(rows[0].status, 'success');
  assert.equal(rows.at(-1).name, 'verify');
});

test('toMetricItems converts summary counts into cards', () => {
  const cards = toMetricItems({ raw_links: 12, postprocess_links: 5 });
  assert.deepEqual(cards[0], { label: 'RAW LINKS', value: '12' });
});
