import os from 'node:os';
import path from 'node:path';

export function getCacheDir(env = process.env) {
  const override = String(env.AUTOVPN_CACHE_DIR ?? '').trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.cache', 'autovpn', 'npm-wrapper');
}

export function pythonBinName(platform = process.platform) {
  return platform === 'win32' ? 'Scripts' : 'bin';
}
