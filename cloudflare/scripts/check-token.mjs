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
let noPlan = false;
console.log(`\n  ${'status'.padEnd(7)} ${'permission'.padEnd(26)} purpose`);
console.log(`  ${'-'.repeat(7)} ${'-'.repeat(26)} ${'-'.repeat(40)}`);

for (const probe of probes) {
  let status = 'FAIL';
  let detail = '';
  try {
    const response = await fetch(`${base}${probe.path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000)
    });
    if (response.ok) {
      status = 'ok';
    } else if (response.status === 403) {
      status = 'MISSING';
    } else if (response.status === 401) {
      // Cloudflare answers 401, not 403, once authorization passes but the
      // account is not entitled — and it says so in the body. That is the
      // difference between "edit the token" and "upgrade the account", which
      // are two different people's problems.
      const body = await response.text().catch(() => '');
      if (/Workers Paid plan/i.test(body)) {
        status = 'NO PLAN';
        detail = 'Workers Paid required';
        noPlan = true;
      } else {
        status = 'HTTP 401';
        detail = body.slice(0, 120);
      }
    } else if (response.status >= 500) {
      // A platform incident, not a permission problem. Saying MISSING would
      // send the operator to edit a token that is already correct.
      status = 'DOWN';
      detail = (await response.text().catch(() => '')).slice(0, 100) || 'platform error';
    } else {
      status = `HTTP ${response.status}`;
    }
  } catch (error) {
    status = 'ERROR';
    detail = error.message;
  }
  if (status !== 'ok' && !probe.optional) {
    missing += 1;
  }
  console.log(`  ${status.padEnd(7)} ${probe.need.padEnd(26)} ${detail || probe.why}${probe.optional ? ' (informational)' : ''}`);
}

console.log('');
if (missing === 0) {
  console.log('All required permissions are present.');
} else {
  console.log(`${missing} required permission(s) missing.`);
  // The two failures look alike from `wrangler deploy` and are fixed by
  // different people: one is a token edit, the other an account upgrade.
  const noPlanAccount = noPlan;
  console.log('');
  if (noPlanAccount) {
    console.log('The token is scoped correctly, but the account cannot use Containers.');
    console.log('Deploying containers requires the Workers Paid plan ($5/month):');
    console.log('  https://dash.cloudflare.com/?to=/:account/workers/plans');
    console.log('Workers Scripts and Pages already work on the current plan.');
  } else {
    console.log('Edit the token at https://dash.cloudflare.com/profile/api-tokens and add them:');
    console.log('  Account -> Workers Scripts -> Edit');
    console.log('  Account -> Pages -> Edit        (the pipeline publishes a subscription)');
    console.log('  Zone    -> DNS   -> Edit        (only if a custom domain is used)');
    console.log('\nThen re-export CLOUDFLARE_API_TOKEN and deploy again.');
  }
  console.log('');
  process.exit(1);
}
