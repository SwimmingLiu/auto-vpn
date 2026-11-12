import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function git(args) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
}

const workTree = git(['rev-parse', '--is-inside-work-tree']);
const skip = workTree.status === 0 && workTree.stdout.trim() === 'true' ? false : 'not a git work tree';

test('dependency directories are ignored as paths, not only as directories', { skip }, () => {
  // A worktree that shares the dependencies of another checkout links
  // `node_modules` instead of copying it. A pattern with a trailing slash
  // matches directories alone, so the link stayed unignored and was once
  // committed as a 120000 entry carrying an absolute path from that machine.
  const result = git(['check-ignore', '--no-index', '-v', 'npm/autovpn-cli/node_modules']);

  assert.equal(result.status, 0, `node_modules must be ignored as a path too: ${result.stderr}`);
  assert.match(result.stdout.trim(), /^\.gitignore:\d+:node_modules\tnpm\/autovpn-cli\/node_modules$/);
});

test('no dependency tree, build output, or link is committed', { skip }, () => {
  const result = git(['ls-files', '-s']);
  assert.equal(result.status, 0, result.stderr);

  const offenders = result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [meta, ...rest] = line.split('\t');
      return { mode: meta.split(' ')[0], file: rest.join('\t') };
    })
    .filter((entry) => entry.mode === '120000' || /(^|\/)(node_modules|dist|dist-electron)(\/|$)/.test(entry.file));

  assert.deepEqual(offenders, [], 'dependency trees, build output and links are never source');
});
