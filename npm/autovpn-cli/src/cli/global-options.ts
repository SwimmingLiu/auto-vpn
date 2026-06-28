import path from 'node:path';

export function normalizeProjectRootArgs(argv: string[], cwd = process.cwd()): string[] {
  const normalized = [...argv];
  for (let index = 0; index < normalized.length; index += 1) {
    const value = normalized[index];
    if (value === '--project-root' && index + 1 < normalized.length) {
      normalized[index + 1] = path.resolve(cwd, normalized[index + 1]);
      index += 1;
      continue;
    }
    if (value.startsWith('--project-root=')) {
      const [, projectRoot] = value.split('=', 2);
      normalized[index] = `--project-root=${path.resolve(cwd, projectRoot)}`;
    }
  }
  return normalized;
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
