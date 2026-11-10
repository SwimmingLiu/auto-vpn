import fs from 'node:fs';

// Older tags contain both root mirror URLs and Tencent's /npm/ prefix. Keep
// this action self-contained so release rebuilds can normalize those tags.
function normalize(value) {
  if (!value || typeof value !== 'object') return 0;
  let changed = 0;
  if (typeof value.resolved === 'string') {
    let url;
    try { url = new URL(value.resolved); } catch { url = null; }
    if (url && (url.origin === 'https://registry.npmmirror.com'
      || (url.origin === 'https://mirrors.cloud.tencent.com' && url.pathname.startsWith('/npm/')))) {
      if (url.username || url.password) throw new Error('Credential-bearing registry URLs cannot be rewritten');
      if (url.hostname === 'mirrors.cloud.tencent.com') url.pathname = url.pathname.slice(4);
      url.hostname = 'registry.npmjs.org';
      value.resolved = url.href;
      changed++;
    }
  }
  for (const child of Object.values(value)) changed += normalize(child);
  return changed;
}

for (const file of ['package-lock.json', 'npm/autovpn-cli/package-lock.json']) {
  if (!fs.existsSync(file)) continue;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const changed = normalize(payload);
  if (changed) fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  console.log(`npm registry normalization: ${file}, ${changed} URL(s)`);
}
