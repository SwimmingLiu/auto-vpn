import crypto from 'node:crypto';
import path from 'node:path';

import { CliUsageError } from '../cli/errors.js';
import { readOptionValue, resolveProjectRoot } from '../runtime/paths.js';

export interface ServeOptions {
  host: string;
  port: number;
  projectRoot: string;
  proxy: {
    enabled: boolean;
    url: string;
  };
  auth: {
    enabled: boolean;
    token: string;
  };
}

export interface ParseServeOptionsContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  randomToken?: () => string;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function defaultRandomToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function optionalFlagValue(argv: string[], flag: string): string {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith(`${flag}=`)) {
      return value.slice(flag.length + 1);
    }
    if (value === flag) {
      const next = argv[index + 1] ?? '';
      return next && !next.startsWith('--') ? next : '';
    }
  }
  return '';
}

export function parseServeOptions(argv: string[], context: ParseServeOptionsContext): ServeOptions {
  const host = readOptionValue(argv, '--host') ?? context.env.AUTOVPN_SERVER_HOST ?? '127.0.0.1';
  const portText = readOptionValue(argv, '--port') ?? context.env.AUTOVPN_SERVER_PORT ?? '8765';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliUsageError('serve --port must be an integer from 1 to 65535');
  }

  const token = readOptionValue(argv, '--token') ?? context.env.AUTOVPN_SERVER_TOKEN ?? '';
  const noAuth = hasFlag(argv, '--no-auth');
  if (!isLoopbackHost(host) && !token && !noAuth) {
    throw new CliUsageError('serve requires --token or --no-auth when binding to non-loopback host');
  }

  return {
    host,
    port,
    projectRoot: path.resolve(resolveProjectRoot(argv, context.cwd)),
    proxy: {
      enabled: hasFlag(argv, '--proxy') || argv.some((value) => value.startsWith('--proxy=')),
      url: optionalFlagValue(argv, '--proxy')
    },
    auth: noAuth
      ? { enabled: false, token: '' }
      : { enabled: true, token: token || (context.randomToken ?? defaultRandomToken)() }
  };
}
