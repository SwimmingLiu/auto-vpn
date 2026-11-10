/**
 * Bounded fan-out over a fixed work list.
 *
 * Three stages used to carry their own copy of this loop (speed test,
 * availability probe, credential rounds). They drifted: one swallowed worker
 * errors, one lost input order, none capped a non-finite limit. One definition
 * keeps the contract the same everywhere:
 *
 *   - results keep input order, so a caller can zip them back onto its items;
 *   - at most `limit` workers are in flight, and `limit` is clamped to >= 1;
 *   - a worker rejection propagates, but the workers already in flight are
 *     awaited first so no promise is left running after the call returns.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(items.length, Math.trunc(Number(limit)) || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const runners = Array.from({ length: width }, async () => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  });
  await Promise.all(runners);
  if (failed) throw failure;
  return results;
}

/** Clamp a user-supplied concurrency knob into a sane range. */
export function resolveConcurrency(value: unknown, fallback: number, max = 16): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return Math.max(1, Math.min(max, Math.trunc(fallback)));
  return Math.max(1, Math.min(max, parsed));
}

/**
 * `mapWithConcurrency` plus a progress counter, for a stage that reports
 * "N of M done" while it works. The callback runs after the result is
 * recorded, so `completed` counts settled items, not started ones.
 */
export async function mapWithCompletion<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onComplete?: (result: R, index: number, completed: number) => void
): Promise<R[]> {
  if (!onComplete) {
    return mapWithConcurrency(items, concurrency, worker);
  }
  let completed = 0;
  return mapWithConcurrency(items, concurrency, async (item, index) => {
    const result = await worker(item, index);
    completed += 1;
    onComplete(result, index, completed);
    return result;
  });
}