import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(__filename), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const sourceDir = path.join(repoRoot, 'electron', 'renderer');
const targetDir = path.join(packageRoot, 'dist', 'web', 'renderer');
const templateSourceDir = path.join(repoRoot, 'templates');
const templateTargetDir = path.join(packageRoot, 'dist', 'templates');

await fs.rm(targetDir, { recursive: true, force: true });
await fs.mkdir(path.dirname(targetDir), { recursive: true });
await fs.cp(sourceDir, targetDir, { recursive: true });
await fs.rm(templateTargetDir, { recursive: true, force: true });
await fs.cp(templateSourceDir, templateTargetDir, { recursive: true });
