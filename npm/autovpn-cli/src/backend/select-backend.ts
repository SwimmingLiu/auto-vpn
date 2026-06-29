import { NodeBackend } from './node-backend.js';
import { PythonBackend, PythonBackendOptions } from './python-backend.js';
import { AutoVpnBackend } from './types.js';

export interface SelectBackendOptions extends PythonBackendOptions {
  env?: NodeJS.ProcessEnv;
}

export function selectBackend(options: SelectBackendOptions = {}): AutoVpnBackend {
  const backend = String(options.env?.AUTOVPN_BACKEND ?? '').trim().toLowerCase();
  if (backend === 'node') {
    return new NodeBackend(options);
  }
  if (backend && backend !== 'python') {
    throw new Error(`Unsupported AUTOVPN_BACKEND: ${backend}`);
  }
  return new PythonBackend(options);
}
