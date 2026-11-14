/**
 * Reading a run's JSONL log.
 *
 * Split out of `server.mjs` so the idempotency rule below can be tested
 * without starting the HTTP server that module binds at import time.
 */
import { readFile, stat } from 'node:fs/promises';

/**
 * The `summary` event a finished run wrote, or null.
 *
 * A run id names one attempt, and this log is the attempt's only durable
 * record. The Durable Object can lose the reply to a `/run` it successfully
 * posted — an eviction between the request and the phase write — and retry the
 * same id minutes later. Restarting on that retry re-runs a whole
 * `wrangler pages deploy` against a subscription people are using, which is
 * the one thing this pipeline must not do twice.
 *
 * A partial trailing line is normal while a run is still appending, and an
 * unparseable line is skipped rather than treated as the end of the log.
 */
export async function completedSummary(logPath) {
  let size = 0;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return null;
  }
  if (!size) return null;
  const text = await readFile(logPath, 'utf8');
  let summary = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'summary') summary = event;
    } catch {
      // A partial last line is normal while a run is still writing.
    }
  }
  return summary;
}
