import fs from 'node:fs';
import path from 'node:path';

function parseDotEnv(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

export function loadProjectDotEnv(projectRoot: string): Record<string, string> {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  return parseDotEnv(fs.readFileSync(envPath, 'utf8'));
}

export function mergeProjectEnv(projectRoot: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...loadProjectDotEnv(projectRoot),
    ...env
  };
}
