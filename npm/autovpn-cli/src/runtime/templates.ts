import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packagedWorkerTemplatePath = fileURLToPath(new URL('../templates/vmess_node.js', import.meta.url));
const packagedShareWorkerTemplatePath = fileURLToPath(new URL('../templates/share-worker/vpn.js', import.meta.url));

function expandHomePath(candidate: string, env: NodeJS.ProcessEnv): string {
  if (candidate === '~') {
    return env.HOME || candidate;
  }
  if (candidate.startsWith('~/')) {
    return env.HOME ? path.join(env.HOME, candidate.slice(2)) : candidate;
  }
  return candidate;
}

function firstExistingPath(candidates: string[], message: string): string {
  const uniqueCandidates = [...new Set(candidates.filter(Boolean).map((candidate) => path.resolve(candidate)))];
  const resolved = uniqueCandidates.find((candidate) => fs.existsSync(candidate));
  if (resolved) {
    return resolved;
  }
  throw new Error(`${message}; checked: ${uniqueCandidates.join(', ')}`);
}

export function resolveWorkerTemplatePath(projectRoot: string): string {
  return firstExistingPath([
    path.join(projectRoot, 'templates', 'vmess_node.js'),
    packagedWorkerTemplatePath
  ], 'Worker template is missing');
}

export function resolveShareWorkerTemplatePath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return firstExistingPath([
    expandHomePath(String(env.VPN_AUTOMATION_SHARE_WORKER_PATH ?? '').trim(), env),
    path.join(projectRoot, 'electron', 'runtime', 'share-worker', 'vpn.js'),
    path.join(projectRoot, 'templates', 'share-worker', 'vpn.js'),
    packagedShareWorkerTemplatePath,
    path.join(path.dirname(projectRoot), 'cloudflarevpn', 'edgetunnel', 'vpn.js')
  ], 'Share Worker template is missing');
}
