import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Native runs use the CLI's existing event-log sink. Each run owns its file,
// so a terminating child cannot append into a newer run's recovery history.
export function createRendererEventLog(profilePath) {
  const root = path.join(path.dirname(profilePath), 'desktop-events');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = `${randomUUID()}.jsonl`;
  fs.writeFileSync(path.join(root, file), '', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'latest.json'), JSON.stringify({ file }), { mode: 0o600 });
  return path.join(root, file);
}

export function readRendererHistory(profilePath, artifactDir = '') {
  const root = path.join(path.dirname(profilePath), 'desktop-events');
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'));
    if (typeof pointer?.file !== 'string' || !/^[a-f0-9-]+\.jsonl$/.test(pointer.file)) return [];
    const events = fs.readFileSync(path.join(root, pointer.file), 'utf8').split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const started = events.find((event) => event?.type === 'run_started');
    if (artifactDir && started?.artifact_dir && path.resolve(started.artifact_dir) !== path.resolve(artifactDir)) return [];
    const steps = new Map();
    // Counts already come from the artifact snapshot; replay only stateful
    // extraction steps, rather than incrementing saved result totals twice.
    for (const event of events) {
      if (event?.type === 'extract_substage') steps.set([event.source_name, event.platform, event.substage].join(':'), event);
      if (event?.type === 'stage' && typeof event.stage === 'string') steps.set(`stage:${event.stage}`, event);
    }
    return [...steps.values()];
  } catch {
    return [];
  }
}
