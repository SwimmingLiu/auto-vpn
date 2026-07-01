import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from '@iarna/toml';

import { resolveArtifactsRoot, resolveProfilePath } from '../runtime/paths.js';

const DEFAULT_SOURCE_ORDER = ['leiting', 'heidong', 'mifeng', 'xuanfeng-area', 'xuanfeng-all-area'];

function state(value: unknown): string {
  return String(value ?? '').trim() ? 'set' : 'missing';
}

function readProfile(profilePath: string): Record<string, any> {
  if (!fs.existsSync(profilePath)) {
    return {};
  }
  return parse(fs.readFileSync(profilePath, 'utf8')) as Record<string, any>;
}

export function profileSummary(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const profilePath = resolveProfilePath(projectRoot, env);
  const stateRoot = path.dirname(profilePath);
  const payload = readProfile(profilePath);
  const rawSources = (payload.sources ?? {}) as Record<string, any>;
  const sourceNames = [
    ...DEFAULT_SOURCE_ORDER,
    ...Object.keys(rawSources).filter((name) => !DEFAULT_SOURCE_ORDER.includes(name)).sort()
  ];
  const sources = Object.fromEntries(
    sourceNames.map((name) => {
      const config = rawSources[name] ?? {};
      return [
      name,
      {
        enabled: Boolean(config?.enabled ?? true),
        url: state(config?.url),
        key: state(config?.key)
      }
    ];
    })
  );
  const deploy = (payload.deploy ?? {}) as Record<string, any>;
  return {
    ok: true,
    sources,
    deploy: {
      project_name: String(deploy.project_name ?? ''),
      pages_project_url: String(deploy.pages_project_url ?? ''),
      cloudflare_api_token: state(deploy.cloudflare_api_token),
      cloudflare_global_key: state(deploy.cloudflare_global_key),
      cloudflare_email: state(deploy.cloudflare_email),
      account_id: state(deploy.account_id),
      subscription_url: state(deploy.subscription_url),
      verify_subscription_url: state(deploy.verify_subscription_url),
      secret_query: state(deploy.secret_query)
    },
    paths: {
      project_root: projectRoot,
      artifacts_root: resolveArtifactsRoot(projectRoot, env),
      state_root: stateRoot,
      profile_path: profilePath
    }
  };
}

export function profilePayload(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const profilePath = resolveProfilePath(projectRoot, env);
  const paths = {
    project_root: projectRoot,
    artifacts_root: resolveArtifactsRoot(projectRoot, env),
    state_root: path.dirname(profilePath),
    profile_path: profilePath
  };
  return {
    ...readProfile(profilePath),
    paths,
    workspace: paths
  };
}

export function saveProfilePayload(projectRoot: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const profilePath = resolveProfilePath(projectRoot, env);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const persisted = { ...payload };
  delete (persisted as Record<string, unknown>).paths;
  delete (persisted as Record<string, unknown>).workspace;
  fs.writeFileSync(profilePath, stringify(persisted as any), 'utf8');
  return profilePayload(projectRoot, env);
}
