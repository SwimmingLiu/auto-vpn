import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  absWorkingDir: project,
  entryPoints: ['electron/ui/analytics.tsx'],
  outfile: 'electron/renderer/analytics.bundle.js',
  bundle: true,
  metafile: true,
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

// The npm/web artifact copies renderer assets without the source vendor tree.
// Carry the actual permission notices alongside the bundled implementation.
const notices = ['beUI\n' + fs.readFileSync(path.join(project, 'electron/ui/vendor/beui/LICENSE'), 'utf8')];
const packages = new Set([path.join(project, 'node_modules/tailwindcss')]);
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = path.dirname(path.resolve(project, input));
  while (directory.startsWith(path.join(project, 'node_modules'))) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath) && JSON.parse(fs.readFileSync(manifestPath, 'utf8')).name) { packages.add(directory); break; }
    directory = path.dirname(directory);
  }
}
for (const directory of [...packages].sort()) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const licenses = fs.readdirSync(directory).filter((name) => /^licen[sc]e(?:\.|$)/i.test(name));
  for (const name of licenses) notices.push(`${manifest.name} ${manifest.version}\n${fs.readFileSync(path.join(directory, name), 'utf8')}`);
}
fs.writeFileSync(path.join(project, 'electron/renderer/THIRD_PARTY_NOTICES.txt'), notices.join('\n\n---\n\n'));
