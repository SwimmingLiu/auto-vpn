#!/usr/bin/env node
/**
 * Make sure the Pages project the profile publishes to exists.
 *
 * `wrangler pages deploy` against a missing project is a hard error in a
 * non-interactive shell — it prints "start by running: wrangler pages project
 * create" and exits. The CLI's own `auto_create_project_on_blocked` does not
 * cover this: it only reacts to the *blocked-project* markers, not to a project
 * that was never created.
 *
 * Without this, the first run measures for an hour, clears the gate, and then
 * fails at the very last stage — and the artifact it built is on a volume that
 * is wiped when the container sleeps, so recovery is a manual project create
 * plus another full run.
 *
 * Creating an existing project is treated as success: the API answers 409 with
 * code 8000007 ("Project already exists"), which is exactly the state we want.
 *
 * Usage: node scripts/ensure-pages-project.mjs <project-name>
 */
const projectName = process.argv[2];
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!projectName) {
  console.error('usage: ensure-pages-project.mjs <project-name>');
  process.exit(2);
}
if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must both be set');
  process.exit(2);
}

const base = 'https://api.cloudflare.com/client/v4';
const url = `${base}/accounts/${accountId}/pages/projects`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

/** One request, with the body kept so a failure can say what went wrong. */
async function call(init) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000), ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, body };
}

// A project name that already exists answers 200 to the list; asking the
// collection is one call and avoids guessing at per-name error codes.
const listed = await call({ method: 'GET' });
if (listed.ok && Array.isArray(listed.body.result)) {
  const names = listed.body.result.map((project) => String(project?.name ?? ''));
  if (names.includes(projectName)) {
    console.log(`pages project ${projectName}: exists`);
    process.exit(0);
  }
} else if (listed.status >= 500) {
  // A platform error is not evidence the project is missing; creating on top
  // of an unknown state is how a typo turns into a second project.
  console.error(`could not list pages projects (HTTP ${listed.status}); refusing to guess`);
  process.exit(1);
}

const created = await call({
  method: 'POST',
  body: JSON.stringify({ name: projectName, production_branch: 'main' })
});

if (created.ok) {
  console.log(`pages project ${projectName}: created`);
  process.exit(0);
}

const errors = created.body?.errors ?? [];
const exists = errors.some((error) => (
  error?.code === 8000007 || /already exists/i.test(String(error?.message ?? ''))
));
if (exists) {
  console.log(`pages project ${projectName}: already exists`);
  process.exit(0);
}

console.error(`could not create pages project ${projectName} (HTTP ${created.status})`);
for (const error of errors) console.error(`  ${error.code ?? '?'}: ${error.message ?? ''}`);
process.exit(1);
