import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { attachPipelineChildFinalizer } from '../lib/pipeline-child-finalizer.js';

for (const operation of ['run', 'retry']) {
  test(`${operation} child error followed by close flushes and finishes exactly once`, () => {
    const child = new EventEmitter();
    const events = [];
    let flushes = 0;
    let clears = 0;
    let releases = 0;
    attachPipelineChildFinalizer(child, {
      decoder: { flush: () => { flushes += 1; } },
      clearStopTimer: () => { clears += 1; },
      releaseActiveChild: () => { releases += 1; },
      isStopRequested: () => false,
      emit: (event) => events.push(event)
    });

    child.emit('error', new Error(`${operation} spawn failed`));
    child.emit('close', 1, null);

    assert.equal(flushes, 1);
    assert.equal(clears, 1);
    assert.equal(releases, 1);
    assert.deepEqual(events, [{
      type: 'finished',
      ok: false,
      code: null,
      signal: null,
      stopped: false,
      error: `${operation} spawn failed`
    }]);
  });
}
