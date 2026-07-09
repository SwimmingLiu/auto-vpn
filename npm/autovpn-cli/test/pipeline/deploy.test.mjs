import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCustomDomainRootUrl,
  buildCustomDomainSubscriptionUrl,
  buildNoopCleanupBlockedProjectResult,
  buildPagesDeployCommand,
  buildPagesProjectRootUrl,
  buildSecretUrl,
  buildWranglerAuthEnv,
  cleanupBlockedPagesProjects,
  CloudflareHttpClient,
  defaultVerifyDeployment,
  deployPagesWithBackend,
  deriveCustomDomainDnsTarget,
  deriveFallbackProjectBaseName,
  derivePagesProjectUrl,
  generateFallbackProjectName,
  isVerifySuccess,
  isBlockedPagesError,
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

async function makeShareProjectRoot() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-share-'));
  const sourceDir = path.join(projectRoot, 'templates', 'share-worker');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, 'vpn.js'), "export default { async fetch() { return new Response('share'); } }", 'utf8');
  return projectRoot;
}

async function resolveTestManagedWrangler() {
  return { command: '/managed/bin/wrangler', args: [], source: 'managed', packageName: 'wrangler', version: '4.106.0' };
}

test('Cloudflare URL helpers match Python deploy semantics', () => {
  const deploy = {
    pages_project_url: 'https://sub-nodes.pages.dev/',
    secret_query: 'test_key=fake-secret',
    subscription_url: 'https://origin.example/sub?token=abc',
    verify_subscription_url: 'https://verify.example/sub?token=abc',
    custom_domain: 'vpn.example.com/'
  };

  assert.deepEqual(buildPagesDeployCommand('/managed/bin/wrangler', '/tmp/bundle', 'sub-nodes'), [
    '/managed/bin/wrangler', 'pages', 'deploy', '/tmp/bundle', '--project-name', 'sub-nodes', '--branch', 'main'
  ]);
  assert.equal(derivePagesProjectUrl('sub-nodes'), 'https://sub-nodes.pages.dev');
  assert.equal(buildSecretUrl(deploy), 'https://sub-nodes.pages.dev/?test_key=fake-secret');
  assert.equal(buildPagesProjectRootUrl(deploy), 'https://sub-nodes.pages.dev');
  assert.equal(buildCustomDomainRootUrl(deploy), 'https://vpn.example.com');
  assert.equal(rewriteUrlHost('https://verify.example/sub?token=abc#hash', 'vpn.example.com'), 'https://vpn.example.com/sub?token=abc#hash');
  assert.equal(rewriteUrlHost('https://user:pass@verify.example:8443/sub?token=abc#hash', 'vpn.example.com'), 'https://vpn.example.com/sub?token=abc#hash');
  assert.equal(rewriteUrlHost('https://verify.example:8443/sub?token=abc#hash', 'vpn.example.com:443'), 'https://vpn.example.com:443/sub?token=abc#hash');
  assert.equal(rewriteUrlHost('not a url', 'vpn.example.com'), '');
  assert.equal(buildCustomDomainSubscriptionUrl(deploy), 'https://vpn.example.com//sub?token=abc');
  assert.equal(buildCustomDomainSubscriptionUrl({ ...deploy, verify_subscription_url: '' }), 'https://vpn.example.com//sub?token=abc');
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

test('deploy backend selection always uses the Node engine', async () => {
  assert.equal(selectPipelineStageBackend('deploy', {}), 'node');
  assert.equal(selectPipelineStageBackend('deploy', { AUTOVPN_STAGE_BACKEND_DEPLOY: ' python ' }), 'node');
  assert.equal(selectPipelineStageBackend('deploy', { AUTOVPN_PIPELINE_BACKEND: ' python ' }), 'node');
});

test('Node deploy backend runs Wrangler and returns Python-compatible base metadata', async () => {
  const calls = [];
  const resolverCalls = [];
  const result = await deployPagesWithBackend({
    projectRoot: '/repo',
    bundleDir: '/repo/artifacts/pages_bundle',
    deploy: {
      project_name: 'sub-nodes',
      pages_project_url: '',
      share_project_name: '',
      cloudflare_api_token: 'token-1',
      account_id: 'account-1',
      fallback_last_used_suffix: 7
    }
  }, {
    env: {},
    resolveManagedNpmTool: async (options) => {
      resolverCalls.push(options);
      return { command: '/managed/bin/wrangler', args: [], source: 'managed', packageName: 'wrangler', version: '4.106.0' };
    },
    runCommand: async (command, options) => {
      calls.push({ command, options });
      return { returncode: 0, stdout: 'deployed', stderr: '' };
    }
  });

  assert.equal(result.returncode, 0);
  assert.deepEqual(resolverCalls, [{
    packageName: 'wrangler',
    binaryName: 'wrangler',
    version: '4.106.0',
    projectRoot: '/repo'
  }]);
  assert.deepEqual(result.command, ['/managed/bin/wrangler', 'pages', 'deploy', '/repo/artifacts/pages_bundle', '--project-name', 'sub-nodes', '--branch', 'main']);
  assert.equal(result.project_name, 'sub-nodes');
  assert.equal(result.pages_project_url, 'https://sub-nodes.pages.dev');
  assert.equal(result.fallback_used, false);
  assert.equal(result.fallback_last_used_suffix, 7);
  assert.equal(result.share_project_sync_ok, true);
  assert.equal(result.bundle_dir, '/repo/artifacts/pages_bundle');
  assert.equal(result.worker_entry, '/repo/artifacts/pages_bundle/_worker.js');
  assert.equal(result.module_manifest_path, '/repo/artifacts/pages_bundle/manifest.json');
  assert.deepEqual(result.attempts, [{ mode: 'direct', returncode: 0 }]);
  assert.equal(calls[0].options.cwd, '/repo/artifacts/pages_bundle');
  assert.equal(calls[0].options.env.CLOUDFLARE_API_TOKEN, 'token-1');
  assert.equal(calls[0].options.env.CLOUDFLARE_ACCOUNT_ID, 'account-1');
});

test('Node deploy backend retries transient failures and uses configured proxy last', async () => {
  const calls = [];
  const results = [
    { returncode: 1, stdout: '', stderr: 'fetch failed UND_ERR_SOCKET' },
    { returncode: 1, stdout: '', stderr: 'fetch failed UND_ERR_SOCKET' },
    { returncode: 0, stdout: 'ok', stderr: '' }
  ];
  const result = await deployPagesWithBackend({
    projectRoot: '/repo',
    bundleDir: '/repo/artifacts/pages_bundle',
    deploy: { project_name: 'sub-nodes', share_project_name: '', cloudflare_api_token: 'token-1' }
  }, {
    env: { VPN_AUTOMATION_DEPLOY_PROXY: 'http://127.0.0.1:7897' },
    resolveManagedNpmTool: resolveTestManagedWrangler,
    runCommand: async (_command, options) => {
      calls.push(options);
      return results.shift();
    }
  });

  assert.equal(result.returncode, 0);
  assert.deepEqual(result.attempts, [
    { mode: 'direct', returncode: 1 },
    { mode: 'direct-retry', returncode: 1 },
    { mode: 'proxy', returncode: 0 }
  ]);
  assert.equal(calls[0].env.HTTP_PROXY, undefined);
  assert.equal(calls[1].env.HTTP_PROXY, undefined);
  assert.equal(calls[2].env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(calls[2].env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(calls[2].env.ALL_PROXY, 'http://127.0.0.1:7897');
});

test('Node deploy backend falls back when primary Pages project is blocked', async () => {
  const calls = [];
  const client = {
    async listPagesProjects() {
      calls.push(['listPagesProjects']);
      return [{ name: 'sub-nodes' }, { name: 'sub-nodes-02' }];
    },
    async createPagesProject(projectName) {
      calls.push(['createPagesProject', projectName]);
      return { name: projectName };
    },
    async copyPagesProjectConfig(sourceProjectName, targetProjectName, runtimeEnv) {
      calls.push(['copyPagesProjectConfig', sourceProjectName, targetProjectName, runtimeEnv.VPN_AUTOMATION_DEFAULT_PAGES_SECRET_ADMIN]);
      return { name: targetProjectName };
    },
    async verifyUrl() { return true; },
    async verifySubdomainCname() { return true; },
    async deletePagesProject() { return {}; }
  };
  const deployResults = [
    {
      returncode: 1,
      stdout: '',
      stderr: 'Your Pages project has been blocked. Contact abusereply@cloudflare.com. [code: 8000119]'
    },
    { returncode: 0, stdout: 'fallback deployed', stderr: '' }
  ];
  const result = await deployPagesWithBackend({
    projectRoot: '/repo',
    bundleDir: '/repo/artifacts/pages_bundle',
    deploy: {
      project_name: 'sub-nodes',
      share_project_name: '',
      cloudflare_api_token: 'token-1',
      fallback_last_used_suffix: 1,
      pages_secret_admin: 'admin-secret'
    }
  }, {
    env: {},
    resolveManagedNpmTool: resolveTestManagedWrangler,
    cloudflareDeployClient: client,
    runCommand: async () => deployResults.shift()
  });

  assert.equal(result.returncode, 0);
  assert.equal(result.project_name, 'sub-nodes-03');
  assert.equal(result.pages_project_url, 'https://sub-nodes-03.pages.dev');
  assert.equal(result.cleanup_blocked_project, 'sub-nodes');
  assert.equal(result.fallback_used, true);
  assert.equal(result.fallback_last_used_suffix, 3);
  assert.deepEqual(result.fallback_candidate_names, ['sub-nodes-03']);
  assert.deepEqual(result.attempts, [
    { mode: 'direct', returncode: 1 },
    { mode: 'fallback-direct', returncode: 0 }
  ]);
  assert.deepEqual(calls, [
    ['listPagesProjects'],
    ['createPagesProject', 'sub-nodes-03'],
    ['copyPagesProjectConfig', 'sub-nodes', 'sub-nodes-03', 'admin-secret']
  ]);
});

test('Node deploy backend binds custom domain and upserts DNS after successful deploy', async () => {
  const calls = [];
  const client = {
    async listPagesDomains(projectName) {
      calls.push(['listPagesDomains', projectName]);
      return [];
    },
    async attachCustomDomain(projectName, domain) {
      calls.push(['attachCustomDomain', projectName, domain]);
      return { name: domain };
    },
    async detachCustomDomain(projectName, domain) {
      calls.push(['detachCustomDomain', projectName, domain]);
      return { success: true };
    },
    async upsertSubdomainCname(hostname, target, proxied) {
      calls.push(['upsertSubdomainCname', hostname, target, proxied]);
      return { name: hostname, content: target, proxied };
    },
    async listPagesProjects() { return []; },
    async getPagesProject() { return {}; },
    async createPagesProject() { return {}; },
    async updatePagesProject() { return {}; },
    async copyPagesProjectConfig() { return {}; },
    async verifyUrl() { return true; },
    async verifySubdomainCname() { return true; },
    async deletePagesProject() { return {}; }
  };
  const result = await deployPagesWithBackend({
    projectRoot: '/repo',
    bundleDir: '/repo/artifacts/pages_bundle',
    deploy: {
      project_name: 'sub-nodes',
      pages_project_url: 'https://sub-nodes.pages.dev',
      share_project_name: '',
      custom_domain: 'vpn.example.com',
      cloudflare_api_token: 'token-1'
    }
  }, {
    env: {},
    resolveManagedNpmTool: resolveTestManagedWrangler,
    cloudflareDeployClient: client,
    runCommand: async () => ({ returncode: 0, stdout: 'ok', stderr: '' })
  });

  assert.equal(result.returncode, 0);
  assert.equal(result.custom_domain, 'vpn.example.com');
  assert.equal(result.custom_domain_dns_name, 'vpn.example.com');
  assert.equal(result.custom_domain_dns_target, 'sub-nodes.pages.dev');
  assert.equal(result.custom_domain_dns_proxied, false);
  assert.equal(result.custom_domain_dns_ok, true);
  assert.deepEqual(calls, [
    ['listPagesDomains', 'sub-nodes'],
    ['attachCustomDomain', 'sub-nodes', 'vpn.example.com'],
    ['upsertSubdomainCname', 'vpn.example.com', 'sub-nodes.pages.dev', false]
  ]);
});

test('Node deploy backend rebinds custom domain when primary fallback is used', async () => {
  const calls = [];
  let attachAttempts = 0;
  const client = {
    async listPagesProjects() {
      calls.push(['listPagesProjects']);
      return [{ name: 'sub-nodes' }];
    },
    async createPagesProject(projectName) {
      calls.push(['createPagesProject', projectName]);
      return { name: projectName };
    },
    async copyPagesProjectConfig(sourceProjectName, targetProjectName) {
      calls.push(['copyPagesProjectConfig', sourceProjectName, targetProjectName]);
      return { name: targetProjectName };
    },
    async listPagesDomains(projectName) {
      calls.push(['listPagesDomains', projectName]);
      return [];
    },
    async attachCustomDomain(projectName, domain) {
      calls.push(['attachCustomDomain', projectName, domain]);
      attachAttempts += 1;
      if (projectName === 'sub-nodes-01' && attachAttempts === 1) {
        throw new Error('domain already exists on another project');
      }
      return { name: domain };
    },
    async detachCustomDomain(projectName, domain) {
      calls.push(['detachCustomDomain', projectName, domain]);
      return { success: true };
    },
    async upsertSubdomainCname(hostname, target, proxied) {
      calls.push(['upsertSubdomainCname', hostname, target, proxied]);
      return { name: hostname, content: target, proxied };
    },
    async getPagesProject() { return {}; },
    async updatePagesProject() { return {}; },
    async verifyUrl() { return true; },
    async verifySubdomainCname() { return true; },
    async deletePagesProject() { return {}; }
  };
  const deployResults = [
    { returncode: 1, stdout: '', stderr: 'Your Pages project has been blocked. [code: 8000119]' },
    { returncode: 0, stdout: 'fallback ok', stderr: '' }
  ];
  const result = await deployPagesWithBackend({
    projectRoot: '/repo',
    bundleDir: '/repo/artifacts/pages_bundle',
    deploy: {
      project_name: 'sub-nodes',
      share_project_name: '',
      custom_domain: 'vpn.example.com',
      cloudflare_api_token: 'token-1'
    }
  }, {
    env: {},
    resolveManagedNpmTool: resolveTestManagedWrangler,
    cloudflareDeployClient: client,
    runCommand: async () => deployResults.shift()
  });

  assert.equal(result.returncode, 0);
  assert.equal(result.project_name, 'sub-nodes-01');
  assert.equal(result.pages_project_url, 'https://sub-nodes-01.pages.dev');
  assert.equal(result.custom_domain_dns_target, 'sub-nodes-01.pages.dev');
  assert.deepEqual(calls, [
    ['listPagesProjects'],
    ['createPagesProject', 'sub-nodes-01'],
    ['copyPagesProjectConfig', 'sub-nodes', 'sub-nodes-01'],
    ['listPagesDomains', 'sub-nodes-01'],
    ['attachCustomDomain', 'sub-nodes-01', 'vpn.example.com'],
    ['detachCustomDomain', 'sub-nodes', 'vpn.example.com'],
    ['attachCustomDomain', 'sub-nodes-01', 'vpn.example.com'],
    ['upsertSubdomainCname', 'vpn.example.com', 'sub-nodes-01.pages.dev', false]
  ]);
});

test('Node deploy backend fails result when custom domain DNS upsert fails', async () => {
  const client = {
    async listPagesDomains() { return [{ name: 'vpn.example.com' }]; },
    async attachCustomDomain() { throw new Error('unexpected attach'); },
    async detachCustomDomain() { return {}; },
    async upsertSubdomainCname() { throw new Error('Conflicting non-CNAME DNS records exist for vpn.example.com'); },
    async listPagesProjects() { return []; },
    async getPagesProject() { return {}; },
    async createPagesProject() { return {}; },
    async updatePagesProject() { return {}; },
    async copyPagesProjectConfig() { return {}; },
    async verifyUrl() { return true; },
    async verifySubdomainCname() { return true; },
    async deletePagesProject() { return {}; }
  };
  const result = await deployPagesWithBackend({
    projectRoot: '/repo',
    bundleDir: '/repo/artifacts/pages_bundle',
    deploy: {
      project_name: 'sub-nodes',
      pages_project_url: 'https://sub-nodes.pages.dev',
      share_project_name: '',
      custom_domain: 'vpn.example.com',
      cloudflare_api_token: 'token-1'
    }
  }, {
    env: {},
    resolveManagedNpmTool: resolveTestManagedWrangler,
    cloudflareDeployClient: client,
    runCommand: async () => ({ returncode: 0, stdout: 'ok', stderr: '' })
  });

  assert.equal(result.returncode, 1);
  assert.match(result.stderr, /custom domain dns binding failed: Conflicting non-CNAME DNS records/);
  assert.equal(result.custom_domain_dns_ok, false);
});

test('CloudflareHttpClient copies Pages deployment configs with resolved secret values', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/source-project') {
      return new Response(JSON.stringify({
        result: {
          deployment_configs: {
            production: {
              env_vars: {
                ADMIN: { type: 'secret_text' },
                SUB: { type: 'plain_text', value: 'https://old.example/sub' }
              },
              kv_namespaces: [{ binding: 'KV', id: 'kv-1' }],
              compatibility_date: '2026-01-01',
              usage_model: 'bundled'
            }
          }
        }
      }), { status: 200 });
    }
    if (url === 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/target-project') {
      return new Response(JSON.stringify({ result: { name: 'target-project' } }), { status: 200 });
    }
    return new Response('missing', { status: 404 });
  };
  const client = new CloudflareHttpClient({
    auth_mode: 'api_token',
    api_token: 'token-1',
    account_id: 'account-1',
    email: '',
    global_api_key: ''
  }, { fetch: fetchImpl });

  await client.copyPagesProjectConfig('source-project', 'target-project', {
    VPN_AUTOMATION_DEFAULT_PAGES_SECRET_ADMIN: 'admin-secret'
  });

  const patch = requests[1];
  assert.equal(patch.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(patch.options.body), {
    deployment_configs: {
      production: {
        env_vars: {
          ADMIN: { type: 'secret_text', value: 'admin-secret' },
          SUB: { type: 'plain_text', value: 'https://old.example/sub' }
        },
        kv_namespaces: [{ binding: 'KV', id: 'kv-1' }],
        compatibility_date: '2026-01-01',
        usage_model: 'bundled'
      }
    }
  });
});

test('CloudflareHttpClient manages Pages custom domains and DNS CNAME upserts', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/sub-nodes/domains') {
      if ((options.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ result: { name: 'vpn.example.com' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    }
    if (url === 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/sub-nodes/domains/vpn.example.com') {
      return new Response(JSON.stringify({ result: { success: true } }), { status: 200 });
    }
    if (url === 'https://api.cloudflare.com/client/v4/zones?name=example.com') {
      return new Response(JSON.stringify({ result: [{ id: 'zone-1', name: 'example.com' }] }), { status: 200 });
    }
    if (url === 'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records?name=vpn.example.com') {
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    }
    if (url === 'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records') {
      return new Response(JSON.stringify({ result: { id: 'dns-1', name: 'vpn.example.com', content: 'sub-nodes.pages.dev' } }), { status: 200 });
    }
    return new Response('missing', { status: 404 });
  };
  const client = new CloudflareHttpClient({
    auth_mode: 'api_token',
    api_token: 'token-1',
    account_id: 'account-1',
    email: '',
    global_api_key: ''
  }, { fetch: fetchImpl });

  assert.deepEqual(await client.listPagesDomains('sub-nodes'), []);
  await client.attachCustomDomain('sub-nodes', 'vpn.example.com');
  await client.detachCustomDomain('sub-nodes', 'vpn.example.com');
  await client.upsertSubdomainCname('vpn.example.com', 'sub-nodes.pages.dev', false);

  const attach = requests.find((request) => request.options.method === 'POST' && request.url.endsWith('/domains'));
  assert.deepEqual(JSON.parse(attach.options.body), { name: 'vpn.example.com' });
  const dnsCreate = requests.find((request) => request.options.method === 'POST' && request.url.endsWith('/dns_records'));
  assert.deepEqual(JSON.parse(dnsCreate.options.body), {
    type: 'CNAME',
    name: 'vpn.example.com',
    content: 'sub-nodes.pages.dev',
    proxied: false
  });
});

test('CloudflareHttpClient protects DNS CNAME upsert edge cases', async () => {
  const requests = [];
  const recordsByHost = {
    'example.com': [],
    'bad.example.com': [{ id: 'a-1', type: 'A', name: 'bad.example.com', content: '192.0.2.1' }],
    'vpn.example.com': [{ id: 'cname-1', type: 'CNAME', name: 'vpn.example.com', content: 'old.pages.dev', proxied: true }]
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === 'https://api.cloudflare.com/client/v4/zones?name=example.com') {
      return new Response(JSON.stringify({ result: [{ id: 'zone-1', name: 'example.com' }] }), { status: 200 });
    }
    const dnsMatch = url.match(/^https:\/\/api.cloudflare.com\/client\/v4\/zones\/zone-1\/dns_records\?name=(.+)$/);
    if (dnsMatch) {
      return new Response(JSON.stringify({ result: recordsByHost[decodeURIComponent(dnsMatch[1])] ?? [] }), { status: 200 });
    }
    if (url === 'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/cname-1') {
      return new Response(JSON.stringify({ result: { id: 'cname-1', content: 'new.pages.dev', proxied: false } }), { status: 200 });
    }
    return new Response('missing', { status: 404 });
  };
  const client = new CloudflareHttpClient({
    auth_mode: 'api_token',
    api_token: 'token-1',
    account_id: 'account-1',
    email: '',
    global_api_key: ''
  }, { fetch: fetchImpl });

  await assert.rejects(() => client.upsertSubdomainCname('example.com', 'sub-nodes.pages.dev', false), /Apex custom domains/);
  await assert.rejects(() => client.upsertSubdomainCname('bad.example.com', 'sub-nodes.pages.dev', false), /Conflicting non-CNAME DNS records/);
  await client.upsertSubdomainCname('vpn.example.com', 'new.pages.dev', false);
  const patch = requests.find((request) => request.options.method === 'PATCH');
  assert.equal(patch.url, 'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/cname-1');
  assert.deepEqual(JSON.parse(patch.options.body), {
    type: 'CNAME',
    name: 'vpn.example.com',
    content: 'new.pages.dev',
    proxied: false
  });
});

test('Node deploy backend syncs share project SUB to final Pages URL', async () => {
  const projectRoot = await makeShareProjectRoot();
  const calls = [];
  const client = {
    async getPagesProject(projectName) {
      calls.push(['getPagesProject', projectName]);
      assert.equal(projectName, 'sub-links-share-03');
      return {
        name: projectName,
        deployment_configs: {
          preview: { env_vars: { SUB: { type: 'plain_text', value: 'https://old.pages.dev' } } },
          production: { env_vars: { SUB: { type: 'plain_text', value: 'https://old.pages.dev' } } }
        }
      };
    },
    async updatePagesProject(projectName, payload) {
      calls.push(['updatePagesProject', projectName, payload]);
      return { name: projectName };
    },
    async listPagesProjects() { return [{ name: 'sub-links-share-03' }]; },
    async createPagesProject() { throw new Error('unexpected create'); },
    async copyPagesProjectConfig() { throw new Error('unexpected copy'); },
    async verifyUrl() { return true; },
    async verifySubdomainCname() { return true; },
    async deletePagesProject() { return {}; }
  };
  const runCalls = [];
  const result = await deployPagesWithBackend({
    projectRoot,
    bundleDir: path.join(projectRoot, 'artifacts/pages_bundle'),
    deploy: {
      project_name: 'sub-nodes',
      pages_project_url: 'https://sub-nodes.pages.dev',
      subscription_url: 'https://origin.example/sub',
      share_project_name: 'sub-links-share-03',
      cloudflare_api_token: 'token-1'
    }
  }, {
    env: {},
    resolveManagedNpmTool: resolveTestManagedWrangler,
    cloudflareDeployClient: client,
    runCommand: async (command, options) => {
      runCalls.push({ command, options });
      return { returncode: 0, stdout: 'ok', stderr: '' };
    }
  });

  assert.equal(result.returncode, 0);
  assert.equal(result.share_project_sync_ok, true);
  assert.equal(result.share_project_name, 'sub-links-share-03');
  assert.equal(result.share_project_sub_value, 'https://sub-nodes.pages.dev/?serect_key=swimmingliu');
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].command[5], 'sub-nodes');
  assert.equal(runCalls[1].command[5], 'sub-links-share-03');
  assert.ok(runCalls[1].command[3].endsWith('/electron/runtime/share-worker/share_pages_bundle'));
  const update = calls.find((call) => call[0] === 'updatePagesProject');
  assert.equal(update[1], 'sub-links-share-03');
  assert.equal(update[2].deployment_configs.preview.env_vars.SUB.value, 'https://sub-nodes.pages.dev/?serect_key=swimmingliu');
  assert.equal(update[2].deployment_configs.production.env_vars.SUB.value, 'https://sub-nodes.pages.dev/?serect_key=swimmingliu');
  assert.ok(String(result.share_project_worker_entry).endsWith('/share_pages_bundle/_worker.js'));
});

test('Node deploy backend falls back when share project update is blocked', async () => {
  const projectRoot = await makeShareProjectRoot();
  const calls = [];
  const client = {
    async getPagesProject(projectName) {
      calls.push(['getPagesProject', projectName]);
      return {
        name: projectName,
        deployment_configs: {
          preview: { env_vars: { SUB: { type: 'plain_text', value: 'https://old.pages.dev' } } },
          production: { env_vars: { SUB: { type: 'plain_text', value: 'https://old.pages.dev' } } }
        }
      };
    },
    async updatePagesProject(projectName, payload) {
      calls.push(['updatePagesProject', projectName, payload]);
      if (projectName === 'sub-links-share-03') {
        throw new Error('Your Pages project has been blocked. Contact abusereply@cloudflare.com. [code: 8000119]');
      }
      return { name: projectName };
    },
    async listPagesProjects() {
      calls.push(['listPagesProjects']);
      return [{ name: 'sub-links-share-03' }];
    },
    async createPagesProject(projectName) {
      calls.push(['createPagesProject', projectName]);
      return { name: projectName };
    },
    async copyPagesProjectConfig(sourceProjectName, targetProjectName) {
      calls.push(['copyPagesProjectConfig', sourceProjectName, targetProjectName]);
      return { name: targetProjectName };
    },
    async verifyUrl() { return true; },
    async verifySubdomainCname() { return true; },
    async deletePagesProject() { return {}; }
  };
  const runCalls = [];
  const result = await deployPagesWithBackend({
    projectRoot,
    bundleDir: path.join(projectRoot, 'artifacts/pages_bundle'),
    deploy: {
      project_name: 'sub-nodes',
      pages_project_url: 'https://sub-nodes.pages.dev',
      share_project_name: 'sub-links-share-03',
      cloudflare_api_token: 'token-1'
    }
  }, {
    env: {},
    resolveManagedNpmTool: resolveTestManagedWrangler,
    cloudflareDeployClient: client,
    runCommand: async (command, options) => {
      runCalls.push({ command, options });
      return { returncode: 0, stdout: 'ok', stderr: '' };
    }
  });

  assert.equal(result.returncode, 0);
  assert.equal(result.share_project_sync_ok, true);
  assert.equal(result.share_project_name, 'sub-links-share-04');
  assert.equal(result.share_project_fallback_used, true);
  assert.equal(result.share_project_cleanup_blocked_project, 'sub-links-share-03');
  assert.equal(result.share_project_fallback_last_used_suffix, 4);
  assert.deepEqual(result.share_project_fallback_candidate_names, ['sub-links-share-04']);
  assert.deepEqual(result.share_project_redeploy_attempts, [{ mode: 'direct', returncode: 0 }]);
  assert.deepEqual(calls.filter((call) => ['createPagesProject', 'copyPagesProjectConfig'].includes(call[0])), [
    ['createPagesProject', 'sub-links-share-04'],
    ['copyPagesProjectConfig', 'sub-links-share-03', 'sub-links-share-04']
  ]);
  assert.equal(runCalls.at(-1).command[5], 'sub-links-share-04');
});

test('Node deploy backend falls back when share project redeploy is blocked', async () => {
  const projectRoot = await makeShareProjectRoot();
  const calls = [];
  const client = {
    async getPagesProject(projectName) {
      return {
        name: projectName,
        deployment_configs: {
          preview: { env_vars: { SUB: { type: 'plain_text', value: 'https://old.pages.dev' } } },
          production: { env_vars: { SUB: { type: 'plain_text', value: 'https://old.pages.dev' } } }
        }
      };
    },
    async updatePagesProject(projectName, payload) {
      calls.push(['updatePagesProject', projectName, payload]);
      return { name: projectName };
    },
    async listPagesProjects() {
      return [{ name: 'sub-links-share-03' }];
    },
    async listPagesDomains(projectName) {
      calls.push(['listPagesDomains', projectName]);
      if (projectName === 'sub-links-share-03') {
        return [{ name: 'share.example.com' }];
      }
      return [];
    },
    async createPagesProject(projectName) {
      calls.push(['createPagesProject', projectName]);
      return { name: projectName };
    },
    async copyPagesProjectConfig(sourceProjectName, targetProjectName) {
      calls.push(['copyPagesProjectConfig', sourceProjectName, targetProjectName]);
      return { name: targetProjectName };
    },
    async attachCustomDomain(projectName, domain) {
      calls.push(['attachCustomDomain', projectName, domain]);
      return { name: domain };
    },
    async detachCustomDomain(projectName, domain) {
      calls.push(['detachCustomDomain', projectName, domain]);
      return { success: true };
    },
    async upsertSubdomainCname(hostname, target, proxied) {
      calls.push(['upsertSubdomainCname', hostname, target, proxied]);
      return { name: hostname, content: target, proxied };
    },
    async verifyUrl() { return true; },
    async verifySubdomainCname() { return true; },
    async deletePagesProject() { return {}; }
  };
  const deployResults = [
    { returncode: 0, stdout: 'primary ok', stderr: '' },
    {
      returncode: 1,
      stdout: '',
      stderr: 'Your Pages project has been blocked. Contact abusereply@cloudflare.com. [code: 8000119]'
    },
    { returncode: 0, stdout: 'fallback ok', stderr: '' }
  ];
  const runCalls = [];
  const result = await deployPagesWithBackend({
    projectRoot,
    bundleDir: path.join(projectRoot, 'artifacts/pages_bundle'),
    deploy: {
      project_name: 'sub-nodes',
      pages_project_url: 'https://sub-nodes.pages.dev',
      share_project_name: 'sub-links-share-03',
      cloudflare_api_token: 'token-1'
    }
  }, {
    env: {},
    resolveManagedNpmTool: resolveTestManagedWrangler,
    cloudflareDeployClient: client,
    runCommand: async (command) => {
      runCalls.push(command);
      return deployResults.shift();
    }
  });

  assert.equal(result.returncode, 0);
  assert.equal(result.share_project_name, 'sub-links-share-04');
  assert.equal(result.share_project_fallback_used, true);
  assert.equal(result.share_project_cleanup_blocked_project, 'sub-links-share-03');
  assert.equal(result.share_project_fallback_last_used_suffix, 4);
  assert.deepEqual(result.share_project_redeploy_attempts, [{ mode: 'direct', returncode: 0 }]);
  assert.equal(runCalls[1][5], 'sub-links-share-03');
  assert.equal(runCalls[2][5], 'sub-links-share-04');
  assert.deepEqual(calls.filter((call) => ['createPagesProject', 'copyPagesProjectConfig'].includes(call[0])), [
    ['createPagesProject', 'sub-links-share-04'],
    ['copyPagesProjectConfig', 'sub-links-share-03', 'sub-links-share-04']
  ]);
  assert.deepEqual(calls.filter((call) => ['attachCustomDomain', 'upsertSubdomainCname'].includes(call[0])), [
    ['attachCustomDomain', 'sub-links-share-04', 'share.example.com'],
    ['upsertSubdomainCname', 'share.example.com', 'sub-links-share-04.pages.dev', false]
  ]);
});

test('Node deploy backend recovers latest existing share project when requested share project is missing', async () => {
  const projectRoot = await makeShareProjectRoot();
  const client = {
    async getPagesProject(projectName) {
      if (projectName === 'sub-links-share-03') {
        throw new Error('Cloudflare Pages project not found: sub-links-share-03');
      }
      assert.equal(projectName, 'sub-links-share-05');
      return {
        name: projectName,
        deployment_configs: {
          preview: { env_vars: { SUB: { type: 'plain_text', value: 'https://old.pages.dev' } } },
          production: { env_vars: { SUB: { type: 'plain_text', value: 'https://old.pages.dev' } } }
        }
      };
    },
    async listPagesProjects() {
      return [{ name: 'sub-nodes-04' }, { name: 'sub-links-share-05' }];
    },
    async updatePagesProject(projectName, payload) {
      assert.equal(projectName, 'sub-links-share-05');
      assert.equal(payload.deployment_configs.preview.env_vars.SUB.value, 'https://sub-nodes-04.pages.dev/?serect_key=swimmingliu');
      return { name: projectName };
    },
    async createPagesProject() { throw new Error('unexpected create'); },
    async copyPagesProjectConfig() { throw new Error('unexpected copy'); },
    async verifyUrl() { return true; },
    async verifySubdomainCname() { return true; },
    async deletePagesProject() { return {}; }
  };
  const runCalls = [];
  const result = await deployPagesWithBackend({
    projectRoot,
    bundleDir: path.join(projectRoot, 'artifacts/pages_bundle'),
    deploy: {
      project_name: 'sub-nodes-04',
      pages_project_url: 'https://sub-nodes-04.pages.dev',
      share_project_name: 'sub-links-share-03',
      cloudflare_api_token: 'token-1'
    }
  }, {
    env: {},
    resolveManagedNpmTool: resolveTestManagedWrangler,
    cloudflareDeployClient: client,
    runCommand: async (command) => {
      runCalls.push(command);
      return { returncode: 0, stdout: 'ok', stderr: '' };
    }
  });

  assert.equal(result.returncode, 0);
  assert.equal(result.share_project_sync_ok, true);
  assert.equal(result.share_project_requested_name, 'sub-links-share-03');
  assert.equal(result.share_project_name, 'sub-links-share-05');
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[1][5], 'sub-links-share-05');
});

test('Node deploy backend preserves blocked Pages project detection', async () => {
  assert.equal(isBlockedPagesError('', 'Your Pages project has been blocked. [code: 8000119]'), true);
});

test('Node verify backend verifies deployment target and cleans blocked projects', async () => {
  const calls = [];
  const client = {
    async verifyUrl(url) {
      calls.push(['verifyUrl', url]);
      return true;
    },
    async verifySubdomainCname(hostname, target) {
      calls.push(['verifySubdomainCname', hostname, target]);
      return true;
    },
    async deletePagesProject(projectName) {
      calls.push(['deletePagesProject', projectName]);
      return { success: true };
    }
  };

  const result = await verifyDeploymentWithBackend({
    projectRoot: '/repo',
    deploy: {
      project_name: 'sub-nodes',
      pages_project_url: 'https://old.pages.dev',
      subscription_url: 'https://origin.example/sub',
      verify_subscription_url: 'https://verify.example/sub',
      custom_domain: 'vpn.example.com',
      secret_query: 'test_key=fake'
    },
    deployment: {
      project_name: 'sub-nodes-02',
      pages_project_url: 'https://sub-nodes-02.pages.dev',
      cleanup_blocked_project: 'sub-nodes-01'
    }
  }, { env: {}, cloudflareClient: client });

  assert.deepEqual(result, {
    pages_domain_ok: true,
    secret_ok: true,
    subscription_ok: true,
    custom_domain_ok: true,
    custom_domain_subscription_ok: true,
    custom_domain_dns_ok: true,
    cleanup_deleted: true,
    cleanup_errors: []
  });
  assert.deepEqual(calls, [
    ['verifyUrl', 'https://sub-nodes-02.pages.dev'],
    ['verifyUrl', 'https://sub-nodes-02.pages.dev/?test_key=fake'],
    ['verifyUrl', 'https://verify.example/sub'],
    ['verifyUrl', 'https://vpn.example.com'],
    ['verifyUrl', 'https://vpn.example.com/sub'],
    ['verifySubdomainCname', 'vpn.example.com', 'sub-nodes-02.pages.dev'],
    ['deletePagesProject', 'sub-nodes-01']
  ]);
});

test('Node default verify and cleanup helpers preserve Python result semantics', async () => {
  const client = {
    async verifyUrl(url) {
      return !url.includes('custom-sub-fail');
    },
    async verifySubdomainCname() {
      return false;
    },
    async deletePagesProject(projectName) {
      if (projectName === 'blocked-b') {
        throw new Error('delete failed');
      }
      return {};
    }
  };
  const deploy = {
    project_name: 'sub-nodes-02',
    pages_project_url: 'https://sub-nodes-02.pages.dev',
    subscription_url: 'https://origin.example/sub',
    verify_subscription_url: 'https://verify.example/sub',
    custom_domain: 'vpn.example.com',
    secret_query: 'test_key=fake'
  };

  assert.deepEqual(await defaultVerifyDeployment(deploy, client), {
    pages_domain_ok: true,
    secret_ok: true,
    subscription_ok: true,
    custom_domain_ok: true,
    custom_domain_subscription_ok: true,
    custom_domain_dns_ok: false
  });
  assert.deepEqual(await cleanupBlockedPagesProjects(deploy, {
    cleanup_blocked_project: 'blocked-a',
    share_project_cleanup_blocked_project: 'blocked-b'
  }, client), {
    cleanup_deleted: true,
    cleanup_errors: ['delete failed']
  });
});

test('CloudflareHttpClient uses Cloudflare auth headers and verifies DNS records', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === 'https://api.cloudflare.com/client/v4/zones?name=example.com') {
      return new Response(JSON.stringify({ result: [{ id: 'zone-1', name: 'example.com' }] }), { status: 200 });
    }
    if (url === 'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records?name=vpn.example.com') {
      return new Response(JSON.stringify({
        result: [{ type: 'CNAME', name: 'vpn.example.com.', content: 'sub-nodes.pages.dev.' }]
      }), { status: 200 });
    }
    if (url === 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/blocked-project') {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url === 'https://vpn.example.com/sub') {
      return new Response('hello secret fragment', { status: 200 });
    }
    return new Response('missing', { status: 404 });
  };
  const client = new CloudflareHttpClient({
    auth_mode: 'api_token',
    api_token: 'token-1',
    account_id: 'account-1',
    email: '',
    global_api_key: ''
  }, { fetch: fetchImpl });

  assert.equal(await client.verifySubdomainCname('vpn.example.com.', 'sub-nodes.pages.dev'), true);
  assert.equal(await client.verifyUrl('https://vpn.example.com/sub', 'secret fragment'), true);
  await client.deletePagesProject('blocked-project');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer token-1');
  assert.equal(requests[3].options.method, 'DELETE');
  await assert.rejects(() => client.verifyUrl('https://missing.example.com/sub'), /URL verification failed/);
});

test('verify success helper keeps Node deployment semantics', async () => {
  assert.equal(isVerifySuccess({ secret_ok: true, subscription_ok: true }), true);
  assert.equal(isVerifySuccess({ pages_domain_ok: false, secret_ok: true, subscription_ok: true }), false);
  assert.equal(isVerifySuccess({ pages_domain_ok: true, secret_ok: true, subscription_ok: false }), false);
  assert.equal(isVerifySuccess({ secret_ok: true, subscription_ok: true, custom_domain_ok: true, custom_domain_subscription_ok: false }), false);
  assert.equal(isVerifySuccess({ secret_ok: true, subscription_ok: true, custom_domain_ok: true, custom_domain_dns_ok: false }), false);
});
