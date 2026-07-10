import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';

import { artifactLatest, artifactList } from '../artifacts/list.js';
import { previewArtifact } from '../artifacts/preview.js';
import { profilePayload, profileSummary, saveProfilePayload } from '../config/profile.js';
import { runDoctor } from '../doctor/checks.js';
import { publicStartedPayload, startDetachedResume, startDetachedRetry, startDetachedRun, stopManagedJob } from '../jobs/commands.js';
import { followLog } from '../jobs/logs.js';
import { latestJobId, listJobs, loadJob, publicJobPayload, singleActiveJobId, tailLog } from '../jobs/read.js';
import { readOptionValue, resolveProjectRoot } from '../runtime/paths.js';
import { CliIo } from './output.js';

export interface JobRuntimeOptions {
  spawn?: (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;
  now?: () => string;
  jobId?: () => string;
  jobToken?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

interface NativeContext extends JobRuntimeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  readStdin: () => string | Promise<string>;
}

function jsonLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function renderDoctorHuman(payload: Record<string, unknown>): string {
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  const lines = [`doctor: ${payload.ok ? 'ok' : 'failed'}`];
  for (const item of checks) {
    const check = item as Record<string, unknown>;
    lines.push(`[${String(check.status ?? 'unknown')}] ${String(check.name ?? 'check')}: ${String(check.message ?? '')}`);
  }
  return `${lines.join('\n')}\n`;
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

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function outputFormat(argv: string[]): 'jsonl' | 'human' {
  return readOptionValue(argv, '--output') === 'human' ? 'human' : 'jsonl';
}

function jobOptions(context: NativeContext): JobRuntimeOptions & { env: NodeJS.ProcessEnv; cwd: string } {
  return {
    env: context.env,
    cwd: context.cwd,
    spawn: context.spawn,
    now: context.now,
    jobId: context.jobId,
    jobToken: context.jobToken,
    sleep: context.sleep
  };
}

async function writeFollowLog(projectRoot: string, jobId: string, argv: string[], context: NativeContext): Promise<void> {
  for await (const chunk of followLog(projectRoot, jobId, argv, { env: context.env, sleep: context.sleep })) {
    context.io.writeStdout(chunk);
  }
}

function resolveResumeSessionDir(job: Record<string, any>): string {
  const candidates = [
    String(job.resume_from ?? ''),
    String((job.options ?? {}).session_dir ?? ''),
    String(job.session_dir ?? '')
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'session.json'))) {
      return candidate;
    }
  }
  return '';
}

export async function runNativeCommand(argv: string[], context: NativeContext): Promise<number | undefined> {
  const projectRoot = resolveProjectRoot(argv, context.cwd);
  const command = argv[0];

  if (command === 'doctor') {
    const result = await runDoctor(projectRoot, argv, context.env);
    context.io.writeStdout(readOptionValue(argv, '--output') === 'json'
      ? jsonLine(result.payload)
      : renderDoctorHuman(result.payload));
    return result.code;
  }

  if (command === 'profile') {
    if (argv[1] === 'show') {
      context.io.writeStdout(jsonLine(profilePayload(projectRoot, context.env)));
      return 0;
    }
    if (argv[1] === 'summary') {
      context.io.writeStdout(jsonLine(profileSummary(projectRoot, context.env)));
      return 0;
    }
    if (argv[1] === 'save') {
      const payload = JSON.parse(await context.readStdin()) as Record<string, unknown>;
      context.io.writeStdout(jsonLine(saveProfilePayload(projectRoot, payload, context.env)));
      return 0;
    }
  }

  if (command === 'artifacts') {
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

  if (command === 'run' && hasFlag(argv, '--detach')) {
    const job = await startDetachedRun({
      projectRoot,
      resumeLatest: hasFlag(argv, '--resume-latest'),
      skipDeploy: hasFlag(argv, '--skip-deploy'),
      skipVerify: hasFlag(argv, '--skip-verify'),
      outputFormat: outputFormat(argv)
    }, jobOptions(context));
    context.io.writeStdout(jsonLine(publicStartedPayload(job)));
    return 0;
  }

  if (command === 'jobs') {
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
      const jobId = positionalAfter(argv, argv.indexOf(subcommand) + 1);
      if (argv.includes('--follow')) {
        await writeFollowLog(projectRoot, jobId, argv, context);
        return 0;
      }
      context.io.writeStdout(tailLog(projectRoot, jobId, argv, context.env));
      return 0;
    }
    if (subcommand === 'stop') {
      const jobId = positionalAfter(argv, argv.indexOf(subcommand) + 1);
      const job = await stopManagedJob(projectRoot, jobId, {
        ...jobOptions(context),
        timeoutMs: Number.parseFloat(readOptionValue(argv, '--timeout') ?? '4') * 1000
      });
      context.io.writeStdout(jsonLine(publicJobPayload(job)));
      return 0;
    }
    if (subcommand === 'resume' && hasFlag(argv, '--detach')) {
      const sourceJobId = positionalAfter(argv, argv.indexOf(subcommand) + 1);
      const sourceJob = loadJob(projectRoot, sourceJobId, context.env);
      const sessionDir = resolveResumeSessionDir(sourceJob);
      if (!sessionDir && String(sourceJob.kind ?? '') === 'run') {
        const sourceOptions = sourceJob.options ?? {};
        const job = await startDetachedRun({
          projectRoot,
          sourceJobId,
          resumeLatest: true,
          skipDeploy: Boolean(sourceOptions.skip_deploy),
          skipVerify: Boolean(sourceOptions.skip_verify),
          useProxy: Boolean(sourceOptions.use_proxy),
          proxyUrl: String(sourceOptions.proxy_url ?? ''),
          outputFormat: outputFormat(argv)
        }, jobOptions(context));
        context.io.writeStdout(jsonLine(publicStartedPayload(job)));
        return 0;
      }
      if (!sessionDir) {
        throw new Error('cannot resume job without session.json');
      }
      const job = await startDetachedResume({
        projectRoot,
        sourceJobId,
        sessionDir,
        outputFormat: outputFormat(argv)
      }, jobOptions(context));
      context.io.writeStdout(jsonLine(publicStartedPayload(job)));
      return 0;
    }
    if (subcommand === 'retry' && hasFlag(argv, '--detach')) {
      const job = await startDetachedRetry({
        projectRoot,
        artifactDir: path.resolve(context.cwd, readOptionValue(argv, '--artifact-dir') ?? ''),
        stage: readOptionValue(argv, '--stage') ?? '',
        outputFormat: outputFormat(argv)
      }, jobOptions(context));
      context.io.writeStdout(jsonLine(publicStartedPayload(job)));
      return 0;
    }
  }

  if (command === 'status') {
    context.io.writeStdout(jsonLine(publicJobPayload(loadJob(projectRoot, latestJobId(projectRoot, context.env), context.env))));
    return 0;
  }

  if (command === 'logs') {
    const jobId = latestJobId(projectRoot, context.env);
    const logFormat = readOptionValue(argv, '--format');
    const syntheticArgv = logFormat ? argv : [...argv, '--format', 'human'];
    if (argv.includes('--follow')) {
      await writeFollowLog(projectRoot, jobId, syntheticArgv, context);
      return 0;
    }
    context.io.writeStdout(tailLog(projectRoot, jobId, syntheticArgv, context.env));
    return 0;
  }

  if (command === 'stop') {
    const job = await stopManagedJob(projectRoot, singleActiveJobId(projectRoot, context.env), {
      ...jobOptions(context),
      timeoutMs: Number.parseFloat(readOptionValue(argv, '--timeout') ?? '4') * 1000
    });
    context.io.writeStdout(jsonLine(publicJobPayload(job)));
    return 0;
  }

  return undefined;
}
