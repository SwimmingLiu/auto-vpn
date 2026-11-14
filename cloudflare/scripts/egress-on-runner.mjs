#!/usr/bin/env node
/**
 * Start the crawl egress on a plain Linux runner.
 *
 * The container image gets this from `container/server.mjs`, which owns the
 * supervisor and starts it before a run. A GitHub runner has no such process,
 * so this does the same job once, in the foreground, and writes the resulting
 * state where the workflow can see it.
 *
 * The result is not cosmetic: without it the crawl goes out from the runner's
 * own address, which is the thing the migration is required to avoid. Exit 1
 * when no node can reach the vendor — a direct crawl is not an acceptable
 * fallback for a scheduled publish.
 *
 * Usage: node scripts/egress-on-runner.mjs [--serve]
 * Env:   SUBSCRIPTION_URL, MIHOMO_BIN, EGRESS_DIR
 *
 * Without `--serve` it builds the egress, reports it and exits (the child dies
 * with it, which is what a one-shot check wants). With `--serve` it stays in
 * the foreground holding the mihomo child: the workflow backgrounds it and
 * kills it after the measurement, so the proxy outlives this process's parent
 * shell but not the job.
 */
import path from 'node:path';
import { EgressSupervisor, DEFAULT_PROBE_HOST } from '../container/src/egress.mjs';

const subscriptionUrl = String(process.env.SUBSCRIPTION_URL ?? '').trim();
if (!subscriptionUrl) {
  console.error('SUBSCRIPTION_URL is unset; the crawl would leave from the runner address');
  process.exit(1);
}

const bin = String(process.env.MIHOMO_BIN ?? '').trim();
const supervisor = new EgressSupervisor({
  dir: process.env.EGRESS_DIR || path.join(process.env.RUNNER_TEMP || '/tmp', 'egress'),
  ...(bin ? { bin } : {})
});

const state = await supervisor.prepare({
  subscriptionUrl,
  probeUrl: process.env.EGRESS_PROBE_URL || DEFAULT_PROBE_HOST
});

// Counts only: the node list is not a secret, but the subscription URL is.
console.log(`egress mode=${state.mode} nodes=${state.nodes_healthy}/${state.nodes_total}`);
if (state.last_error) console.log(`egress note: ${state.last_error}`);

if (state.mode !== 'proxy' || Number(state.nodes_healthy) === 0) {
  console.error('no subscription node reaches the vendor host; refusing to crawl direct');
  await supervisor.stop();
  process.exit(1);
}

// The supervisor holds the child. `--serve` keeps this process alive, which is
// what holds mihomo; the workflow stops it when the measurement ends.
console.log('mihomo is listening on 127.0.0.1:7897');
if (process.argv.includes('--serve')) {
  const shutdown = async () => { await supervisor.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await new Promise(() => {});
}
await supervisor.stop();
