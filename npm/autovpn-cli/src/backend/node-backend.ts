import { AutoVpnBackend } from './types.js';

export class NodeBackend implements Partial<AutoVpnBackend> {
  readonly kind = 'node' as const;
}
