import { NodeBackend, NodeBackendOptions } from './node-backend.js';
import { AutoVpnBackend } from './types.js';

export interface SelectBackendOptions extends NodeBackendOptions {
  env?: NodeJS.ProcessEnv;
}

export function selectBackend(options: SelectBackendOptions = {}): AutoVpnBackend {
  const backend = String(options.env?.AUTOVPN_BACKEND ?? '').trim().toLowerCase();
  if (backend === 'python') {
    throw new Error('AUTOVPN_BACKEND=python is no longer supported; AutoVPN now runs on the NodeJS engine');
  }
  if (backend && backend !== 'node') {
    throw new Error(`Unsupported AUTOVPN_BACKEND: ${backend}`);
  }
  return new NodeBackend(options);
}
