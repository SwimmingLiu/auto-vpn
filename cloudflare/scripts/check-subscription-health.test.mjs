import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeSubscription,
  detect1014,
  main,
  nextProjectName,
  redactUrl,
  redactValue,
  scrubSecrets
} from './check-subscription-health.mjs';

/**
 * The monitor exists because a green deploy is not a served subscription. Each
 * test below pins one of the states that has actually taken the service down:
 * a CNAME left on a deleted project (HTTP 403 / 1014 while www stays up), a
 * missing custom domain, a blocked project, and a 200 whose body is the decoy
 * page or the random bytes a wrong token produces.
 *
 * Everything is stubbed at `fetchImpl`; every sleep is a no-op that only
 * counts. The world is mutable and the stub derives HTTP outcomes from it, so
 * a repair really changes what the next observation sees.
 *
 * 馆废而符犹指之，则关隘拒客，报 1014；馆封则当迁；名缺则当补；天书不正
 * 则不可谓之无恙。诸测皆以伪网代真，睡而不候，故瞬息可毕。
 */

const ACCOUNT = 'e743286b4304e96ee8795d62917052aa';
const ZONE_ID = 'b32f7701a3e7babf21f0e9a90f6442fe';
const ZONE_NAME = 'swimmingliu.online';
const APEX = 'swimmingliu.online';
const WWW = 'www.swimmingliu.online';
const LIVE = 'sub-links-share-22';
const API_TOKEN = 'cf-token-abcdefghijklmnop';
const SUB_TOKEN = 'sub-token-QWERTY1234567890';
const ADMIN_SECRET = 'admin-secret-value-123456';
const CF_RAY = '8f2c1a0b9d8e7f6a-SJC';
const PAGES_DEV = `${LIVE}.pages.dev`;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function textResponse(body, status = 200, contentType = 'text/plain') {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType, 'cf-ray': CF_RAY }
  });
}

/** A healthy account: one live project, both hosts attached and pointed at it. */
function makeWorld() {
  return {
    zoneName: ZONE_NAME,
    projects: [
      {
        name: LIVE,
        blocked: false,
        deployment_configs: {
          production: {
            env_vars: { ADMIN: { type: 'secret_text', value: ADMIN_SECRET }, KEY: { type: 'plain_text', value: 'share' } },
            kv_namespaces: [{ binding: 'KV', id: 'kv-namespace-1' }]
          },
          preview: {
            env_vars: { ADMIN: { type: 'secret_text', value: ADMIN_SECRET } },
            kv_namespaces: [{ binding: 'KV', id: 'kv-namespace-1' }]
          }
        }
      },
      // A sibling family in the same account: must never be rotated or probed.
      { name: 'sub-nodes-05', blocked: false, deployment_configs: {} }
    ],
    domains: {
      [LIVE]: [{ name: APEX }, { name: WWW }]
    },
    dns: [
      { id: 'dns-apex', type: 'CNAME', name: APEX, content: PAGES_DEV, proxied: true },
      { id: 'dns-www', type: 'CNAME', name: WWW, content: PAGES_DEV, proxied: false }
    ],
    probe: null,
    rejectAuth: false,
    calls: [],
    ids: 0
  };
}

function findProject(world, name) {
  return world.projects.find((project) => project.name === name);
}

/**
 * What the real API returns for `deployment_configs`: a `secret_text` binding
 * keeps its name and type but never its value. The world stores the value so a
 * test can assert what a rotation should have filled in; the API must not hand
 * it back, or the "a copied secret is blank" bug would be invisible here.
 */
function redactSecrets(configs) {
  const out = {};
  for (const [environment, config] of Object.entries(configs ?? {})) {
    const envVars = {};
    for (const [name, binding] of Object.entries(config?.env_vars ?? {})) {
      envVars[name] = binding?.type === 'secret_text'
        ? { type: 'secret_text' }
        : { ...binding };
    }
    out[environment] = { ...config, env_vars: envVars };
  }
  return out;
}

/**
 * Pages reports a custom domain's status from the live DNS state, so a domain
 * attached while its CNAME still points elsewhere is `pending` and becomes
 * `active` once the CNAME moves. Deriving it on read (not freezing it at
 * attach time) is what lets the rotation test observe the real settle.
 */
function domainList(world, name) {
  return (world.domains[name] ?? []).map((domain) => ({
    name: domain.name,
    status: domain.pinnedStatus ?? attachStatus(world, name, domain.name)
  }));
}

function cnameFor(world, host) {
  return world.dns.find((record) => record.type === 'CNAME' && record.name === host);
}

/** What a real client would get for `https://<host>/`, derived from state. */
function hostResponse(world, host) {
  const cname = cnameFor(world, host);
  if (!cname) {
    return textResponse('<html><title>Not found</title></html>', 404, 'text/html');
  }
  const match = /^([a-z0-9-]+)\.pages\.dev$/i.exec(cname.content);
  const project = match ? findProject(world, match[1]) : null;
  if (!project) {
    // The 2026-11-24 failure: apex on a deleted project, Cloudflare says 1014.
    return new Response(
      '<html><head><title>Error 1014</title></head><body><h1>CNAME Cross-User Banned</h1><p>error code: 1014</p></body></html>',
      { status: 403, headers: { 'content-type': 'text/html', 'cf-ray': CF_RAY } }
    );
  }
  if (project.blocked) {
    return new Response(
      '<html><body>Pages project has been blocked (code: 8000119)</body></html>',
      { status: 403, headers: { 'content-type': 'text/html', 'cf-ray': CF_RAY } }
    );
  }
  if (!(world.domains[project.name] ?? []).some((domain) => domain.name === host)) {
    return textResponse('<html><body>no route for this hostname</body></html>', 404, 'text/html');
  }
  return textResponse('ok', 200);
}

function attachStatus(world, project, host) {
  const cname = cnameFor(world, host);
  return cname && cname.content === `${project}.pages.dev` ? 'active' : 'pending';
}

function api(world, method, url, init) {
  const path = url.pathname.replace(/^\/client\/v4/, '');
  const seg = path.split('/').filter(Boolean);
  let body;
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  world.calls.push({ method, path, search: url.search, body });

  if (world.rejectAuth) {
    return jsonResponse({ success: false, errors: [{ code: 10000, message: `Authentication error: invalid token ${API_TOKEN}` }] }, 401);
  }

  if (seg.length === 1 && seg[0] === 'zones') {
    const name = url.searchParams.get('name');
    const result = name === world.zoneName ? [{ id: ZONE_ID, name: world.zoneName }] : [];
    return jsonResponse({ success: true, result, result_info: { total_pages: 1 } });
  }

  if (seg[0] === 'zones' && seg[1] === ZONE_ID && seg[2] === 'dns_records') {
    if (seg.length === 3) {
      if (method === 'GET') {
        const type = (url.searchParams.get('type') ?? '').toUpperCase();
        const result = world.dns.filter((record) => !type || record.type === type);
        return jsonResponse({ success: true, result, result_info: { total_pages: 1 } });
      }
      if (method === 'POST') {
        const record = { id: `dns-new-${++world.ids}`, ...body };
        world.dns.push(record);
        return jsonResponse({ success: true, result: record });
      }
    }
    if (seg.length === 4) {
      const record = world.dns.find((item) => item.id === seg[3]);
      if (!record) return jsonResponse({ success: false, errors: [{ code: 81044, message: 'Record not found' }] }, 404);
      if (method === 'PATCH') {
        Object.assign(record, body);
        return jsonResponse({ success: true, result: record });
      }
      if (method === 'DELETE') {
        world.dns = world.dns.filter((item) => item.id !== seg[3]);
        return jsonResponse({ success: true, result: { id: seg[3] } });
      }
    }
    return jsonResponse({ success: false, errors: [{ code: 7003, message: 'route not found' }] }, 404);
  }

  if (seg[0] === 'accounts' && seg[1] === ACCOUNT && seg[2] === 'pages' && seg[3] === 'projects') {
    if (seg.length === 4) {
      if (method === 'GET') {
        return jsonResponse({
          success: true,
          result: world.projects.map((project) => ({ name: project.name })),
          result_info: { total_pages: 1 }
        });
      }
      if (method === 'POST') {
        if (findProject(world, body?.name)) {
          return jsonResponse({ success: false, errors: [{ code: 8000007, message: 'Project already exists.' }] }, 409);
        }
        const project = { name: body.name, blocked: false, deployment_configs: {} };
        world.projects.push(project);
        return jsonResponse({ success: true, result: { name: project.name } });
      }
    }
    const name = seg[4];
    if (seg.length === 5) {
      const project = findProject(world, name);
      if (!project) return jsonResponse({ success: false, errors: [{ code: 8000007, message: 'Project not found' }] }, 404);
      if (method === 'GET') {
        return jsonResponse({ success: true, result: { name: project.name, deployment_configs: redactSecrets(project.deployment_configs) } });
      }
      if (method === 'PATCH') {
        Object.assign(project, body);
        return jsonResponse({ success: true, result: { name: project.name } });
      }
      if (method === 'DELETE') {
        world.projects = world.projects.filter((item) => item.name !== name);
        return jsonResponse({ success: true, result: { name } });
      }
    }
    if (seg[5] === 'domains') {
      const project = findProject(world, name);
      if (seg.length === 6) {
        if (!project) return jsonResponse({ success: false, errors: [{ code: 8000007, message: 'Project not found' }] }, 404);
        if (project.blocked) {
          return jsonResponse({ success: false, errors: [{ code: 8000119, message: 'Pages project has been blocked' }] }, 400);
        }
        if (method === 'GET') {
          return jsonResponse({ success: true, result: domainList(world, name), result_info: { total_pages: 1 } });
        }
        if (method === 'POST') {
          const holder = Object.entries(world.domains).find(([, domains]) => domains.some((domain) => domain.name === body.name));
          if (holder) {
            return jsonResponse({ success: false, errors: [{ code: 8000011, message: `A custom domain with the hostname "${body.name}" already exists.` }] }, 409);
          }
          world.domains[name] = [...world.domains[name] ?? [], { name: body.name }];
          return jsonResponse({ success: true, result: { name: body.name, status: attachStatus(world, name, body.name) } });
        }
      }
      if (seg.length === 7 && method === 'DELETE') {
        const host = decodeURIComponent(seg[6]);
        world.domains[name] = (world.domains[name] ?? []).filter((domain) => domain.name !== host);
        return jsonResponse({ success: true, result: { name: host } });
      }
    }
    return jsonResponse({ success: false, errors: [{ code: 7003, message: 'route not found' }] }, 404);
  }

  return jsonResponse({ success: false, errors: [{ code: 7003, message: 'route not found' }] }, 404);
}

function createFetch(world) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = String(init.method ?? 'GET').toUpperCase();
    if (parsed.hostname === 'api.cloudflare.com') return api(world, method, parsed, init);
    if (parsed.hostname.endsWith('.pages.dev')) {
      const name = parsed.hostname.replace(/\.pages\.dev$/, '');
      const project = findProject(world, name);
      if (!project) return textResponse('<html><body>Project not found</body></html>', 404, 'text/html');
      if (project.blocked) {
        return textResponse('<html><body>Pages project has been blocked (code: 8000119)</body></html>', 403, 'text/html');
      }
      return textResponse('ok', 200);
    }
    if (parsed.pathname === '/') return hostResponse(world, parsed.hostname);
    const probe = world.probe ?? { status: 200, body: 'ok' };
    return textResponse(probe.body, probe.status, 'text/plain');
  };
}

function capture() {
  return {
    text: '',
    write(chunk) {
      this.text += String(chunk);
      return true;
    }
  };
}

async function runChecker(world, argv = [], envOverrides = {}, options = {}) {
  const stdout = capture();
  const stderr = capture();
  let sleeps = 0;
  const baseFetch = createFetch(world);
  const fetchImpl = options.wrapFetch ? options.wrapFetch(baseFetch) : baseFetch;
  const code = await main(argv, {
    env: {
      CLOUDFLARE_API_TOKEN: API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_ZONE_ID: ZONE_ID,
      ...envOverrides
    },
    fetchImpl,
    sleep: async () => {
      sleeps += 1;
    },
    ...(options.runDeploy ? { runDeploy: options.runDeploy } : {}),
    stdout,
    stderr
  });
  return { code, stdout: stdout.text, stderr: stderr.text, sleeps };
}

const findingsByCode = (report) => report.findings.map((finding) => finding.code);
const writes = (world) => world.calls.filter((call) => call.method !== 'GET');

// ---------------------------------------------------------------------------
// (a) the exact 1014 case
// ---------------------------------------------------------------------------

test('apex on a deleted project is dns_wrong_target + http_1014, and www staying up does not hide it', async () => {
  const world = makeWorld();
  world.dns[0].content = 'sub-links-share-06.pages.dev'; // that project no longer exists

  const result = await runChecker(world, ['--json']);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.healthy, false);
  const codes = report.findings.map((finding) => `${finding.code}:${finding.host}`);
  // Both required diagnoses, and only on the apex: www never wavered.
  assert.ok(codes.includes('dns_wrong_target:swimmingliu.online'), codes.join(','));
  assert.ok(codes.includes('http_1014:swimmingliu.online'), codes.join(','));
  assert.deepEqual(report.findings.filter((finding) => finding.host === WWW), [], 'www was diagnosed');
  const apex = report.observations.hosts.find((entry) => entry.host === APEX);
  assert.equal(apex.status, 403);
  assert.equal(apex.error1014, true);
  assert.equal(apex.cfRay, CF_RAY);
  const www = report.observations.hosts.find((entry) => entry.host === WWW);
  assert.equal(www.status, 200);
  // No repair was requested, so nothing may have been written.
  assert.equal(writes(world).length, 0);
});

test('--repair PATCHes the apex CNAME to the live project and verifies healthy', async () => {
  const world = makeWorld();
  world.dns[0].content = 'sub-links-share-06.pages.dev';

  const result = await runChecker(world, ['--json', '--repair']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.healthy, true);
  assert.deepEqual(report.findings, []);

  const patch = world.calls.find((call) => call.method === 'PATCH' && call.path === `/zones/${ZONE_ID}/dns_records/dns-apex`);
  assert.ok(patch, 'no PATCH was sent for the apex record');
  assert.deepEqual(patch.body, { type: 'CNAME', name: APEX, content: PAGES_DEV, proxied: true, ttl: 1 });
  assert.equal(cnameFor(world, APEX).content, PAGES_DEV);
  assert.equal(world.dns.find((record) => record.id === 'dns-www').content, PAGES_DEV, 'www was touched without cause');
  assert.equal(world.dns.find((record) => record.id === 'dns-www').proxied, false, 'proxy flags were not preserved');
  assert.ok(report.repairs.some((repair) => repair.action === 'dns_repoint' && repair.status === 'done'));
  // No sleeps are needed when the first post-repair observation is already healthy.
  assert.equal(result.sleeps, 0);
});

// ---------------------------------------------------------------------------
// (b) a missing custom domain is attached
// ---------------------------------------------------------------------------

test('a hostname missing from the project custom domains is attached', async () => {
  const world = makeWorld();
  world.domains[LIVE] = [{ name: WWW }];

  const before = await runChecker(world, ['--json']);
  assert.equal(before.code, 1);
  assert.ok(findingsByCode(JSON.parse(before.stdout)).includes('custom_domain_missing'));

  const result = await runChecker(world, ['--json', '--repair']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const post = world.calls.find((call) => call.method === 'POST' && call.path === `/accounts/${ACCOUNT}/pages/projects/${LIVE}/domains`);
  assert.ok(post, 'no custom domain POST was sent');
  assert.deepEqual(post.body, { name: APEX });
  assert.ok(world.domains[LIVE].some((domain) => domain.name === APEX));
  assert.equal(JSON.parse(result.stdout).healthy, true);
});

test('an attached-but-pending custom domain is reported and not treated as healthy', async () => {
  const world = makeWorld();
  // CNAME correct, domain stuck pending: e.g. a certificate that never issued.
  world.domains[LIVE] = [{ name: APEX, pinnedStatus: 'pending' }, { name: WWW }];

  const result = await runChecker(world, ['--json', '--repair']);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(findingsByCode(report).includes('custom_domain_not_active'));
  assert.equal(report.findings.find((finding) => finding.code === 'custom_domain_not_active').repairable, false);
  // Pending is a platform-side state; there is no repair to send.
  assert.equal(writes(world).length, 0);
});

// ---------------------------------------------------------------------------
// (c) a blocked project rotates to the next suffix
// ---------------------------------------------------------------------------

test('a blocked project rotates to the next free suffix and carries env vars, KV bindings and domains', async () => {
  const world = makeWorld();
  findProject(world, LIVE).blocked = true;

  const before = await runChecker(world, ['--json']);
  assert.equal(before.code, 1);
  const diagnosis = JSON.parse(before.stdout);
  assert.ok(diagnosis.findings.some((finding) => finding.code === 'project_blocked' && finding.project === LIVE));

  // A `secret_text` value is write-only: the API returns its name and never the
  // value, so a copy alone would blank the new project's `ADMIN`. The runner
  // supplies the replacement out of band.
  const result = await runChecker(world, ['--json', '--repair'], { HEALTH_SECRET_ADMIN: ADMIN_SECRET });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.healthy, true);

  // The new project is max(existing suffix) + 1, not reuse of the blocked name.
  const created = world.calls.find((call) => call.method === 'POST' && call.path === `/accounts/${ACCOUNT}/pages/projects`);
  assert.ok(created, 'no project was created');
  assert.equal(created.body.name, 'sub-links-share-23');
  assert.ok(findProject(world, 'sub-links-share-23'), 'created project is missing from the account');

  // Env vars and KV bindings came from the blocked project.
  const patch = world.calls.find((call) => call.method === 'PATCH' && call.path === `/accounts/${ACCOUNT}/pages/projects/sub-links-share-23`);
  assert.ok(patch, 'deployment_configs were not copied');
  assert.equal(patch.body.deployment_configs.production.env_vars.ADMIN.value, ADMIN_SECRET);
  assert.deepEqual(patch.body.deployment_configs.production.kv_namespaces, [{ binding: 'KV', id: 'kv-namespace-1' }]);

  // Without HEALTH_DEPLOY_DIR the rotation must say a redeploy is manual —
  // and must still move the CNAMEs so a later deploy has somewhere to land.
  assert.ok(report.repairs.some((repair) => repair.action === 'manual_redeploy_required' && repair.project === 'sub-links-share-23'));
  assert.equal(cnameFor(world, APEX).content, 'sub-links-share-23.pages.dev');
  assert.equal(cnameFor(world, WWW).content, 'sub-links-share-23.pages.dev');
  assert.equal(cnameFor(world, APEX).proxied, true);
  assert.equal(cnameFor(world, WWW).proxied, false);

  // Domains moved off the blocked project before being attached to the new one.
  assert.ok(world.domains[LIVE].length === 0, 'domains were left on the blocked project');
  assert.deepEqual(world.domains['sub-links-share-23'].map((domain) => domain.name).sort(), [APEX, WWW].sort());
  const detachAt = world.calls.findIndex((call) => call.method === 'DELETE' && call.path === `/accounts/${ACCOUNT}/pages/projects/${LIVE}/domains/${APEX}`);
  const attachAt = world.calls.findIndex((call) => call.method === 'POST' && call.path === `/accounts/${ACCOUNT}/pages/projects/sub-links-share-23/domains`);
  assert.ok(detachAt !== -1 && attachAt !== -1 && detachAt < attachAt, 'attach happened before detach');

  // A copied secret is summarised by name only, never printed.
  assert.ok(!result.stdout.includes(ADMIN_SECRET), 'a Pages env var value leaked into the report');
  const copy = report.repairs.find((repair) => repair.action === 'config_copy');
  assert.deepEqual(copy.config.envVars, ['ADMIN', 'KEY']);
  assert.deepEqual(copy.config.kvNamespaces, ['KV']);
});

test('a secret that cannot be copied is reported by name, not silently blanked', async () => {
  const world = makeWorld();
  findProject(world, LIVE).blocked = true;

  const result = await runChecker(world, ['--json', '--repair']);
  const report = JSON.parse(result.stdout);

  // The rotation still happens — the CNAMEs must move or every client stays
  // down — but the missing secret is a named manual step, not a silent loss.
  assert.ok(report.repairs.some((repair) => repair.action === 'secret_reset_required'
    && repair.status === 'manual'
    && repair.project === 'sub-links-share-23'
    && repair.detail.includes('ADMIN')), JSON.stringify(report.repairs));

  const patch = world.calls.find((call) => call.method === 'PATCH' && call.path === `/accounts/${ACCOUNT}/pages/projects/sub-links-share-23`);
  assert.ok(patch, 'deployment_configs were not copied');
  const admin = patch.body.deployment_configs.production.env_vars.ADMIN;
  assert.equal(admin.type, 'secret_text');
  assert.ok(!admin.value, 'a secret with no replacement value must not be sent as plaintext');

  // `KEY` is plain_text, so it is copied verbatim; only secrets need help.
  assert.equal(patch.body.deployment_configs.production.env_vars.KEY.value, 'share');
  assert.ok(!result.stdout.includes(ADMIN_SECRET), 'a secret value reached the report');
});

test('the project probe never touches the un-prefixed family', async () => {
  const world = makeWorld();
  await runChecker(world, ['--json']);
  assert.ok(!world.calls.some((call) => call.path.includes('sub-nodes-05')));
});

test('a missing project is rotated as well', async () => {
  const world = makeWorld();
  world.projects = world.projects.filter((project) => project.name !== LIVE);
  world.domains = {};
  world.dns[0].content = 'sub-links-share-06.pages.dev';
  world.dns[1].content = 'sub-links-share-06.pages.dev';

  const result = await runChecker(world, ['--json', '--repair']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.repairs.some((repair) => repair.action === 'project_create' && repair.project === 'sub-links-share-01'));
  assert.equal(cnameFor(world, APEX).content, 'sub-links-share-01.pages.dev');
});

test('rotation picks up a blocked project a CNAME still points at, and never a blocked sibling nothing points at', async () => {
  const world = makeWorld();
  // A newer blocked sibling exists, but both CNAMEs still point at LIVE: the
  // serving project is correct, so nothing here is a finding.
  world.projects.push({ name: 'sub-links-share-23', blocked: true, deployment_configs: {} });
  const healthy = await runChecker(world, ['--json', '--repair']);
  assert.equal(healthy.code, 0, healthy.stdout + healthy.stderr);
  assert.ok(!world.calls.some((call) => call.path.endsWith('/sub-links-share-24')), 'an unused blocked sibling caused a rotation');

  // Now point the apex at the blocked sibling: that is a finding, and repair
  // rotates to -24 (the blocked project's suffix is included in max+1).
  const rotating = makeWorld();
  rotating.projects.push({ name: 'sub-links-share-23', blocked: true, deployment_configs: {} });
  rotating.dns[0].content = 'sub-links-share-23.pages.dev';
  // A hostname is attached to one project at a time; both are on the one whose
  // CNAME the apex carries.
  rotating.domains = { 'sub-links-share-23': [{ name: APEX }, { name: WWW }] };
  const diagnosed = await runChecker(rotating, ['--json']);
  assert.equal(diagnosed.code, 1);
  assert.ok(JSON.parse(diagnosed.stdout).findings.some((finding) => finding.code === 'project_blocked' && finding.project === 'sub-links-share-23'));

  const repaired = await runChecker(rotating, ['--json', '--repair']);
  assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).repairs.find((repair) => repair.action === 'project_create').project, 'sub-links-share-24');
  assert.equal(cnameFor(rotating, APEX).content, 'sub-links-share-24.pages.dev');
  assert.equal(cnameFor(rotating, WWW).content, 'sub-links-share-24.pages.dev');
});

// ---------------------------------------------------------------------------
// (d) a 200 that is not the subscription
// ---------------------------------------------------------------------------

test('a 200 decoy HTML page with a probe configured is payload_invalid, not healthy', async () => {
  const world = makeWorld();
  world.probe = { status: 200, body: '<!DOCTYPE html><html><head><title>VPN</title></head><body>welcome</body></html>' };
  const env = { HEALTH_SUBSCRIPTION_PROBE: `https://${WWW}/sub?token=${SUB_TOKEN}` };

  const result = await runChecker(world, ['--json'], env);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.healthy, false);
  assert.ok(findingsByCode(report).includes('payload_invalid'));
  assert.equal(report.observations.probe.decoy, true);
  assert.equal(report.observations.probe.linkCount, 0);
});

test('a 200 whose body decodes to random bytes is payload_invalid', async () => {
  const world = makeWorld();
  world.probe = { status: 200, body: Buffer.from([0x91, 0x23, 0x44, 0x1f, 0x00, 0x7a, 0xff, 0x10]).toString('base64') };
  const env = { HEALTH_SUBSCRIPTION_PROBE: `https://${WWW}/sub?token=${SUB_TOKEN}` };

  const result = await runChecker(world, ['--json'], env);
  assert.equal(result.code, 1);
  assert.ok(findingsByCode(JSON.parse(result.stdout)).includes('payload_invalid'));
});

test('a probe that decodes through two base64 layers to links is healthy', async () => {
  const world = makeWorld();
  const links = 'vmess://eyJ2IjoyLCJhZGQiOiIxOTguNTEuMTAwLjEifQ==\nvless://8f0d1c4e-2b1a-4c3d-9e8f-0123456789ab@edge.example:443';
  world.probe = { status: 200, body: Buffer.from(Buffer.from(links, 'utf8').toString('base64'), 'utf8').toString('base64') };

  const result = await runChecker(world, ['--json'], { HEALTH_SUBSCRIPTION_PROBE: `https://${WWW}/sub?token=${SUB_TOKEN}` });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.observations.probe.linkCount, 2);
  assert.equal(report.observations.probe.layers, 2);
});

// ---------------------------------------------------------------------------
// (e) redaction
// ---------------------------------------------------------------------------

test('redactValue reveals at most four characters, and none of a short secret', () => {
  assert.equal(redactValue(''), '');
  assert.equal(redactValue('short12'), '...');
  assert.equal(redactValue('a'.repeat(11)), '...');
  assert.equal(redactValue('a'.repeat(12)), 'aaaa...');
});

test('redactUrl masks userinfo and every sensitive query value', () => {
  const redacted = redactUrl('https://user:passw0rd@example.com/sub?token=abcdef1234567890&static=1');
  assert.doesNotMatch(redacted, /passw0rd/);
  assert.doesNotMatch(redacted, /abcdef1234567890/);
  assert.match(redacted, /static=1/);
  assert.match(redacted, /token=abcd\.\.\./);
});

test('scrubSecrets removes a known secret from nested report data', () => {
  const scrubbed = scrubSecrets(
    { detail: `failed with ${API_TOKEN}`, list: [`x${API_TOKEN}y`], n: 1 },
    [API_TOKEN]
  );
  assert.doesNotMatch(JSON.stringify(scrubbed), new RegExp(API_TOKEN));
  assert.equal(scrubbed.n, 1);
});

test('the probe token never reaches stdout, including through an invalid payload', async () => {
  const world = makeWorld();
  world.probe = { status: 200, body: '<html><body>decoy</body></html>' };
  const result = await runChecker(world, ['--json'], { HEALTH_SUBSCRIPTION_PROBE: `https://${WWW}/sub?token=${SUB_TOKEN}` });
  assert.equal(result.code, 1);
  assert.ok(!result.stdout.includes(SUB_TOKEN), 'the subscription token was printed');
  assert.ok(!result.stderr.includes(SUB_TOKEN), 'the subscription token was printed to stderr');
  assert.match(JSON.parse(result.stdout).observations.probe.url, /token=sub-/);
});

test('a credential rejection exits 2 and does not echo the API token', async () => {
  const world = makeWorld();
  world.rejectAuth = true;
  const result = await runChecker(world, ['--json']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /rejected the credentials/);
  assert.ok(!result.stderr.includes(API_TOKEN), 'the API token was printed');
});

// ---------------------------------------------------------------------------
// (f) exit codes and modes
// ---------------------------------------------------------------------------

test('a healthy service exits 0 with an empty findings and repairs list', async () => {
  const world = makeWorld();
  const result = await runChecker(world, ['--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, {
    healthy: true,
    findings: [],
    repairs: [],
    observations: report.observations
  });
  assert.equal(report.observations.servingProject, LIVE);
  assert.equal(report.observations.hosts.length, 2);
});

test('--json prints exactly one JSON object', async () => {
  const world = makeWorld();
  const result = await runChecker(world, ['--json']);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  JSON.parse(lines[0]);
});

test('usage and configuration errors exit 2', async () => {
  const world = makeWorld();
  const missing = await runChecker(world, ['--json'], { CLOUDFLARE_API_TOKEN: '' });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /CLOUDFLARE_API_TOKEN/);

  const unknown = await runChecker(world, ['--nonsense']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown argument/);

  const badAttempts = await runChecker(world, ['--json'], { HEALTH_VERIFY_ATTEMPTS: 'zero' });
  assert.equal(badAttempts.code, 2);
  assert.match(badAttempts.stderr, /HEALTH_VERIFY_ATTEMPTS/);

  const help = await runChecker(world, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage: check-subscription-health\.mjs/);
  assert.equal(writes(world).length, 0);
});

test('--dry-run plans the repairs without sending a single write', async () => {
  const world = makeWorld();
  world.dns[0].content = 'sub-links-share-06.pages.dev';

  const result = await runChecker(world, ['--json', '--dry-run']);
  assert.equal(result.code, 1, 'a dry run cannot verify, so it reports the finding');
  const report = JSON.parse(result.stdout);
  assert.equal(report.healthy, false);
  assert.equal(world.calls.filter((call) => call.method !== 'GET').length, 0, 'a dry run wrote to Cloudflare');
  const planned = report.repairs.find((repair) => repair.action === 'dns_repoint');
  assert.ok(planned, 'the planned repair is missing');
  assert.equal(planned.status, 'planned');
  assert.deepEqual(planned.call.body, { type: 'CNAME', name: APEX, content: PAGES_DEV, proxied: true, ttl: 1 });
  // The stale record is untouched on disk.
  assert.equal(cnameFor(world, APEX).content, 'sub-links-share-06.pages.dev');
});

test('--dry-run during a rotation plans the deploy and never invokes it', async () => {
  const world = makeWorld();
  findProject(world, LIVE).blocked = true;
  let deploys = 0;
  const result = await runChecker(world, ['--json', '--dry-run'], { HEALTH_DEPLOY_DIR: '/tmp/share-bundle' }, {
    runDeploy: async () => {
      deploys += 1;
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(deploys, 0, 'a dry run shelled out to wrangler');
  const plan = report.repairs.find((repair) => repair.action === 'worker_deploy');
  assert.equal(plan.status, 'planned');
  assert.ok(plan.command.includes('/tmp/share-bundle'));
  assert.equal(world.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('a rotation with HEALTH_DEPLOY_DIR deploys the bundle to the new project', async () => {
  const world = makeWorld();
  findProject(world, LIVE).blocked = true;
  const deploys = [];
  const result = await runChecker(world, ['--json', '--repair'], { HEALTH_DEPLOY_DIR: '/tmp/share-bundle' }, {
    runDeploy: async ({ dir, project }) => {
      deploys.push({ dir, project });
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(deploys, [{ dir: '/tmp/share-bundle', project: 'sub-links-share-23' }]);
  assert.ok(!result.stdout.includes('manual_redeploy_required'));
});

test('verification retries a bounded number of times, with no real sleeps', async () => {
  const world = makeWorld();
  world.dns[0].content = 'sub-links-share-06.pages.dev';
  // The repair lands, but the host answers 500 for the first two re-checks:
  // Pages takes a moment to pick the new deployment up.
  const original = world.dns[0].content;
  let hostCalls = 0;
  const result = await runChecker(world, ['--json', '--repair'], { HEALTH_VERIFY_ATTEMPTS: '6', HEALTH_VERIFY_DELAY_MS: '1' }, {
    wrapFetch: (inner) => async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === APEX && world.dns[0].content !== original) {
        hostCalls += 1;
        if (hostCalls <= 2) return new Response('warming up', { status: 500 });
      }
      return inner(url, init);
    }
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(hostCalls, 3, 'verification did not retry until the host settled');
  assert.equal(result.sleeps, 2);
});

test('verification gives up after the configured attempts and exits 1', async () => {
  const world = makeWorld();
  world.dns[0].content = 'sub-links-share-06.pages.dev';
  const result = await runChecker(world, ['--json', '--repair'], { HEALTH_VERIFY_ATTEMPTS: '3', HEALTH_VERIFY_DELAY_MS: '1' }, {
    wrapFetch: (inner) => async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === APEX && cnameFor(world, APEX).content !== 'sub-links-share-06.pages.dev') {
        return new Response('still broken', { status: 502 });
      }
      return inner(url, init);
    }
  });
  assert.equal(result.code, 1);
  assert.equal(result.sleeps, 2, 'attempts - 1 sleeps between them');
  const report = JSON.parse(result.stdout);
  assert.ok(findingsByCode(report).includes('http_error'));
});

test('a non-1014 HTTP failure is http_error and is not told to repoint DNS', async () => {
  const world = makeWorld();
  const result = await runChecker(world, ['--json'], {}, {
    wrapFetch: (inner) => async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === WWW && parsed.pathname === '/') {
        return new Response('<html><body>Bad gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
      }
      return inner(url, init);
    }
  });
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  const finding = report.findings.find((item) => item.host === WWW);
  assert.equal(finding.code, 'http_error');
  assert.equal(finding.repairable, false);
  assert.ok(!report.findings.some((item) => item.code === 'http_1014'));
});

test('the zone is resolved by name when CLOUDFLARE_ZONE_ID is absent', async () => {
  const world = makeWorld();
  const result = await runChecker(world, ['--json'], { CLOUDFLARE_ZONE_ID: '' });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(world.calls.some((call) => call.method === 'GET' && call.path === '/zones' && call.search.includes('name=swimmingliu.online')));
});

test('a hostname with no CNAME is dns_missing and repair creates it with the host default proxy flag', async () => {
  const world = makeWorld();
  world.dns = world.dns.filter((record) => record.name !== WWW);

  const before = await runChecker(world, ['--json']);
  assert.equal(before.code, 1);
  assert.ok(JSON.parse(before.stdout).findings.some((finding) => finding.code === 'dns_missing' && finding.host === WWW));

  const result = await runChecker(world, ['--json', '--repair']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const created = world.calls.find((call) => call.method === 'POST' && call.path === `/zones/${ZONE_ID}/dns_records`);
  assert.ok(created, 'no CNAME was created');
  assert.deepEqual(created.body, { type: 'CNAME', name: WWW, content: PAGES_DEV, proxied: false, ttl: 1 });
});

// ---------------------------------------------------------------------------
// Small pure functions
// ---------------------------------------------------------------------------

test('decodeSubscription peels at most four layers and ignores HTML', () => {
  const link = 'vmess://eyJ2IjoyLCJhZGQiOiIxOTguNTEuMTAwLjEifQ==';
  let body = link;
  for (let layer = 0; layer < 3; layer += 1) body = Buffer.from(body, 'utf8').toString('base64');
  assert.deepEqual(decodeSubscription(body), { links: [link], layers: 3 });
  assert.deepEqual(decodeSubscription('<html><body>x</body></html>'), { links: [], layers: 0 });
  assert.deepEqual(decodeSubscription(''), { links: [], layers: 0 });
});

test('detect1014 recognises both spellings Cloudflare uses', () => {
  assert.equal(detect1014('error code: 1014'), true);
  assert.equal(detect1014('Error 1014: CNAME Cross-User Banned'), true);
  assert.equal(detect1014('error code: 1016'), false);
});

test('nextProjectName takes max(suffix)+1 with at least two digits', () => {
  assert.equal(nextProjectName('sub-links-share-', ['sub-links-share-06', 'sub-links-share-22']), 'sub-links-share-23');
  assert.equal(nextProjectName('sub-links-share-', ['sub-nodes-05', 'sub-links-share-09']), 'sub-links-share-10');
  assert.equal(nextProjectName('sub-links-share-', []), 'sub-links-share-01');
  assert.equal(nextProjectName('sub-links-share-', ['sub-links-share-99']), 'sub-links-share-100');
});
