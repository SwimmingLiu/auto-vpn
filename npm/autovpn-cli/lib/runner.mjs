import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  spawn as defaultSpawn,
  spawnSync as defaultSpawnSync
} from 'node:child_process';

import { isEnabled, WrapperError } from './errors.mjs';
import { installPythonCli } from './install-python-cli.mjs';

const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

export function readPackageVersion() {
  const payload = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  return String(payload.version);
}

function normalizeVersionOutput(stdout) {
  return String(stdout ?? '').trim();
}

export function versionMatches(stdout, packageVersion) {
  return normalizeVersionOutput(stdout) === `autovpn ${packageVersion}`;
}

export function resolvePythonCli({
  env = process.env,
  packageVersion = readPackageVersion(),
  spawnSync = defaultSpawnSync
} = {}) {
  if (isEnabled(env.AUTOVPN_NO_PYTHON)) {
    throw new WrapperError('Python backend is disabled by AUTOVPN_NO_PYTHON.');
  }

  const explicit = String(env.AUTOVPN_PYTHON_CLI ?? '').trim();
  if (explicit) {
    return { command: explicit, args: [], source: 'AUTOVPN_PYTHON_CLI' };
  }

  const probe = spawnSync('autovpn', ['--version'], {
    encoding: 'utf-8',
    env: { ...env, AUTOVPN_WRAPPER_PROBE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (probe.status === 0) {
    if (versionMatches(probe.stdout, packageVersion) || isEnabled(env.AUTOVPN_ALLOW_VERSION_MISMATCH)) {
      return { command: 'autovpn', args: [], source: 'PATH' };
    }
  }

  throw new WrapperError(
    `No compatible Python autovpn CLI found for version ${packageVersion}. Set AUTOVPN_PYTHON_CLI or allow the wrapper to install the backend.`
  );
}

export function resolveOrInstallPythonCli({
  env = process.env,
  packageVersion = readPackageVersion(),
  spawnSync = defaultSpawnSync,
  installer = installPythonCli
} = {}) {
  try {
    return resolvePythonCli({ env, packageVersion, spawnSync });
  } catch (error) {
    if (isEnabled(env.AUTOVPN_NO_PYTHON)) {
      throw error;
    }
    return installer({ env, packageVersion, spawnSync });
  }
}

export function runForwarder(argv = process.argv.slice(2), {
  env = process.env,
  cwd = process.cwd(),
  packageVersion = readPackageVersion(),
  spawn = defaultSpawn,
  spawnSync = defaultSpawnSync,
  installer = installPythonCli
} = {}) {
  const resolved = resolveOrInstallPythonCli({ env, packageVersion, spawnSync, installer });
  const child = spawn(resolved.command, [...resolved.args, ...argv], {
    cwd,
    env,
    stdio: 'inherit'
  });

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const env = options.env ?? process.env;
  if (isEnabled(env.AUTOVPN_WRAPPER_PROBE) && argv.length === 1 && argv[0] === '--version') {
    return 42;
  }

  try {
    return await runForwarder(argv, { ...options, env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`autovpn npm wrapper error: ${message}`);
    return 1;
  }
}
