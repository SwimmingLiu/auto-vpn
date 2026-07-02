import fs from 'node:fs';
import path from 'node:path';

export function migrateLegacyPackagedProfile(runtimeProfilePath, legacyProfilePath) {
  if (!legacyProfilePath || legacyProfilePath === runtimeProfilePath) {
    return { migrated: false, reason: 'no_legacy_profile_path' };
  }
  if (fs.existsSync(runtimeProfilePath)) {
    return { migrated: false, reason: 'runtime_profile_exists' };
  }
  if (!fs.existsSync(legacyProfilePath)) {
    return { migrated: false, reason: 'legacy_profile_missing' };
  }

  fs.mkdirSync(path.dirname(runtimeProfilePath), { recursive: true });
  fs.copyFileSync(legacyProfilePath, runtimeProfilePath);
  return { migrated: true, reason: 'copied_legacy_profile' };
}
