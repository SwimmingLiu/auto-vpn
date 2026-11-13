#!/usr/bin/env node
/**
 * Report which Cloudflare permissions the deployment needs and which the
 * current token actually has.
 *
 * `wrangler deploy` fails with a bare "Authentication error" when a scope is
 * missing, which does not say which one. This asks each endpoint the deploy
 * touches and prints a table, so the fix is one token edit rather than a
 * guessing game.
 *
 * Usage: node scripts/check-token.mjs
 */
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must both be set');
  process.exit(2);
}

const base = 'https://api.cloudflare.com/client/v4';

/** Each probe is one permission the deploy path actually exercises. */
const probes = [
  { need: 'Workers Scripts:Edit', why: 'upload the Worker', path: `/accounts/${accountId}/workers/scripts` },
  // Documented as `GET /accounts/{id}/containers/applications`. `/containers/me`
  // is not a real route; probing it returns the same 403 a missing scope does,
  // which would keep reporting MISSING even on a correctly scoped token.
  { need: 'Containers:Edit', why: 'create and push the container application', path: `/accounts/${accountId}/containers/applications` },
  // Informational, deliberately not counted as a missing permission: a 403
  // here means either the scope is absent or the account has no Containers
  // entitlement, and the two are indistinguishable from this endpoint. It is
  // printed so that "every permission ok, deploy still says Authentication
  // error" has a visible next suspect (a Free-plan account) instead of none.
  {
    need: 'Containers plan',
    why: 'informational: 403 here can also mean no Workers Paid plan',
    path: `/accounts/${accountId}/containers/usage`,
    optional: true
  },
  { need: 'Account Settings:Read', why: 'resolve the account', path: `/accounts/${accountId}` },
  { need: 'Pages:Edit', why: 'the pipeline publishes a subscription', path: `/accounts/${accountId}/pages/projects` },
  { need: 'D1:Edit', why: 'optional: the account pool', path: `/accounts/${accountId}/d1/database`, optional: true },
  { need: 'Workers KV Storage:Edit', why: 'optional: brand fingerprints', path: `/accounts/${accountId}/storage/kv/namespaces`, optional: true }
];

let missing = 0;
console.log(`\n  ${'status'.padEnd(7)} ${'permission'.padEnd(26)} purpose`);
console.log(`  ${'-'.repeat(7)} ${'-'.repeat(26)} ${'-'.repeat(40)}`);

for (const probe of probes) {
  let status = 'FAIL';
  try {
    const response = await fetch(`${base}${probe.path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000)
    });
    if (response.ok) status = 'ok';
    else if (response.status === 403) status = 'MISSING';
    else status = `HTTP ${response.status}`;
  } catch (error) {
    status = 'ERROR';
  }
  if (status !== 'ok' && !probe.optional) {
    missing += 1;
  }
  console.log(`  ${status.padEnd(7)} ${probe.need.padEnd(26)} ${probe.why}${probe.optional ? ' (informational)' : ''}`);
}

console.log('');
if (missing === 0) {
  console.log('All required permissions are present.');
  // The one thing this table cannot settle: a Free-plan account answers 403 to
  // every containers route no matter what the token carries.
  console.log('If `wrangler deploy` still reports "Authentication error" with every row ok,');
  console.log('check the plan: Containers requires Workers Paid.');
} else {
  console.log(`${missing} required permission(s) missing.`);
  console.log('Edit the token at https://dash.cloudflare.com/profile/api-tokens and add them:');
  console.log('  Account -> Workers Scripts -> Edit');
  console.log('  Account -> Containers -> Edit');
  console.log('  Account -> Pages -> Edit        (the pipeline publishes a subscription)');
  console.log('  Zone    -> DNS   -> Edit        (only if a custom domain is used)');
  console.log('\nThen re-export CLOUDFLARE_API_TOKEN and deploy again.');
  process.exit(1);
}
