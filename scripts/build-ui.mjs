import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  absWorkingDir: project,
  entryPoints: ['electron/ui/analytics.tsx'],
  outfile: 'electron/renderer/analytics.bundle.js',
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  alias: { '@': path.join(project, 'electron/ui/vendor/beui') },
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof'
});
const css = spawnSync(process.execPath, [
  'node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'electron/ui/theme.css',
  '-o', 'electron/renderer/analytics.bundle.css', '--minify'
], { cwd: project, stdio: 'inherit' });
if (css.status !== 0) process.exit(css.status ?? 1);
