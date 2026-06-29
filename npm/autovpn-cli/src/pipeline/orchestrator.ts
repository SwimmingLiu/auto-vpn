import { mkdir, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@iarna/toml';

import { AutoVpnEvent } from '../events/schema.js';
import { mergeProjectEnv } from '../runtime/env.js';
import { resolveArtifactsRoot, resolveProfilePath } from '../runtime/paths.js';
import { redactText } from '../runtime/redaction.js';
import { fetchSourceLinksWithBackend, ExtractedSourceResult, SourceConfigInput } from './extract.js';
import { dedupeVmessLinksWithBackend } from './dedupe.js';
import { speedtestLinksWithBackend, SpeedTestResult } from './speedtest.js';
import { checkLinkAvailabilityBatchWithBackend, AvailabilityResultDict } from './availability.js';
import { decorateLinkWithCountry, postprocessLinksWithBackend } from './postprocess.js';
import { renderMainDataWithBackend } from './render.js';
import { buildWorkerArtifactsWithBackend, WorkerBuildArtifacts } from './obfuscate.js';

type StageName = 'doctor' | 'extract' | 'dedupe' | 'speedtest' | 'availability' | 'postprocess' | 'render' | 'obfuscate' | 'deploy' | 'verify';
type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface NodePipelineOptions {
  projectRoot: string;
  skipDeploy?: boolean;
  skipVerify?: boolean;
  output?: 'jsonl' | 'human';
  eventLog?: string;
  humanLog?: string;
}

export interface PipelineSummary {
  artifact_dir: string;
  stage_status: Record<StageName, StageStatus>;
  counts: Record<string, number>;
  source_counts: Record<string, Record<string, number>>;
  deployment: Record<string, unknown>;
  retry_context: Record<string, unknown>;
  run_status: 'success' | 'failed';
  error: string;
}

export interface NodePipelineStageOverrides {
  extract?: (input: { source_name: string; source: SourceConfigInput }) => ExtractedSourceResult | Promise<ExtractedSourceResult>;
  speedtest?: (links: string[], config: Record<string, unknown>, runtimePath: string) => SpeedTestResult[] | Promise<SpeedTestResult[]>;
  availability?: (results: SpeedTestResult[], config: Record<string, unknown>, runtimePath: string, targets: unknown) => AvailabilityResultDict[] | Promise<AvailabilityResultDict[]>;
  countryLookup?: (link: string, speedResult: SpeedTestResult, availabilityResult: AvailabilityResultDict) => string;
  obfuscate?: (input: { transformedSource: string; config: Record<string, unknown>; secretQuery: string }) => WorkerBuildArtifacts | Promise<WorkerBuildArtifacts>;
}

export interface RunNodePipelineContext {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  emit?: (event: AutoVpnEvent) => void;
  stages?: NodePipelineStageOverrides;
}

interface PipelineProfile {
  sources?: Record<string, SourceConfigInput>;
  speed_test?: Record<string, unknown>;
  availability_targets?: unknown;
  deploy?: Record<string, unknown>;
  worker_build?: Record<string, unknown>;
  filters?: Record<string, unknown>;
}

const STAGES: StageName[] = ['doctor', 'extract', 'dedupe', 'speedtest', 'availability', 'postprocess', 'render', 'obfuscate', 'deploy', 'verify'];
const DEFAULT_PYTHON_RUNTIME_STAGES = ['EXTRACT', 'SPEEDTEST', 'AVAILABILITY'];

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

async function uniqueArtifactDir(root: string, timestamp: string): Promise<string> {
  await mkdir(root, { recursive: true });
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(root, index === 0 ? timestamp : `${timestamp}-${index}`);
    if (!fs.existsSync(candidate)) {
      await mkdir(candidate, { recursive: true });
      return candidate;
    }
  }
  throw new Error(`Unable to allocate artifact directory under ${root}`);
}

function stageStatus(): Record<StageName, StageStatus> {
  return Object.fromEntries(STAGES.map((stage) => [stage, 'pending'])) as Record<StageName, StageStatus>;
}

function asProfile(payload: unknown): PipelineProfile {
  return (payload ?? {}) as PipelineProfile;
}

async function readProfile(projectRoot: string, env: NodeJS.ProcessEnv): Promise<PipelineProfile> {
  const profilePath = resolveProfilePath(projectRoot, env);
  const text = await readFile(profilePath, 'utf8');
  return asProfile(parse(text));
}

function enabledSources(profile: PipelineProfile): Array<[string, SourceConfigInput]> {
  return Object.entries(profile.sources ?? {}).filter(([, source]) => source.enabled !== false);
}

function linesText(lines: string[]): string {
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

async function writeLines(artifactDir: string, filename: string, lines: string[]): Promise<void> {
  await writeFile(path.join(artifactDir, filename), linesText(lines), 'utf8');
}

async function writeJson(artifactDir: string, filename: string, payload: unknown): Promise<void> {
  await writeFile(path.join(artifactDir, filename), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendTextFile(filePath: string | undefined, text: string): void {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, text, 'utf8');
}

function renderHumanEvent(event: AutoVpnEvent): string {
  if (event.type === 'run_started') {
    return `[run_started] artifact_dir=${String(event.artifact_dir ?? '')} skip_deploy=${String(Boolean(event.skip_deploy))} skip_verify=${String(Boolean(event.skip_verify))}`;
  }
  if (event.type === 'log') {
    return String(event.message ?? '');
  }
  if (event.type === 'stage') {
    return `[stage] ${String(event.stage ?? '')}=${String(event.status ?? '')}`;
  }
  if (event.type === 'summary') {
    const counts = Object.entries((event.counts ?? {}) as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(' ');
    const suffix = counts ? ` ${counts}` : '';
    return `[summary] run_status=${String(event.run_status ?? 'unknown')} artifact_dir=${String(event.artifact_dir ?? '')}${suffix}`;
  }
  if (event.type === 'run_failed') {
    return `[run_failed] ${String(event.error ?? 'unknown error')}`;
  }
  return JSON.stringify(event);
}

function eventLogLine(event: AutoVpnEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function humanLogLine(event: AutoVpnEvent): string {
  return `${renderHumanEvent(event)}\n`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactText(`${error.constructor.name}: ${error.message}`);
  }
  return redactText(String(error));
}

function defaultRuntimeStageEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  if (next.AUTOVPN_PIPELINE_BACKEND) {
    return next;
  }
  for (const stage of DEFAULT_PYTHON_RUNTIME_STAGES) {
    const key = `AUTOVPN_STAGE_BACKEND_${stage}`;
    if (!next[key]) {
      next[key] = 'python';
    }
  }
  return next;
}

function orderPreservingUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function defaultCountryFor(_link: string, _speedResult: SpeedTestResult, _availabilityResult: AvailabilityResultDict): string {
  return 'US';
}

async function writeWorkerArtifacts(artifactDir: string, profile: PipelineProfile, renderedSource: string, artifacts: WorkerBuildArtifacts): Promise<void> {
  const workerBuild = profile.worker_build ?? {};
  const entryFilename = String(workerBuild.entry_filename ?? 'unknown.js');
  const bundleSubdir = String(workerBuild.bundle_subdir ?? 'pages_bundle');
  const manifestFilename = String(workerBuild.manifest_filename ?? 'manifest.json');
  const bundleDir = path.join(artifactDir, bundleSubdir);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'vmess_node.js'), renderedSource, 'utf8');
  await writeFile(path.join(artifactDir, 'worker_transformed.js'), artifacts.transformed_source, 'utf8');
  await writeFile(path.join(artifactDir, entryFilename), artifacts.transformed_source, 'utf8');
  await writeFile(path.join(bundleDir, entryFilename), artifacts.transformed_source, 'utf8');
  await writeJson(bundleDir, manifestFilename, artifacts.manifest);
  for (const [modulePath, moduleSource] of Object.entries(artifacts.modules ?? {})) {
    const destination = path.join(bundleDir, modulePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, moduleSource, 'utf8');
  }
}

export async function runNodePipeline(options: NodePipelineOptions, context: RunNodePipelineContext = {}): Promise<PipelineSummary> {
  const projectRoot = path.resolve(options.projectRoot);
  const env = mergeProjectEnv(projectRoot, { ...process.env, ...(context.env ?? {}) });
  const runtimeStageEnv = defaultRuntimeStageEnv(env);
  const artifactDir = await uniqueArtifactDir(resolveArtifactsRoot(projectRoot, env), formatTimestamp((context.now ?? (() => new Date()))()));
  const summary: PipelineSummary = {
    artifact_dir: artifactDir,
    stage_status: stageStatus(),
    counts: {},
    source_counts: {},
    deployment: {},
    retry_context: {},
    run_status: 'success',
    error: ''
  };

  const emit = (type: string, payload: Record<string, unknown> = {}) => {
    const event = { type, ...payload } as AutoVpnEvent;
    appendTextFile(options.eventLog, eventLogLine(event));
    appendTextFile(options.humanLog, humanLogLine(event));
    context.emit?.(event);
  };
  const writeReport = () => writeJson(artifactDir, 'pipeline_report.json', summary);
  let activeStage: StageName | undefined;
  const setStage = async (stage: StageName, status: StageStatus) => {
    summary.stage_status[stage] = status;
    activeStage = status === 'running' ? stage : activeStage === stage ? undefined : activeStage;
    emit('stage', { stage, status });
    await writeReport();
  };

  emit('run_started', {
    artifact_dir: artifactDir,
    skip_deploy: Boolean(options.skipDeploy),
    skip_verify: Boolean(options.skipVerify),
    resume_from: ''
  });

  try {
    await setStage('doctor', 'running');
    await setStage('doctor', 'success');
    const profile = await readProfile(projectRoot, env);

    await setStage('extract', 'running');
    const extractResults: ExtractedSourceResult[] = [];
    for (const [sourceName, source] of enabledSources(profile)) {
      const result = context.stages?.extract
        ? await context.stages.extract({ source_name: sourceName, source })
        : await fetchSourceLinksWithBackend({ source_name: sourceName, source }, { cwd: projectRoot, env: runtimeStageEnv });
      extractResults.push(result);
      summary.source_counts[result.source_name] = {
        raw_links: result.links.length,
        successful_iterations: result.successful_iterations,
        failed_iterations: result.failed_iterations
      };
    }
    const rawLinks = extractResults.flatMap((result) => result.links);
    summary.counts.raw_links = rawLinks.length;
    await writeLines(artifactDir, 'vpn_node_raw.txt', rawLinks);
    await setStage('extract', 'success');

    await setStage('dedupe', 'running');
    const dedupedLinks = context.stages?.extract
      ? orderPreservingUnique(rawLinks)
      : await dedupeVmessLinksWithBackend(rawLinks, { cwd: projectRoot, env });
    summary.counts.deduped_links = dedupedLinks.length;
    await writeLines(artifactDir, 'vpn_node_deduped.txt', dedupedLinks);
    await setStage('dedupe', 'success');

    await setStage('speedtest', 'running');
    const runtimePath = path.join(artifactDir, 'runtime');
    const speedResults = context.stages?.speedtest
      ? await context.stages.speedtest(dedupedLinks, profile.speed_test ?? {}, runtimePath)
      : await speedtestLinksWithBackend({ links: dedupedLinks, config: profile.speed_test as any, runtime_path: runtimePath }, { cwd: projectRoot, env: runtimeStageEnv });
    const passedSpeedLinks = speedResults
      .filter((result) => result.reachable && result.average_download_mb_s >= Number(profile.speed_test?.min_download_mb_s ?? 0))
      .map((result) => result.link);
    summary.counts.speedtest_links = passedSpeedLinks.length;
    await writeLines(artifactDir, 'vpn_node_speedtest.txt', passedSpeedLinks);
    await writeJson(artifactDir, 'vpn_node_speedtest_report.json', speedResults);
    await setStage('speedtest', 'success');

    await setStage('availability', 'running');
    const speedResultByLink = new Map(speedResults.map((result) => [result.link, result]));
    const candidateSpeedResults = passedSpeedLinks.map((link) => speedResultByLink.get(link)).filter((result): result is SpeedTestResult => Boolean(result));
    const availabilityResults = context.stages?.availability
      ? await context.stages.availability(candidateSpeedResults, profile.speed_test ?? {}, runtimePath, profile.availability_targets)
      : await checkLinkAvailabilityBatchWithBackend({
        results: candidateSpeedResults,
        config: profile.speed_test ?? {},
        runtime_path: runtimePath,
        targets: profile.availability_targets as any
      }, { cwd: projectRoot, env: runtimeStageEnv });
    const availableLinks = availabilityResults.filter((result) => result.all_passed).map((result) => result.link);
    summary.counts.availability_links = availableLinks.length;
    await writeLines(artifactDir, 'vpn_node_availability.txt', availableLinks);
    await writeJson(artifactDir, 'vpn_node_availability_report.json', availabilityResults);
    await setStage('availability', 'success');

    await setStage('postprocess', 'running');
    const countryLookup = context.stages?.countryLookup ?? defaultCountryFor;
    const availabilityByLink = new Map(availabilityResults.map((result) => [result.link, result]));
    const rankedLinks = availableLinks.map((link) => ({
      link,
      country_code: countryLookup(link, speedResultByLink.get(link) as SpeedTestResult, availabilityByLink.get(link) as AvailabilityResultDict)
    }));
    const postprocessed = context.stages?.countryLookup
      ? { links: rankedLinks.map((item) => decorateLinkWithCountry(item.link, item.country_code)) }
      : await postprocessLinksWithBackend({ ranked_links: rankedLinks, filters: profile.filters as any }, { cwd: projectRoot, env });
    summary.counts.final_links = postprocessed.links.length;
    await writeLines(artifactDir, 'vpn_node_emoji.txt', postprocessed.links);
    await setStage('postprocess', 'success');

    await setStage('render', 'running');
    const template = await readFile(path.join(projectRoot, 'templates', 'vmess_node.js'), 'utf8');
    const rendered = await renderMainDataWithBackend({ template, links: postprocessed.links }, { cwd: projectRoot, env });
    await setStage('render', 'success');

    await setStage('obfuscate', 'running');
    const secretQuery = String(profile.deploy?.secret_query ?? '');
    const workerArtifacts = context.stages?.obfuscate
      ? await context.stages.obfuscate({ transformedSource: rendered.rendered_source, config: profile.worker_build ?? {}, secretQuery })
      : await buildWorkerArtifactsWithBackend({
        rendered_source: rendered.rendered_source,
        config: profile.worker_build as any,
        secret_query: secretQuery
      }, { cwd: projectRoot, env });
    await writeWorkerArtifacts(artifactDir, profile, rendered.rendered_source, workerArtifacts);
    await setStage('obfuscate', 'success');

    await setStage('deploy', options.skipDeploy ? 'skipped' : 'failed');
    if (!options.skipDeploy) {
      throw new Error('Node backend deploy is not available yet; use --skip-deploy');
    }
    await setStage('verify', options.skipVerify ? 'skipped' : 'failed');
    if (!options.skipVerify) {
      throw new Error('Node backend verify is not available yet; use --skip-verify');
    }
  } catch (error) {
    summary.run_status = 'failed';
    summary.error = errorMessage(error);
    if (activeStage && summary.stage_status[activeStage] === 'running') {
      summary.stage_status[activeStage] = 'failed';
      emit('stage', { stage: activeStage, status: 'failed' });
    }
    await writeReport();
    emit('summary', summary as unknown as Record<string, unknown>);
    emit('run_failed', { error: summary.error });
    throw error;
  }

  await writeReport();
  emit('summary', summary as unknown as Record<string, unknown>);
  return summary;
}
