import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  deployPagesWithBackend,
  isVerifySuccess,
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
