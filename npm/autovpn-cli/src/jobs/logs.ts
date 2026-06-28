import fs from 'node:fs';

import { loadJob, tailLog } from './read.js';
import { readOptionValue } from '../runtime/paths.js';

export interface FollowLogOptions {
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

function logPathFor(job: Record<string, any>, argv: string[]): string {
  return String((readOptionValue(argv, '--format') === 'jsonl' ? job.event_log : job.human_log) ?? '');
}

function readFromOffset(filePath: string, offset: number): { chunk: string; offset: number } {
  if (!fs.existsSync(filePath)) {
    return { chunk: '', offset };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size <= offset) {
      return { chunk: '', offset: stat.size };
    }
    const buffer = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    return { chunk: buffer.toString('utf8'), offset: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* followLog(projectRoot: string, jobId: string, argv: string[], options: FollowLogOptions = {}): AsyncIterable<string> {
  const env = options.env ?? process.env;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 1000;
  const initial = tailLog(projectRoot, jobId, argv, env);
  if (initial) {
    yield initial;
  }
  let job = loadJob(projectRoot, jobId, env);
  const filePath = logPathFor(job, argv);
  let offset = fs.existsSync(filePath) ? Buffer.byteLength(fs.readFileSync(filePath, 'utf8')) : 0;
  while (['running', 'stopping'].includes(String(job.status ?? ''))) {
    await sleep(pollMs);
    const update = readFromOffset(filePath, offset);
    if (update.chunk) {
      yield update.chunk;
    }
    offset = update.offset;
    job = loadJob(projectRoot, jobId, env);
  }
}
