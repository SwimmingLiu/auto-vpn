import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  buildMinifyCommand,
  buildObfuscateCommand,
  obfuscateBundle,
  MINIFY_FLAGS,
  OBFUSCATOR_VERSION,
  WORKER_OBFUSCATOR_FLAGS
} from '../../dist/pipeline/bundle-obfuscator.js';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const cliRoot = path.join(repoRoot, 'npm', 'autovpn-cli');
const templatePath = path.join(repoRoot, 'templates', 'share-worker', 'vpn.js');

async function hasTool(command, args) {
  try {
    await run(command, args, { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

test('the obfuscator flags are the historical Python pipeline flags', () => {
  // A diff against `build_obfuscate_command` in the deleted node_tools.py and
  // the edgetunnel `obfuscator_vpn.yml` must stay empty: the uploaded bundle is
  // obfuscated exactly the way it was before the Node migration.
  assert.deepEqual([...WORKER_OBFUSCATOR_FLAGS], [
    '--compact', 'true',
    '--control-flow-flattening', 'true',
    '--control-flow-flattening-threshold', '1',
    '--dead-code-injection', 'true',
    '--dead-code-injection-threshold', '1',
    '--identifier-names-generator', 'hexadecimal',
    '--rename-globals', 'true',
    '--string-array', 'true',
    '--string-array-encoding', 'rc4',
    '--string-array-threshold', '1',
    '--transform-object-keys', 'true',
    '--unicode-escape-sequence', 'true'
  ]);
  assert.equal(OBFUSCATOR_VERSION, '5.4.3');
});

test('the minify step runs before the obfuscate step', () => {
  const minify = buildMinifyCommand('/bin/esbuild', 'in.js', 'min.js');
  const obfuscate = buildObfuscateCommand('/bin/obfuscator', 'min.js', 'out.js');
  assert.deepEqual(minify, ['/bin/esbuild', 'in.js', ...MINIFY_FLAGS, '--outfile=min.js']);
  // The obfuscator's input is the minifier's output, never the raw source.
  assert.equal(minify[minify.length - 1], '--outfile=min.js');
  assert.equal(obfuscate[1], 'min.js');
});

test('a missing esbuild fails closed instead of returning the plain source', async () => {
  // No local copy and no managed install: the resolver throws, which must
  // surface as a build failure rather than an upload of readable source. The
  // stub resolver is what makes this hermetic.
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'no-esbuild-'));
  await assert.rejects(
    () => obfuscateBundle('export default {};', {
      projectRoot: emptyRoot,
      deps: {
        env: {},
        resolveTool: async () => { throw new Error('not installed'); }
      }
    }),
    /esbuild was not found/
  );
});

test('a failed obfuscate run fails closed', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'fake-tools-'));
  const esbuild = path.join(projectRoot, 'esbuild');
  await writeFile(esbuild, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await assert.rejects(
    () => obfuscateBundle('export default {};', {
      projectRoot,
      deps: {
        env: { WORKER_ESBUILD_BIN: esbuild },
        resolveTool: async () => ({ command: '/bin/exit-1-missing-tool', args: [], source: 'managed', packageName: 'javascript-obfuscator', version: '5.4.3' })
      }
    }),
    /ESRCH|ENOENT|worker obfuscate failed/
  );
});

test('the shipped template obfuscates to a bundle with no readable structure', async (t) => {
  const esbuild = path.join(cliRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  if (!(await hasTool(esbuild, ['--version']))) {
    t.diagnostic('esbuild is not installed; skipping the end-to-end obfuscation check');
    return;
  }
  let obfuscator = '';
  try {
    const resolved = await import('../../dist/runtime/managed-tools.js').then((module) => module.resolveManagedNpmTool({
      packageName: 'javascript-obfuscator',
      binaryName: 'javascript-obfuscator',
      version: OBFUSCATOR_VERSION,
      projectRoot: repoRoot,
      installMissing: false
    }));
    obfuscator = resolved.command;
  } catch (error) {
    t.diagnostic(`javascript-obfuscator is not installed (${error?.message ?? error}); skipping`);
    return;
  }

  const source = await readFile(templatePath, 'utf8');
  const result = await obfuscateBundle(source, { projectRoot: repoRoot });

  // The decoy comment corpus is 8x the code; minification must drop it.
  assert.ok(result.minifiedBytes < source.length / 4, `minified ${result.minifiedBytes} vs source ${source.length}`);
  // Obfuscation adds the string-array and control-flow machinery back.
  assert.ok(result.obfuscatedBytes > result.minifiedBytes);

  const bundle = result.source;
  // No identifier or literal from the source may survive in readable form.
  for (const needle of ['edgetunnel', 'STATIC_EXIT', '订阅TOKEN', 'clash-verge', '静默', '静态出口']) {
    assert.ok(!bundle.includes(needle), `"${needle}" must not survive obfuscation`);
  }
  // Comments, including the Hebrew decoy corpus, must be gone.
  assert.ok(!bundle.includes('בראשית'), 'the decoy corpus must not be uploaded');
  assert.ok(!/^\s*\/\//m.test(bundle.split('\n')[0] ?? ''), 'the bundle must not open with a comment');

  // It must still be a module the runtime can parse.
  assert.match(bundle, /export\s*\{|export default/);
  assert.ok(bundle.length > 100_000, `bundle is ${bundle.length} bytes`);
  t.diagnostic(`minified ${result.minifiedBytes} B -> obfuscated ${result.obfuscatedBytes} B (source ${source.length} B)`);
});
