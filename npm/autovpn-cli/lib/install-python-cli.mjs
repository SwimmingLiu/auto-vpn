import fs from 'node:fs';
import path from 'node:path';
import { spawnSync as defaultSpawnSync } from 'node:child_process';

import { getCacheDir, pythonBinName } from './cache.mjs';
import { isEnabled, WrapperError } from './errors.mjs';

export function buildPipInstallArgs({ env = process.env, packageVersion }) {
  const packageSpec = String(env.AUTOVPN_WHEEL_URL ?? '').trim()
    || `${String(env.AUTOVPN_PYTHON_PACKAGE ?? 'vpn-subscription-automation').trim()}==${packageVersion}`;
  const args = ['-m', 'pip', 'install'];
  if (env.AUTOVPN_PIP_INDEX_URL) {
    args.push('--index-url', String(env.AUTOVPN_PIP_INDEX_URL));
  }
  if (env.AUTOVPN_PIP_EXTRA_INDEX_URL) {
    args.push('--extra-index-url', String(env.AUTOVPN_PIP_EXTRA_INDEX_URL));
  }
  args.push(packageSpec);
  return args;
}

export function installPythonCli({
  env = process.env,
  packageVersion,
  spawnSync = defaultSpawnSync,
  cacheDir = getCacheDir(env),
  platform = process.platform
} = {}) {
  if (isEnabled(env.AUTOVPN_NO_INSTALL)) {
    throw new WrapperError('No compatible Python autovpn CLI found and AUTOVPN_NO_INSTALL is enabled.');
  }
  if (!packageVersion) {
    throw new WrapperError('Cannot install Python AutoVPN backend without an npm package version.');
  }

  const venvDir = path.join(cacheDir, `python-${packageVersion}`);
  const executable = platform === 'win32' ? 'autovpn.exe' : 'autovpn';
  const cliPath = path.join(venvDir, pythonBinName(platform), executable);
  const forceInstall = isEnabled(env.AUTOVPN_FORCE_INSTALL);

  if (!forceInstall && fs.existsSync(cliPath)) {
    return { command: cliPath, args: [], source: 'managed-venv' };
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const pythonCommand = String(env.PYTHON ?? env.PYTHON3 ?? 'python3');
  const venvResult = spawnSync(pythonCommand, ['-m', 'venv', venvDir], { stdio: 'inherit', env });
  if (venvResult.status !== 0) {
    throw new WrapperError(`Failed to create AutoVPN Python backend venv with ${pythonCommand}.`);
  }

  const pythonPath = path.join(venvDir, pythonBinName(platform), platform === 'win32' ? 'python.exe' : 'python');
  const installResult = spawnSync(pythonPath, buildPipInstallArgs({ env, packageVersion }), { stdio: 'inherit', env });
  if (installResult.status !== 0) {
    throw new WrapperError('Failed to install AutoVPN Python backend into the wrapper-managed venv.');
  }

  if (!fs.existsSync(cliPath)) {
    throw new WrapperError(`Installed Python backend did not provide autovpn at ${cliPath}.`);
  }

  return { command: cliPath, args: [], source: 'managed-venv' };
}
