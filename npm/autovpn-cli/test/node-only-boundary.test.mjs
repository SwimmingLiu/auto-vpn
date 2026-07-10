import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(cliRoot, '..', '..');
const activeRoots = [
  path.join(repoRoot, 'electron', 'lib'),
  path.join(repoRoot, 'electron', 'build'),
  path.join(repoRoot, 'scripts'),
  path.join(cliRoot, 'src'),
  path.join(cliRoot, 'lib'),
  path.join(cliRoot, 'bin'),
  path.join(cliRoot, 'scripts')
];
const manifests = [
  path.join(repoRoot, 'package.json'),
  path.join(cliRoot, 'package.json'),
  path.join(repoRoot, '.github', 'workflows', 'headless-cli.yml'),
  path.join(repoRoot, '.github', 'workflows', 'release-electron.yml'),
  path.join(repoRoot, 'README.md'),
  path.join(cliRoot, 'README.md'),
  ...[
    'README.md',
    'agent-skill.md',
    'headless-cli.md',
    'job-manager.md',
    'linux-delivery.md',
    'linux-headless-guide.md'
  ].map((file) => path.join(repoRoot, 'docs', 'headless-agent', file)),
  ...[
    'node-first-contract.md',
    'node-first-event-schema.md',
    'node-first-migration-sop.md'
  ].map((file) => path.join(repoRoot, 'docs', 'npm-cli', file))
];
const excludedFiles = new Set();
const forbidden = [
  /vpn_automation/,
  /pythonCommandFor/,
  /resolvePythonCli/,
  /PYTHON_[A-Z_]*HELPER/,
  /python-backend/,
  /install-python-cli/,
  /AUTOVPN_PYTHON_CLI/,
  /AUTOVPN_NO_PYTHON/,
  /AUTOVPN_CLI_SHELL/,
  /AUTOVPN_(?:PIPELINE|STAGE|DOCTOR|PROFILE|ARTIFACTS|JOBS)_[A-Z0-9_]*BACKEND/,
  /\bpython(?:Command|Bin|Cli|Backend|Helper|Runtime|Vendor)[A-Z0-9_]*\b/i,
  /(?:spawn|execFile|execFileSync|spawnSync)[\s\S]{0,120}\bpython(?:3(?:\.\d+)?)?\b/i,
  /\b(?:pytest|pipx?|wheel|PyPI)\b/i,
  /\b(?:twine|sdist)\b/i,
  /setup-python/i,
  /python-vendor/i,
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
    for (const pattern of forbidden) {
      if (pattern.test(content) || pattern.test(relative)) {
        violations.push(`${relative}: ${pattern}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
