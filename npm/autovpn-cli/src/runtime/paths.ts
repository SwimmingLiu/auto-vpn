import fs from 'node:fs';
import path from 'node:path';

export function resolveRuntimeRoot(candidate: string): string {
  const absolute = path.resolve(candidate || process.cwd());
  const resolved = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
  let current = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? path.dirname(resolved) : resolved;
  while (true) {
    if (fs.existsSync(path.join(current, 'pyproject.toml'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    current = parent;
  }
}

export function resolveProjectRoot(argv: string[], cwd = process.cwd()): string {
  const value = readOptionValue(argv, '--project-root');
  return resolveRuntimeRoot(value ? path.resolve(cwd, value) : cwd);
}

export function resolveProfilePath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.VPN_AUTOMATION_PROFILE_PATH ?? '').trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(projectRoot, 'state', 'profile.toml');
}

export function resolveArtifactsRoot(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.VPN_AUTOMATION_ARTIFACTS_ROOT ?? '').trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(resolveRuntimeRoot(projectRoot), 'artifacts');
}

export function readOptionValue(argv: string[], optionName: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === optionName) {
      return argv[index + 1];
    }
    if (value.startsWith(`${optionName}=`)) {
      return value.slice(optionName.length + 1);
    }
  }
  return undefined;
}
