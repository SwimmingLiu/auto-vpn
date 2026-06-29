import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildCustomDomainRootUrl,
  buildCustomDomainSubscriptionUrl,
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
  resolveCloudflareCredentials,
  resolveLatestExistingProjectName,
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
});
