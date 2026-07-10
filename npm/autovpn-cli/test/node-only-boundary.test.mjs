import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(cliRoot, '..', '..');
const activeRoots = [
  path.join(repoRoot, 'src'),
  path.join(repoRoot, 'scripts'),
  path.join(cliRoot, 'src'),
  path.join(cliRoot, 'lib')
];
const manifests = [
  path.join(repoRoot, 'package.json'),
  path.join(repoRoot, 'pyproject.toml'),
  path.join(cliRoot, 'package.json')
];
const excludedFiles = new Set([
  path.join(repoRoot, 'scripts', 'generate-release-notes.mjs')
]);
const forbidden = [
  /vpn_automation/,
  /pythonCommandFor/,
  /resolvePythonCli/,
  /PYTHON_[A-Z_]*HELPER/,
  /python-backend/,
  /install-python-cli/,
  /\b(?:pytest|pipx?|wheel|PyPI)\b/i,
  /pyproject\.toml/
];

function walk(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

test('active runtime and package surfaces are Node-only', () => {
  const files = [...activeRoots.flatMap(walk), ...manifests.filter(fs.existsSync)]
    .filter((file) => !excludedFiles.has(file));
  const violations = [];
  for (const file of files) {
    const relative = path.relative(repoRoot, file);
    const content = fs.readFileSync(file, 'utf8');
    if (relative.startsWith('src/vpn_automation/')) {
      violations.push(relative);
      continue;
    }
    for (const pattern of forbidden) {
      if (pattern.test(content) || pattern.test(relative)) {
        violations.push(`${relative}: ${pattern}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
