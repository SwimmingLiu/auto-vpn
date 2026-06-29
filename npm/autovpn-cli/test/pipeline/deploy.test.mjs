import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildCustomDomainRootUrl,
  buildCustomDomainSubscriptionUrl,
  buildNoopCleanupBlockedProjectResult,
  buildPagesDeployCommand,
  buildPagesProjectRootUrl,
  buildSecretUrl,
  buildWranglerAuthEnv,
  deployPagesWithBackend,
  deriveCustomDomainDnsTarget,
  deriveFallbackProjectBaseName,
  derivePagesProjectUrl,
  generateFallbackProjectName,
  isVerifySuccess,
  mergeDeployVerificationTarget,
  resolveCloudflareCredentials,
  resolveCleanupBlockedProjectCandidates,
  resolveCustomDomainVerifySubscriptionUrl,
  resolveLatestExistingProjectName,
  resolveVerifySubscriptionUrl,
  rewriteUrlHost,
  selectPipelineStageBackend,
  verifyDeploymentWithBackend
} from '../../dist/pipeline/deploy.js';

function fakeChild(stdoutPayload = '{}') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(chunk) {
      this.input = String(chunk);
    },
    end() {
      JSON.parse(this.input);
      child.stdout.emit('data', `${stdoutPayload}\n`);
      child.emit('close', 0, null);
    }
  };
  return child;
}

test('Cloudflare URL helpers match Python deploy semantics', () => {
  const deploy = {
    pages_project_url: 'https://sub-nodes.pages.dev/',
    secret_query: 'test_key=fake-secret',
    subscription_url: 'https://origin.example/sub?token=abc',
    verify_subscription_url: 'https://verify.example/sub?token=abc',
    custom_domain: 'vpn.example.com/'
  };

  assert.deepEqual(buildPagesDeployCommand('/tmp/bundle', 'sub-nodes'), [
    'npx', 'wrangler', 'pages', 'deploy', '/tmp/bundle', '--project-name', 'sub-nodes', '--branch', 'main'
  ]);
  assert.equal(derivePagesProjectUrl('sub-nodes'), 'https://sub-nodes.pages.dev');
  assert.equal(buildSecretUrl(deploy), 'https://sub-nodes.pages.dev/?test_key=fake-secret');
  assert.equal(buildPagesProjectRootUrl(deploy), 'https://sub-nodes.pages.dev');
  assert.equal(buildCustomDomainRootUrl(deploy), 'https://vpn.example.com');
  assert.equal(rewriteUrlHost('https://verify.example/sub?token=abc#hash', 'vpn.example.com'), 'https://vpn.example.com/sub?token=abc#hash');
  assert.equal(rewriteUrlHost('not a url', 'vpn.example.com'), '');
  assert.equal(buildCustomDomainSubscriptionUrl(deploy), 'https://vpn.example.com/sub?token=abc');
  assert.equal(buildCustomDomainSubscriptionUrl({ ...deploy, verify_subscription_url: '' }), 'https://vpn.example.com/sub?token=abc');
  assert.equal(buildCustomDomainSubscriptionUrl({ ...deploy, custom_domain: '' }), '');
  assert.equal(buildCustomDomainRootUrl({ custom_domain: false }), '');
  assert.equal(buildCustomDomainSubscriptionUrl({ ...deploy, custom_domain: false }), '');
  assert.equal(deriveCustomDomainDnsTarget(deploy), 'sub-nodes.pages.dev');
});

test('verify URL helpers match Python deploy target semantics', () => {
  const deploy = {
    subscription_url: ' https://origin.example/sub?token=abc ',
    verify_subscription_url: ' https://verify.example/sub?token=abc ',
    custom_domain: 'vpn.example.com'
  };

  assert.equal(resolveVerifySubscriptionUrl(deploy), 'https://verify.example/sub?token=abc');
  assert.equal(resolveVerifySubscriptionUrl({ ...deploy, verify_subscription_url: '' }), 'https://origin.example/sub?token=abc');
  assert.equal(resolveCustomDomainVerifySubscriptionUrl(deploy), 'https://vpn.example.com/sub?token=abc');
  assert.equal(resolveCustomDomainVerifySubscriptionUrl({ ...deploy, custom_domain: '' }), '');
});

test('verify target merge updates only deploy identity keys', () => {
  const deploy = {
    project_name: 'old-project',
    pages_project_url: 'https://old.pages.dev',
    custom_domain: 'old.example.com',
    secret_query: 'test_key=fake-secret'
  };
  const deployment = {
    project_name: 'new-project',
    pages_project_url: 'https://new.pages.dev',
    custom_domain: 'new.example.com',
    stdout: 'contains deployment logs'
  };

  assert.deepEqual(mergeDeployVerificationTarget(deploy, deployment), {
    project_name: 'new-project',
    pages_project_url: 'https://new.pages.dev',
    custom_domain: 'new.example.com',
    secret_query: 'test_key=fake-secret'
  });
  assert.equal(mergeDeployVerificationTarget(deploy, { project_name: '' }).project_name, '');
});

test('cleanup blocked project helpers expose deterministic Python decision logic', () => {
  const deploy = { project_name: ' sub-nodes-02 ' };

  assert.deepEqual(resolveCleanupBlockedProjectCandidates(deploy, {
    cleanup_blocked_project: 'sub-nodes-01',
    share_project_cleanup_blocked_project: ' sub-nodes-01 '
  }), ['sub-nodes-01']);
  assert.deepEqual(resolveCleanupBlockedProjectCandidates(deploy, {
    cleanup_blocked_project: 'sub-nodes-02',
    share_project_cleanup_blocked_project: ''
  }), []);
  assert.deepEqual(buildNoopCleanupBlockedProjectResult({
    cleanup_errors: ['existing cleanup error']
  }), {
    cleanup_deleted: false,
    cleanup_errors: ['existing cleanup error']
  });
  assert.deepEqual(buildNoopCleanupBlockedProjectResult({}), {
    cleanup_deleted: false,
    cleanup_errors: []
  });
});

test('Cloudflare fallback project naming matches Python suffix behavior', () => {
  assert.equal(deriveFallbackProjectBaseName('', 'sub-nodes-04'), 'sub-nodes');
  assert.equal(deriveFallbackProjectBaseName('custom-prefix', 'sub-nodes-04'), 'custom-prefix');
  assert.equal(deriveFallbackProjectBaseName('', 'sub-nodes'), 'sub-nodes');

  assert.deepEqual(generateFallbackProjectName('sub-nodes', new Set(['sub-nodes', 'sub-nodes-02', 'sub-nodes-04']), {
    currentProjectName: 'sub-nodes-03',
    lastUsedSuffix: 5
  }), { projectName: 'sub-nodes-06', suffix: 6 });
  assert.deepEqual(generateFallbackProjectName('sub-nodes', new Set(['sub-nodes-09']), {}), { projectName: 'sub-nodes-10', suffix: 10 });
  assert.deepEqual(generateFallbackProjectName('sub-nodes', ['sub-nodes-02'], { lastUsedSuffix: '12abc' }), { projectName: 'sub-nodes-03', suffix: 3 });
  assert.deepEqual(generateFallbackProjectName('sub-nodes', (function* () { yield 'sub-nodes-02'; })(), {}), { projectName: 'sub-nodes-03', suffix: 3 });
  assert.throws(() => generateFallbackProjectName('', new Set()), /Fallback project base name is empty/);

  assert.equal(resolveLatestExistingProjectName('sub-nodes', new Set(['sub-nodes-02', 'sub-nodes-10', 'other-99'])), 'sub-nodes-10');
  assert.equal(resolveLatestExistingProjectName('sub-nodes', new Set(['sub-nodes', 'sub-nodes-10'])), 'sub-nodes');
  assert.equal(resolveLatestExistingProjectName('', new Set(['sub-nodes'])), '');
});

test('Cloudflare credential and Wrangler env helpers match Python precedence', () => {
  const tokenCredentials = resolveCloudflareCredentials({
    cloudflare_auth_mode: 'api_token',
    cloudflare_api_token: '',
    account_id: ''
  }, {
    CLOUDFLARE_API_TOKEN: 'runtime-token',
    CLOUDFLARE_ACCOUNT_ID: 'runtime-account'
  });

  assert.deepEqual(tokenCredentials, {
    auth_mode: 'api_token',
    api_token: 'runtime-token',
    account_id: 'runtime-account',
    email: '',
    global_api_key: ''
  });
  assert.equal(resolveCloudflareCredentials({
    cloudflare_api_token: 'profile-token'
  }, { CLOUDFLARE_API_TOKEN: 'runtime-token' }).api_token, 'profile-token');
  assert.equal(resolveCloudflareCredentials({
    cloudflare_api_token: false
  }, { CLOUDFLARE_API_TOKEN: 'runtime-token' }).api_token, 'runtime-token');
  assert.equal(resolveCloudflareCredentials({}, {}, { explicitApiToken: 'explicit-token' }).api_token, 'explicit-token');
  assert.throws(() => resolveCloudflareCredentials({}, {}), /Cloudflare API token is missing/);

  const globalCredentials = resolveCloudflareCredentials({
    cloudflare_auth_mode: 'global_key',
    cloudflare_email: '',
    cloudflare_global_key: '',
    account_id: 'profile-account'
  }, {
    CLOUDFLARE_EMAIL: 'user@example.com',
    CLOUDFLARE_API_KEY: 'global-key',
    CLOUDFLARE_ACCOUNT_ID: 'runtime-account'
  });

  assert.deepEqual(globalCredentials, {
    auth_mode: 'global_key',
    api_token: '',
    account_id: 'profile-account',
    email: 'user@example.com',
    global_api_key: 'global-key'
  });
  assert.deepEqual(buildWranglerAuthEnv(tokenCredentials), {
    CI: '1',
    CLOUDFLARE_ACCOUNT_ID: 'runtime-account',
    CLOUDFLARE_API_TOKEN: 'runtime-token'
  });
  assert.deepEqual(buildWranglerAuthEnv(globalCredentials), {
    CI: '1',
    CLOUDFLARE_ACCOUNT_ID: 'profile-account',
    CLOUDFLARE_API_KEY: 'global-key',
    CLOUDFLARE_EMAIL: 'user@example.com'
  });
});

test('deploy backend selection requires explicit Python fallback', async () => {
  assert.equal(selectPipelineStageBackend('deploy', {}), 'node');
  assert.equal(selectPipelineStageBackend('deploy', { AUTOVPN_STAGE_BACKEND_DEPLOY: ' python ' }), 'python');
  assert.equal(selectPipelineStageBackend('deploy', { AUTOVPN_PIPELINE_BACKEND: ' python ' }), 'python');

  await assert.rejects(() => deployPagesWithBackend({
    projectRoot: '/repo',
    bundleDir: '/repo/artifacts/pages_bundle',
    deploy: {}
  }, { env: {} }), /Node deploy backend is not available yet/);
});

test('Python deploy fallback invokes backend venv Python when no callback is injected', async () => {
  const spawns = [];
  const result = await deployPagesWithBackend({
    projectRoot: '/repo',
    bundleDir: '/repo/artifacts/pages_bundle',
    deploy: { project_name: 'sub-nodes' }
  }, {
    cwd: '/repo',
    env: { AUTOVPN_STAGE_BACKEND_DEPLOY: 'python' },
    resolvePythonCli: () => ({ command: '/opt/autovpn/.venv/bin/autovpn', args: [] }),
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      return fakeChild('{"returncode":0}');
    }
  });

  assert.deepEqual(result, { returncode: 0 });
  assert.equal(spawns[0].command, '/opt/autovpn/.venv/bin/python');
  assert.equal(spawns[0].args[0], '-c');
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('Python deploy fallback rejects PATH autovpn because interpreter cannot be inferred safely', async () => {
  await assert.rejects(() => deployPagesWithBackend({
    projectRoot: '/repo',
    bundleDir: '/repo/artifacts/pages_bundle',
    deploy: { project_name: 'sub-nodes' }
  }, {
    env: { AUTOVPN_STAGE_BACKEND_DEPLOY: 'python' },
    resolvePythonCli: () => ({ command: 'autovpn', args: [] }),
    spawn: () => fakeChild('{"returncode":0}')
  }), /absolute AUTOVPN_PYTHON_CLI path/);
});

test('Python verify fallback invokes backend venv Python and verify success matches Python semantics', async () => {
  const spawns = [];
  const result = await verifyDeploymentWithBackend({
    projectRoot: '/repo',
    deploy: { project_name: 'sub-nodes' },
    deployment: { returncode: 0 }
  }, {
    cwd: '/repo',
    env: { AUTOVPN_STAGE_BACKEND_VERIFY: 'python' },
    resolvePythonCli: () => ({ command: '/opt/autovpn/.venv/bin/autovpn', args: [] }),
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      return fakeChild('{"secret_ok":true,"subscription_ok":true}');
    }
  });

  assert.deepEqual(result, { secret_ok: true, subscription_ok: true });
  assert.equal(spawns[0].command, '/opt/autovpn/.venv/bin/python');
  assert.equal(isVerifySuccess({ secret_ok: true, subscription_ok: true }), true);
  assert.equal(isVerifySuccess({ pages_domain_ok: false, secret_ok: true, subscription_ok: true }), false);
  assert.equal(isVerifySuccess({ pages_domain_ok: true, secret_ok: true, subscription_ok: false }), false);
  assert.equal(isVerifySuccess({ secret_ok: true, subscription_ok: true, custom_domain_ok: true, custom_domain_subscription_ok: false }), false);
  assert.equal(isVerifySuccess({ secret_ok: true, subscription_ok: true, custom_domain_ok: true, custom_domain_dns_ok: false }), false);
});
