import path from 'node:path';

import { artifactLatest, artifactList } from '../artifacts/list.js';
import { previewArtifact } from '../artifacts/preview.js';
import { profileSummary } from '../config/profile.js';
import { runDoctor } from '../doctor/checks.js';
import { latestJobId, listJobs, loadJob, publicJobPayload, tailLog } from '../jobs/read.js';
import { readOptionValue, resolveProjectRoot } from '../runtime/paths.js';
import { CliIo } from './output.js';

type PythonFallback = (argv: string[]) => Promise<number>;

interface NativeContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  pythonFallback: PythonFallback;
}

function wantsPython(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] === 'python';
}

function jsonLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function positionalAfter(argv: string[], start: number): string {
  for (let index = start; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--project-root' || value === '--format' || value === '--tail' || value === '--output') {
      index += 1;
      continue;
    }
    if (value.startsWith('--')) {
      continue;
    }
    return value;
  }
  return '';
}

export async function runNativeCommand(argv: string[], context: NativeContext): Promise<number | undefined> {
  const projectRoot = resolveProjectRoot(argv, context.cwd);
  const command = argv[0];

  if (command === 'doctor') {
    if (wantsPython(context.env, 'AUTOVPN_DOCTOR_BACKEND')) return context.pythonFallback(argv);
    if (readOptionValue(argv, '--output') !== 'json') return undefined;
    const result = runDoctor(projectRoot, argv, context.env);
    context.io.writeStdout(jsonLine(result.payload));
    return result.code;
  }

  if (command === 'profile' && argv[1] === 'summary') {
    if (wantsPython(context.env, 'AUTOVPN_PROFILE_BACKEND')) return context.pythonFallback(argv);
    context.io.writeStdout(jsonLine(profileSummary(projectRoot, context.env)));
    return 0;
  }

  if (command === 'artifacts') {
    if (wantsPython(context.env, 'AUTOVPN_ARTIFACTS_BACKEND')) return context.pythonFallback(argv);
    const subcommand = argv[1];
    if (subcommand === 'latest') {
      context.io.writeStdout(jsonLine(artifactLatest(projectRoot, context.env)));
      return 0;
    }
    if (subcommand === 'list') {
      context.io.writeStdout(jsonLine(artifactList(projectRoot, context.env)));
      return 0;
    }
    if (subcommand === 'preview') {
      context.io.writeStdout(jsonLine(previewArtifact(path.resolve(context.cwd, positionalAfter(argv, 2)))));
      return 0;
    }
  }

  if (command === 'jobs') {
    if (wantsPython(context.env, 'AUTOVPN_JOBS_BACKEND')) return context.pythonFallback(argv);
    const subcommand = positionalAfter(argv, 1);
    if (subcommand === 'list') {
      context.io.writeStdout(jsonLine(listJobs(projectRoot, context.env)));
      return 0;
    }
    if (subcommand === 'status') {
      const jobId = positionalAfter(argv, argv.indexOf(subcommand) + 1);
      context.io.writeStdout(jsonLine(publicJobPayload(loadJob(projectRoot, jobId, context.env))));
      return 0;
    }
    if (subcommand === 'logs') {
      if (argv.includes('--follow')) return undefined;
      const jobId = positionalAfter(argv, argv.indexOf(subcommand) + 1);
      context.io.writeStdout(tailLog(projectRoot, jobId, argv, context.env));
      return 0;
    }
  }

  if (command === 'status') {
    if (wantsPython(context.env, 'AUTOVPN_JOBS_BACKEND')) return context.pythonFallback(argv);
    context.io.writeStdout(jsonLine(publicJobPayload(loadJob(projectRoot, latestJobId(projectRoot, context.env), context.env))));
    return 0;
  }

  if (command === 'logs') {
    if (wantsPython(context.env, 'AUTOVPN_JOBS_BACKEND')) return context.pythonFallback(argv);
    if (argv.includes('--follow')) return undefined;
    const jobId = latestJobId(projectRoot, context.env);
    const logFormat = readOptionValue(argv, '--format');
    const syntheticArgv = logFormat ? argv : [...argv, '--format', 'human'];
    context.io.writeStdout(tailLog(projectRoot, jobId, syntheticArgv, context.env));
    return 0;
  }

  return undefined;
}
