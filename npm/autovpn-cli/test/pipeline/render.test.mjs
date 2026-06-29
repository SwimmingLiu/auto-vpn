import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAIN_DATA_PLACEHOLDER, renderMainDataWithBackend, replaceMainData, selectPipelineStageBackend } from '../../dist/pipeline/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'node-migration', 'pipeline', 'render');

test('replaceMainData replaces exactly one placeholder with newline-joined links', () => {
  const template = `const MainData = \`${MAIN_DATA_PLACEHOLDER}\`;\nconst footer = 'keep';`;

  assert.equal(
    replaceMainData(template, ['vmess://a', 'vmess://b']),
    "const MainData = `vmess://a\nvmess://b`;\nconst footer = 'keep';"
  );
});

test('replaceMainData rejects templates without exactly one placeholder', () => {
  assert.throws(() => replaceMainData('const MainData = ``;', ['vmess://a']), /exactly one MainData placeholder/);
  assert.throws(
    () => replaceMainData(`${MAIN_DATA_PLACEHOLDER}\n${MAIN_DATA_PLACEHOLDER}`, ['vmess://a']),
    /exactly one MainData placeholder/
  );
});

test('render fixture output matches Python golden output', async () => {
  const input = JSON.parse(await readFile(path.join(fixtureDir, 'input.json'), 'utf8'));
  const expected = await readFile(path.join(fixtureDir, 'output.txt'), 'utf8');

  assert.equal(replaceMainData(input.template, input.links), expected);
});

test('render backend selection supports Node default and Python rollback flags', async () => {
  assert.equal(selectPipelineStageBackend('render', {}), 'node');
  assert.equal(selectPipelineStageBackend('render', { AUTOVPN_PIPELINE_BACKEND: ' HYBRID ' }), 'node');
  assert.equal(selectPipelineStageBackend('render', { AUTOVPN_PIPELINE_BACKEND: ' PYTHON ' }), 'python');
  assert.equal(selectPipelineStageBackend('render', { AUTOVPN_STAGE_BACKEND_RENDER: ' python ' }), 'python');
  assert.equal(selectPipelineStageBackend('render', { AUTOVPN_PIPELINE_BACKEND: 'python', AUTOVPN_STAGE_BACKEND_RENDER: '' }), 'python');

  const pythonCalls = [];
  const fallback = async (input) => {
    pythonCalls.push(input);
    return { rendered_source: 'python-result' };
  };

  const input = { template: `${MAIN_DATA_PLACEHOLDER}`, links: ['vmess://a'] };
  assert.deepEqual(await renderMainDataWithBackend(input, { env: {}, pythonRender: fallback }), { rendered_source: 'vmess://a' });
  assert.deepEqual(await renderMainDataWithBackend(input, {
    env: { AUTOVPN_STAGE_BACKEND_RENDER: 'python' },
    pythonRender: fallback
  }), { rendered_source: 'python-result' });
  assert.deepEqual(pythonCalls, [input]);
});

test('Python render rollback adapter invokes backend venv Python when no callback is injected', async () => {
  const spawns = [];
  const input = { template: `const MainData = \`${MAIN_DATA_PLACEHOLDER}\`;`, links: ['vmess://a'] };
  const result = await renderMainDataWithBackend(input, {
    env: { AUTOVPN_STAGE_BACKEND_RENDER: 'python' },
    resolvePythonCli: () => ({ command: '/opt/autovpn/.venv/bin/autovpn', args: [] }),
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write(chunk) {
          this.input = String(chunk);
        },
        end() {
          const helperInput = JSON.parse(this.input);
          child.stdout.emit('data', `${JSON.stringify({ rendered_source: helperInput.template.replace(MAIN_DATA_PLACEHOLDER, helperInput.links.join('\\n')) })}\n`);
          child.emit('close', 0, null);
        }
      };
      return child;
    }
  });

  assert.deepEqual(result, { rendered_source: 'const MainData = `vmess://a`;' });
  assert.equal(spawns[0].command, '/opt/autovpn/.venv/bin/python');
  assert.equal(spawns[0].args[0], '-c');
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('Python render rollback adapter merges project .env into spawn environment', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'autovpn-render-env-'));
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, '.env'), 'EXTRA_FROM_DOTENV=1\nPATH=/from-dotenv\n', 'utf8');
  const spawns = [];
  const input = { template: `const MainData = \`${MAIN_DATA_PLACEHOLDER}\`;`, links: ['vmess://a'] };
  await renderMainDataWithBackend(input, {
    cwd: projectRoot,
    env: { AUTOVPN_STAGE_BACKEND_RENDER: 'python', PATH: '/explicit-path' },
    resolvePythonCli: () => ({ command: '/opt/autovpn/.venv/bin/autovpn', args: [] }),
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write(chunk) {
          this.input = String(chunk);
        },
        end() {
          child.stdout.emit('data', '{"rendered_source":"ok"}\n');
          child.emit('close', 0, null);
        }
      };
      return child;
    }
  });

  assert.equal(spawns[0].options.env.EXTRA_FROM_DOTENV, '1');
  assert.equal(spawns[0].options.env.PATH, '/explicit-path');
});
