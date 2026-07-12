import assert from 'node:assert/strict';
import test from 'node:test';

import { BoundedWorkerPool } from '../../dist/pipeline/streaming-coordinator.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('bounds active and queued work while admitting waiters as space is released', async () => {
  const gates = Array.from({ length: 6 }, deferred);
  const started = [];
  const pool = new BoundedWorkerPool({
    concurrency: 2,
    capacity: 2,
    worker: async (item) => {
      started.push(item);
      await gates[item].promise;
    }
  });

  const admissions = Array.from({ length: 6 }, (_, item) => pool.submit(item));
  const admitted = admissions.map(() => false);
  admissions.forEach((admission, index) => admission.then(() => { admitted[index] = true; }));
  await nextTurn();

  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(admitted, [true, true, true, true, false, false]);

  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(admitted, [true, true, true, true, true, false]);

  gates[1].resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.deepEqual(admitted, [true, true, true, true, true, true]);

  pool.close();
  await assert.rejects(pool.submit(6), /closed/i);
  gates.slice(2).forEach((gate) => gate.resolve());
  await pool.drain();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
});

test('drain resolves immediately for an empty closed pool', async () => {
  const pool = new BoundedWorkerPool({ concurrency: 1, capacity: 0, worker: async () => {} });
  pool.close();
  await pool.drain();
});

test('drain reports the first worker failure after accepted work settles', async () => {
  const first = new Error('first failure');
  const second = new Error('second failure');
  const gates = [deferred(), deferred()];
  const pool = new BoundedWorkerPool({
    concurrency: 2,
    capacity: 0,
    worker: async (item) => gates[item].promise
  });

  await Promise.all([pool.submit(0), pool.submit(1)]);
  pool.close();
  const drained = pool.drain();
  gates[0].reject(first);
  gates[1].reject(second);
  await assert.rejects(drained, (error) => error === first);
});

test('abort rejects admission waiters, prevents new work, and lets active work settle', async () => {
  const gate = deferred();
  const reason = new Error('pipeline aborted');
  const started = [];
  const pool = new BoundedWorkerPool({
    concurrency: 1,
    capacity: 1,
    worker: async (item) => {
      started.push(item);
      await gate.promise;
    }
  });

  await pool.submit(0);
  await pool.submit(1);
  const waiting = pool.submit(2);
  pool.abort(reason);

  await assert.rejects(waiting, (error) => error === reason);
  await assert.rejects(pool.submit(3), (error) => error === reason);
  gate.resolve();
  await assert.rejects(pool.drain(), (error) => error === reason);
  assert.deepEqual(started, [0]);
});

test('worker rejections are observed even when drain is called later', async () => {
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const pool = new BoundedWorkerPool({
      concurrency: 1,
      capacity: 0,
      worker: async () => { throw new Error('observed failure'); }
    });
    await pool.submit('item');
    pool.close();
    await nextTurn();
    assert.deepEqual(unhandled, []);
    await assert.rejects(pool.drain(), /observed failure/);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('constructor rejects invalid concurrency and capacity', () => {
  const worker = async () => {};
  for (const concurrency of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new BoundedWorkerPool({ concurrency, capacity: 0, worker }), /concurrency/i);
  }
  for (const capacity of [-1, 1.5, Number.NaN]) {
    assert.throws(() => new BoundedWorkerPool({ concurrency: 1, capacity, worker }), /capacity/i);
  }
});
