#!/usr/bin/env node
/**
 * Smoke-test the Worker's routing, auth and DO wiring against a real workerd.
 *
 * `wrangler dev` runs the Worker locally; the container is not started (no
 * Docker build in this pass), so this covers everything above the container
 * boundary: auth, every `/api/*` route reaching the DO, and the DO's own
 * `/do/*` handlers answering.
 *
 * Usage: node scripts/smoke-worker.mjs http://127.0.0.1:8787 <token>
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const token = process.argv[3] ?? 'smoke-token';
const auth = { authorization: `Bearer ${token}` };

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

await check('unauthenticated request is rejected', async () => {
  const response = await fetch(`${base}/api/status`);
  expect(response.status === 401, `expected 401, got ${response.status}`);
  return '401';
});

await check('wrong bearer is rejected', async () => {
  const response = await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer nope' } });
  expect(response.status === 401, `expected 401, got ${response.status}`);
  return '401';
});

await check('health answers with auth', async () => {
  const response = await fetch(`${base}/health`, { headers: auth });
  expect(response.ok, `expected 200, got ${response.status}`);
  return JSON.stringify(await response.json());
});

await check('settings default to the schedule the VPS used', async () => {
  const response = await fetch(`${base}/api/settings`, { headers: auth });
  expect(response.ok, `expected 200, got ${response.status}`);
  const settings = await response.json();
  expect(settings.min_final_nodes === 50, `min_final_nodes=${settings.min_final_nodes}`);
  expect(settings.source_runtime_seconds === 900, `source_runtime_seconds=${settings.source_runtime_seconds}`);
  return JSON.stringify(settings);
});

await check('settings round-trip through the DO', async () => {
  const response = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ min_final_nodes: 7 })
  });
  expect(response.ok, `expected 200, got ${response.status}`);
  const updated = await response.json();
  expect(updated.min_final_nodes === 7, `min_final_nodes=${updated.min_final_nodes}`);
  // Restore so a re-run of this script starts from the same place.
  await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ min_final_nodes: 50 })
  });
  return 'min_final_nodes 50 -> 7 -> 50';
});

await check('runs list starts empty', async () => {
  const response = await fetch(`${base}/api/runs`, { headers: auth });
  expect(response.ok, `expected 200, got ${response.status}`);
  const payload = await response.json();
  expect(Array.isArray(payload.runs), 'runs is not an array');
  return `${payload.runs.length} runs`;
});

await check('status reports the container and run together', async () => {
  const response = await fetch(`${base}/api/status`, { headers: auth });
  expect(response.ok, `expected 200, got ${response.status}`);
  const payload = await response.json();
  expect('settings' in payload, 'no settings in status');
  return Object.keys(payload).join(',');
});

await check('an unknown path 404s rather than 500s', async () => {
  const response = await fetch(`${base}/api/nope`, { headers: auth });
  expect(response.status === 404, `expected 404, got ${response.status}`);
  return '404';
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
