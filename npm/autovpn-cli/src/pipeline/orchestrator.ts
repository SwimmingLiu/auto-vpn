import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@iarna/toml';

import { AutoVpnEvent } from '../events/schema.js';
import { mergeProjectEnv } from '../runtime/env.js';
import { resolveArtifactsRoot, resolveProfilePath } from '../runtime/paths.js';
import { redactText } from '../runtime/redaction.js';
import { fetchSourceLinksWithBackend, ExtractedSourceResult, SourceConfigInput } from './extract.js';
import { dedupeVmessLinksWithBackend } from './dedupe.js';
import {
  normalizeSpeedTestConfig,
  ProbeResult,
  probeSpeedtestLinksInNode,
  selectSpeedtestCandidates,
  speedtestLinksWithBackend,
  SpeedTestResult,
  testSpeedtestLinkInNode
} from './speedtest.js';
import { checkLinkAvailabilityBatchWithBackend, AvailabilityResultDict } from './availability.js';
import { decorateLinkWithCountry, postprocessLinksWithBackend } from './postprocess.js';
import { renderMainDataWithBackend } from './render.js';
import { buildWorkerArtifactsWithBackend, WorkerBuildArtifacts } from './obfuscate.js';
import { deployPagesWithBackend, isVerifySuccess, verifyDeploymentWithBackend } from './deploy.js';
import { safeDeployment } from '../runtime/redaction.js';

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

export interface NodeRetryStageOptions {
  projectRoot: string;
  artifactDir: string;
  stage: string;
  output?: 'jsonl' | 'human';
  eventLog?: string;
  humanLog?: string;
}

export interface NodeResumeOptions {
  projectRoot: string;
  mode: 'pipeline' | 'speedtest';
  session: string;
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
  speedtestProbe?: (links: string[], config: Record<string, unknown>, runtimePath: string) => ProbeResult[] | Promise<ProbeResult[]>;
  speedtestLink?: (link: string, config: Record<string, unknown>, runtimePath: string) => SpeedTestResult | Promise<SpeedTestResult>;
  availability?: (results: SpeedTestResult[], config: Record<string, unknown>, runtimePath: string, targets: unknown) => AvailabilityResultDict[] | Promise<AvailabilityResultDict[]>;
  countryLookup?: (link: string, speedResult: SpeedTestResult, availabilityResult: AvailabilityResultDict) => string;
  obfuscate?: (input: { transformedSource: string; config: Record<string, unknown>; secretQuery: string }) => WorkerBuildArtifacts | Promise<WorkerBuildArtifacts>;
  deploy?: (input: { projectRoot: string; bundleDir: string; profile: PipelineProfile }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  verify?: (input: { projectRoot: string; profile: PipelineProfile; deployment: Record<string, unknown> }) => Record<string, unknown> | Promise<Record<string, unknown>>;
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
const RETRYABLE_STAGES: StageName[] = ['speedtest', 'availability', 'postprocess', 'render', 'obfuscate', 'deploy', 'verify'];
const DEFAULT_PYTHON_RUNTIME_STAGES = ['EXTRACT', 'SPEEDTEST', 'AVAILABILITY'];

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

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
  return Object.entries(profile.sources ?? {}).filter(([, source]) => (
    source.enabled !== false
    && String(source.url ?? '').trim()
    && String(source.key ?? '').trim()
  ));
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

async function readJson<T = Record<string, unknown>>(filePath: string, fallback: T): Promise<T> {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function readLines(filePath: string): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return (await readFile(filePath, 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function copyIfExists(source: string, destination: string): Promise<void> {
  if (!fs.existsSync(source)) {
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function copyDirectoryIfExists(source: string, destination: string): void {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
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
  if (isEnabled(next.AUTOVPN_NO_PYTHON)) {
    return next;
  }
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

function normalizeRetryStage(stage: string): StageName {
  if ((RETRYABLE_STAGES as string[]).includes(stage)) {
    return stage as StageName;
  }
  throw new Error(`Unsupported retry stage: ${stage}`);
}

function isStageAtOrAfter(candidate: StageName, target: StageName): boolean {
  return STAGES.indexOf(candidate) >= STAGES.indexOf(target);
}

function seedCompletedStages(summary: PipelineSummary, stage: StageName): void {
  for (const name of STAGES) {
    if (name === stage) {
      return;
    }
    summary.stage_status[name] = 'success';
  }
}

async function seedRetryArtifact(sourceArtifactDir: string, retryArtifactDir: string, stage: StageName, retryContext: Record<string, unknown>, bundleSubdir: string): Promise<PipelineSummary> {
  const sourceReport = await readJson<Record<string, unknown>>(path.join(sourceArtifactDir, 'pipeline_report.json'), {});
  const summary: PipelineSummary = {
    artifact_dir: retryArtifactDir,
    stage_status: stageStatus(),
    counts: { ...((sourceReport.counts ?? {}) as Record<string, number>) },
    source_counts: { ...((sourceReport.source_counts ?? {}) as Record<string, Record<string, number>>) },
    deployment: { ...((sourceReport.deployment ?? {}) as Record<string, unknown>) },
    retry_context: retryContext,
    run_status: 'success',
    error: ''
  };

  await copyIfExists(path.join(sourceArtifactDir, 'vpn_node_raw.txt'), path.join(retryArtifactDir, 'vpn_node_raw.txt'));
  await copyIfExists(path.join(sourceArtifactDir, 'vpn_node_deduped.txt'), path.join(retryArtifactDir, 'vpn_node_deduped.txt'));
  if (isStageAtOrAfter(stage, 'availability')) {
    await copyIfExists(path.join(sourceArtifactDir, 'vpn_node_speedtest.txt'), path.join(retryArtifactDir, 'vpn_node_speedtest.txt'));
    await copyIfExists(path.join(sourceArtifactDir, 'vpn_node_speedtest_report.json'), path.join(retryArtifactDir, 'vpn_node_speedtest_report.json'));
  }
  if (isStageAtOrAfter(stage, 'postprocess')) {
    await copyIfExists(path.join(sourceArtifactDir, 'vpn_node_availability.txt'), path.join(retryArtifactDir, 'vpn_node_availability.txt'));
    await copyIfExists(path.join(sourceArtifactDir, 'vpn_node_availability_report.json'), path.join(retryArtifactDir, 'vpn_node_availability_report.json'));
  }
  if (isStageAtOrAfter(stage, 'render')) {
    await copyIfExists(path.join(sourceArtifactDir, 'vpn_node_emoji.txt'), path.join(retryArtifactDir, 'vpn_node_emoji.txt'));
  }
  if (isStageAtOrAfter(stage, 'obfuscate')) {
    await copyIfExists(path.join(sourceArtifactDir, 'vmess_node.js'), path.join(retryArtifactDir, 'vmess_node.js'));
  }
  if (isStageAtOrAfter(stage, 'deploy')) {
    await copyIfExists(path.join(sourceArtifactDir, 'worker_transformed.js'), path.join(retryArtifactDir, 'worker_transformed.js'));
    await copyIfExists(path.join(sourceArtifactDir, '_worker.js'), path.join(retryArtifactDir, '_worker.js'));
    copyDirectoryIfExists(path.join(sourceArtifactDir, bundleSubdir), path.join(retryArtifactDir, bundleSubdir));
  }

  seedCompletedStages(summary, stage);
  await writeJson(retryArtifactDir, 'pipeline_report.json', summary);
  return summary;
}

function pipelineSummaryFromReport(artifactDir: string, report: Record<string, unknown>): PipelineSummary {
  return {
    artifact_dir: artifactDir,
    stage_status: { ...stageStatus(), ...((report.stage_status ?? {}) as Record<StageName, StageStatus>) },
    counts: { ...((report.counts ?? {}) as Record<string, number>) },
    source_counts: { ...((report.source_counts ?? {}) as Record<string, Record<string, number>>) },
    deployment: { ...((report.deployment ?? {}) as Record<string, unknown>) },
    retry_context: { ...((report.retry_context ?? {}) as Record<string, unknown>) },
    run_status: String(report.run_status ?? 'success') === 'failed' ? 'failed' : 'success',
    error: String(report.error ?? '')
  };
}

function passedSpeedResults(allResults: SpeedTestResult[], passedLinks: string[]): SpeedTestResult[] {
  const byLink = new Map(allResults.map((result) => [result.link, result]));
  return passedLinks
    .map((link) => byLink.get(link))
    .filter((result): result is SpeedTestResult => Boolean(result))
    .sort((left, right) => right.average_download_mb_s - left.average_download_mb_s);
}

async function speedResultsFromEventLog(eventLog: string, passedLinks: string[]): Promise<SpeedTestResult[]> {
  if (!fs.existsSync(eventLog)) {
    return [];
  }
  const passed = new Set(passedLinks);
  const byLink = new Map<string, SpeedTestResult>();
  for (const line of (await readFile(eventLog, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const payload = JSON.parse(line) as Record<string, unknown>;
    if (payload.type !== 'speedtest_result') {
      continue;
    }
    const link = String(payload.link ?? '').trim();
    if (!link || !passed.has(link)) {
      continue;
    }
    byLink.set(link, {
      link,
      reachable: Boolean(payload.reachable),
      average_download_mb_s: Number(payload.average_download_mb_s ?? 0) || 0,
      latency_ms: Number(payload.latency_ms ?? 0) || 0,
      error: String(payload.error ?? '')
    });
  }
  return Array.from(byLink.values()).sort((left, right) => right.average_download_mb_s - left.average_download_mb_s);
}

async function restoreResumeSpeedResults(artifactDir: string, eventLog: string, passedLinks: string[]): Promise<SpeedTestResult[]> {
  const artifactResults = passedSpeedResults(
    await readJson<SpeedTestResult[]>(path.join(artifactDir, 'vpn_node_speedtest_report.json'), []),
    passedLinks
  );
  if (artifactResults.length > 0) {
    return artifactResults;
  }
  return speedResultsFromEventLog(eventLog, passedLinks);
}

async function forEachWithConcurrency<T>(items: T[], concurrency: number, mapper: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.max(1, Math.floor(concurrency)), items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(items[index]);
    }
  }));
}

async function speedtestResumeStateFromEventLog(eventLog: string): Promise<{ probes: Map<string, ProbeResult>; fullResults: Map<string, SpeedTestResult> }> {
  const probes = new Map<string, ProbeResult>();
  const fullResults = new Map<string, SpeedTestResult>();
  if (!fs.existsSync(eventLog)) {
    return { probes, fullResults };
  }
  for (const line of (await readFile(eventLog, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const payload = JSON.parse(line) as Record<string, unknown>;
    const link = String(payload.link ?? '').trim();
    if (!link) {
      continue;
    }
    if (payload.type === 'speedtest_probe_result') {
      probes.set(link, {
        link,
        reachable: Boolean(payload.reachable),
        latency_ms: Number(payload.latency_ms ?? 0) || 0,
        error: String(payload.error ?? '')
      });
    } else if (payload.type === 'speedtest_result') {
      fullResults.set(link, {
        link,
        reachable: Boolean(payload.reachable),
        average_download_mb_s: Number(payload.average_download_mb_s ?? 0) || 0,
        latency_ms: Number(payload.latency_ms ?? 0) || 0,
        error: String(payload.error ?? '')
      });
    }
  }
  return { probes, fullResults };
}

async function writeWorkerArtifacts(artifactDir: string, profile: PipelineProfile, renderedSource: string, artifacts: WorkerBuildArtifacts): Promise<string> {
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
  return bundleDir;
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
    skip_verify: Boolean(options.skipVerify || options.skipDeploy),
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
    const bundleDir = await writeWorkerArtifacts(artifactDir, profile, rendered.rendered_source, workerArtifacts);
    await setStage('obfuscate', 'success');

    if (options.skipDeploy) {
      await setStage('deploy', 'skipped');
    } else {
      await setStage('deploy', 'running');
      const deployment = context.stages?.deploy
        ? await context.stages.deploy({ projectRoot, bundleDir, profile })
        : await deployPagesWithBackend({ projectRoot, bundleDir, deploy: profile.deploy ?? {} }, { cwd: projectRoot, env });
      if (Number(deployment.returncode ?? 1) !== 0) {
        summary.deployment = safeDeployment(deployment);
        throw new Error(`Cloudflare deployment failed: ${JSON.stringify(summary.deployment)}`);
      }
      summary.deployment = safeDeployment(deployment);
      await setStage('deploy', 'success');
    }

    const effectiveSkipVerify = Boolean(options.skipVerify || options.skipDeploy);
    if (effectiveSkipVerify) {
      await setStage('verify', 'skipped');
    } else {
      await setStage('verify', 'running');
      const verification = context.stages?.verify
        ? await context.stages.verify({ projectRoot, profile, deployment: summary.deployment })
        : await verifyDeploymentWithBackend({ projectRoot, deploy: profile.deploy ?? {}, deployment: summary.deployment }, { cwd: projectRoot, env });
      summary.deployment = safeDeployment({ ...summary.deployment, ...verification });
      if (!isVerifySuccess(verification)) {
        throw new Error(`Verification failed: ${JSON.stringify(summary.deployment)}`);
      }
      await setStage('verify', 'success');
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

export async function retryNodePipelineStage(options: NodeRetryStageOptions, context: RunNodePipelineContext = {}): Promise<PipelineSummary> {
  const projectRoot = path.resolve(options.projectRoot);
  const sourceArtifactDir = path.resolve(options.artifactDir);
  if (!fs.existsSync(sourceArtifactDir)) {
    throw new Error(`artifact dir not found: ${sourceArtifactDir}`);
  }
  const stage = normalizeRetryStage(options.stage);
  const env = mergeProjectEnv(projectRoot, { ...process.env, ...(context.env ?? {}) });
  const runtimeStageEnv = defaultRuntimeStageEnv(env);
  const profile = await readProfile(projectRoot, env);
  const retryArtifactDir = await uniqueArtifactDir(resolveArtifactsRoot(projectRoot, env), formatTimestamp((context.now ?? (() => new Date()))()));
  const retryContext = {
    source_artifact_dir: sourceArtifactDir,
    source_artifact_name: path.basename(sourceArtifactDir),
    start_stage: stage
  };
  const summary = await seedRetryArtifact(
    sourceArtifactDir,
    retryArtifactDir,
    stage,
    retryContext,
    String(profile.worker_build?.bundle_subdir ?? 'pages_bundle')
  );

  const emit = (type: string, payload: Record<string, unknown> = {}) => {
    const event = { type, ...payload } as AutoVpnEvent;
    appendTextFile(options.eventLog, eventLogLine(event));
    appendTextFile(options.humanLog, humanLogLine(event));
    context.emit?.(event);
  };
  const writeReport = () => writeJson(retryArtifactDir, 'pipeline_report.json', summary);
  let activeStage: StageName | undefined;
  const setStage = async (stageName: StageName, status: StageStatus) => {
    summary.stage_status[stageName] = status;
    activeStage = status === 'running' ? stageName : activeStage === stageName ? undefined : activeStage;
    emit('stage', { stage: stageName, status });
    await writeReport();
  };

  const runtimePath = path.join(retryArtifactDir, 'runtime');
  let speedResults: SpeedTestResult[] = [];
  let availabilityResults: AvailabilityResultDict[] = [];
  let finalLinks: string[] = [];
  let bundleDir = path.join(retryArtifactDir, String(profile.worker_build?.bundle_subdir ?? 'pages_bundle'));

  emit('run_started', {
    artifact_dir: retryArtifactDir,
    skip_deploy: false,
    skip_verify: false,
    retry_stage: stage,
    source_artifact_dir: sourceArtifactDir
  });
  emit('log', { message: `[retry] source=${path.basename(sourceArtifactDir)} stage=${stage}` });

  try {
    if (stage === 'speedtest') {
      const dedupedLinks = await readLines(path.join(sourceArtifactDir, 'vpn_node_deduped.txt'));
      if (dedupedLinks.length === 0) {
        throw new Error('No deduped links available to retry speedtest');
      }
      summary.counts.raw_links = (await readLines(path.join(sourceArtifactDir, 'vpn_node_raw.txt'))).length;
      summary.counts.deduped_links = dedupedLinks.length;
      await setStage('speedtest', 'running');
      speedResults = context.stages?.speedtest
        ? await context.stages.speedtest(dedupedLinks, profile.speed_test ?? {}, runtimePath)
        : await speedtestLinksWithBackend({ links: dedupedLinks, config: profile.speed_test as any, runtime_path: runtimePath }, { cwd: projectRoot, env: runtimeStageEnv });
      const passedSpeedLinks = speedResults
        .filter((result) => result.reachable && result.average_download_mb_s >= Number(profile.speed_test?.min_download_mb_s ?? 0))
        .map((result) => result.link);
      summary.counts.speedtest_links = passedSpeedLinks.length;
      await writeLines(retryArtifactDir, 'vpn_node_speedtest.txt', passedSpeedLinks);
      await writeJson(retryArtifactDir, 'vpn_node_speedtest_report.json', speedResults);
      if (passedSpeedLinks.length === 0) {
        await setStage('speedtest', 'failed');
        summary.run_status = 'failed';
        summary.error = 'Error: No links passed speed test';
        await writeReport();
        throw new Error('No links passed speed test');
      }
      speedResults = speedResults.filter((result) => passedSpeedLinks.includes(result.link));
      await setStage('speedtest', 'success');
    } else {
      const passedSpeedLinks = new Set(await readLines(path.join(retryArtifactDir, 'vpn_node_speedtest.txt')));
      speedResults = (await readJson<SpeedTestResult[]>(path.join(retryArtifactDir, 'vpn_node_speedtest_report.json'), []))
        .filter((result) => passedSpeedLinks.has(result.link));
    }

    if (isStageAtOrAfter('availability', stage)) {
      if (speedResults.length === 0) {
        throw new Error('No speedtest results available to retry availability');
      }
      await setStage('availability', 'running');
      availabilityResults = context.stages?.availability
        ? await context.stages.availability(speedResults, profile.speed_test ?? {}, runtimePath, profile.availability_targets)
        : await checkLinkAvailabilityBatchWithBackend({
          results: speedResults,
          config: profile.speed_test ?? {},
          runtime_path: runtimePath,
          targets: profile.availability_targets as any
        }, { cwd: projectRoot, env: runtimeStageEnv });
      const availableLinks = availabilityResults.filter((result) => result.all_passed).map((result) => result.link);
      summary.counts.availability_links = availableLinks.length;
      await writeLines(retryArtifactDir, 'vpn_node_availability.txt', availableLinks);
      await writeJson(retryArtifactDir, 'vpn_node_availability_report.json', availabilityResults);
      if (availableLinks.length === 0) {
        await setStage('availability', 'failed');
        summary.run_status = 'failed';
        summary.error = 'Error: No links passed availability';
        await writeReport();
        throw new Error('No links passed availability');
      }
      await setStage('availability', 'success');
    } else if (isStageAtOrAfter(stage, 'postprocess')) {
      const availableLinks = new Set(await readLines(path.join(retryArtifactDir, 'vpn_node_availability.txt')));
      availabilityResults = (await readJson<AvailabilityResultDict[]>(path.join(retryArtifactDir, 'vpn_node_availability_report.json'), []))
        .filter((result) => availableLinks.has(result.link));
    }

    if (isStageAtOrAfter('postprocess', stage)) {
      if (availabilityResults.length === 0) {
        throw new Error('No availability inputs available to retry postprocess');
      }
      await setStage('postprocess', 'running');
      const speedResultByLink = new Map(speedResults.map((result) => [result.link, result]));
      const countryLookup = context.stages?.countryLookup ?? defaultCountryFor;
      const rankedLinks = availabilityResults.map((availabilityResult) => ({
        link: availabilityResult.link,
        country_code: countryLookup(availabilityResult.link, speedResultByLink.get(availabilityResult.link) ?? availabilityResult, availabilityResult)
      }));
      const postprocessed = context.stages?.countryLookup
        ? { links: rankedLinks.map((item) => decorateLinkWithCountry(item.link, item.country_code)) }
        : await postprocessLinksWithBackend({ ranked_links: rankedLinks, filters: profile.filters as any }, { cwd: projectRoot, env });
      finalLinks = postprocessed.links;
      summary.counts.final_links = finalLinks.length;
      summary.counts.postprocess_links = finalLinks.length;
      await writeLines(retryArtifactDir, 'vpn_node_emoji.txt', finalLinks);
      if (finalLinks.length === 0) {
        await setStage('postprocess', 'failed');
        summary.run_status = 'failed';
        summary.error = 'Error: No links remained after postprocess filters';
        await writeReport();
        throw new Error('No links remained after postprocess filters');
      }
      await setStage('postprocess', 'success');
    } else if (isStageAtOrAfter(stage, 'render')) {
      finalLinks = await readLines(path.join(retryArtifactDir, 'vpn_node_emoji.txt'));
    }

    if (isStageAtOrAfter('render', stage)) {
      if (finalLinks.length === 0) {
        throw new Error('No postprocess output available to retry render');
      }
      await setStage('render', 'running');
      const template = await readFile(path.join(projectRoot, 'templates', 'vmess_node.js'), 'utf8');
      const rendered = await renderMainDataWithBackend({ template, links: finalLinks }, { cwd: projectRoot, env });
      await writeFile(path.join(retryArtifactDir, 'vmess_node.js'), rendered.rendered_source, 'utf8');
      await setStage('render', 'success');
    }

    if (isStageAtOrAfter('obfuscate', stage)) {
      const renderedPath = path.join(retryArtifactDir, 'vmess_node.js');
      if (!fs.existsSync(renderedPath)) {
        throw new Error('No rendered template available to retry obfuscate');
      }
      await setStage('obfuscate', 'running');
      const renderedSource = await readFile(renderedPath, 'utf8');
      const secretQuery = String(profile.deploy?.secret_query ?? '');
      const workerArtifacts = context.stages?.obfuscate
        ? await context.stages.obfuscate({ transformedSource: renderedSource, config: profile.worker_build ?? {}, secretQuery })
        : await buildWorkerArtifactsWithBackend({
          rendered_source: renderedSource,
          config: profile.worker_build as any,
          secret_query: secretQuery
        }, { cwd: projectRoot, env });
      bundleDir = await writeWorkerArtifacts(retryArtifactDir, profile, renderedSource, workerArtifacts);
      await setStage('obfuscate', 'success');
    }

    if (isStageAtOrAfter('deploy', stage)) {
      if (!fs.existsSync(bundleDir)) {
        throw new Error('No Pages bundle available to retry deploy');
      }
      await setStage('deploy', 'running');
      const deployment = context.stages?.deploy
        ? await context.stages.deploy({ projectRoot, bundleDir, profile })
        : await deployPagesWithBackend({ projectRoot, bundleDir, deploy: profile.deploy ?? {} }, { cwd: projectRoot, env });
      if (Number(deployment.returncode ?? 1) !== 0) {
        summary.deployment = safeDeployment(deployment);
        throw new Error(`Cloudflare deployment failed: ${JSON.stringify(summary.deployment)}`);
      }
      summary.deployment = safeDeployment(deployment);
      await setStage('deploy', 'success');
    }

    if (isStageAtOrAfter('verify', stage)) {
      await setStage('verify', 'running');
      const verification = context.stages?.verify
        ? await context.stages.verify({ projectRoot, profile, deployment: summary.deployment })
        : await verifyDeploymentWithBackend({ projectRoot, deploy: profile.deploy ?? {}, deployment: summary.deployment }, { cwd: projectRoot, env });
      summary.deployment = safeDeployment({ ...summary.deployment, ...verification });
      if (!isVerifySuccess(verification)) {
        throw new Error(`Verification failed: ${JSON.stringify(summary.deployment)}`);
      }
      await setStage('verify', 'success');
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

  summary.run_status = 'success';
  summary.error = '';
  await writeReport();
  emit('summary', summary as unknown as Record<string, unknown>);
  return summary;
}

async function resumeNodeSpeedtest(options: NodeResumeOptions, context: RunNodePipelineContext = {}): Promise<PipelineSummary> {
  const projectRoot = path.resolve(options.projectRoot);
  const sessionDir = path.resolve(options.session);
  const sessionPath = path.join(sessionDir, 'session.json');
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`session.json not found: ${sessionPath}`);
  }
  const sessionPayload = await readJson<Record<string, unknown>>(sessionPath, {});
  const artifactDirRaw = String(sessionPayload.artifact_dir ?? '').trim();
  if (!artifactDirRaw) {
    throw new Error(`session artifact_dir is required: ${sessionPath}`);
  }
  const artifactDir = path.resolve(artifactDirRaw);
  if (!artifactDir || !fs.existsSync(artifactDir)) {
    throw new Error(`artifact dir not found: ${artifactDir}`);
  }

  const eventLog = options.eventLog ?? String(sessionPayload.event_log ?? path.join(sessionDir, 'events.jsonl'));
  const resumeEventLog = String(sessionPayload.event_log ?? path.join(sessionDir, 'events.jsonl'));
  const humanLog = options.humanLog ?? String(sessionPayload.human_log ?? path.join(sessionDir, 'human.log'));
  const env = mergeProjectEnv(projectRoot, { ...process.env, ...(context.env ?? {}) });
  const profile = await readProfile(projectRoot, env);
  const report = await readJson<Record<string, unknown>>(path.join(artifactDir, 'pipeline_report.json'), {});
  const summary = pipelineSummaryFromReport(artifactDir, report);
  const runtimePath = path.join(artifactDir, 'runtime');

  const emit = (type: string, payload: Record<string, unknown> = {}) => {
    const event = { type, ...payload } as AutoVpnEvent;
    appendTextFile(eventLog, eventLogLine(event));
    appendTextFile(humanLog, humanLogLine(event));
    context.emit?.(event);
  };
  const writeReport = () => writeJson(artifactDir, 'pipeline_report.json', summary);
  const setStage = async (stageName: StageName, status: StageStatus) => {
    summary.stage_status[stageName] = status;
    emit('stage', { stage: stageName, status });
    await writeReport();
  };

  const rawLinks = await readLines(path.join(artifactDir, 'vpn_node_raw.txt'));
  const dedupedLinks = await readLines(path.join(artifactDir, 'vpn_node_deduped.txt'));
  summary.counts.raw_links = rawLinks.length;
  summary.counts.deduped_links = dedupedLinks.length;
  for (const baseStage of ['doctor', 'extract', 'dedupe'] as StageName[]) {
    if (summary.stage_status[baseStage] === 'pending') {
      summary.stage_status[baseStage] = 'success';
    }
  }

  const { probes, fullResults } = await speedtestResumeStateFromEventLog(resumeEventLog);
  emit('speedtest_resume_state', {
    resumed_probe_count: probes.size,
    resumed_full_count: fullResults.size,
    total_links: dedupedLinks.length
  });
  emit('log', { message: `[resume] speedtest resume from probe=${probes.size}/${dedupedLinks.length} full=${fullResults.size}` });

  try {
    await setStage('speedtest', 'running');
    const speedConfig = normalizeSpeedTestConfig(profile.speed_test as any);
    const requestedRuntime = String(env.AUTOVPN_SPEEDTEST_RUNTIME ?? '').trim().toLowerCase();
    const usingInjectedSpeedtestStages = Boolean(context.stages?.speedtestProbe && context.stages?.speedtestLink);
    if (requestedRuntime !== 'mihomo' && !usingInjectedSpeedtestStages) {
      throw new Error('Node resume speedtest requires AUTOVPN_SPEEDTEST_RUNTIME=mihomo');
    }
    const remainingProbeLinks = dedupedLinks.filter((link) => !probes.has(link));
    if (remainingProbeLinks.length > 0) {
      const probeResults = context.stages?.speedtestProbe
        ? await context.stages.speedtestProbe(remainingProbeLinks, profile.speed_test ?? {}, runtimePath)
        : await probeSpeedtestLinksInNode({ links: remainingProbeLinks, config: profile.speed_test as any, runtime_path: runtimePath }, { cwd: projectRoot, env });
      for (let index = 0; index < probeResults.length; index += 1) {
        const result = probeResults[index];
        probes.set(result.link, result);
        const completed = probes.size;
        emit('log', { message: `[speedtest:probe] ${completed}/${dedupedLinks.length} reachable=${result.reachable} latency=${result.latency_ms}ms` });
        emit('speedtest_probe_result', {
          completed,
          total: dedupedLinks.length,
          link: result.link,
          reachable: result.reachable,
          latency_ms: result.latency_ms,
          error: result.error ?? ''
        });
      }
    }

    const orderedProbes = dedupedLinks.map((link) => probes.get(link)).filter((result): result is ProbeResult => Boolean(result));
    const candidateLinks = selectSpeedtestCandidates(orderedProbes, speedConfig.max_download_candidates);
    const reachableCount = orderedProbes.filter((probe) => probe.reachable).length;
    emit('log', { message: `[speedtest] selected ${candidateLinks.length}/${reachableCount} reachable links for full download test` });
    emit('speedtest_selected', {
      total_links: dedupedLinks.length,
      reachable_count: reachableCount,
      candidate_count: candidateLinks.length
    });

    const remainingFullLinks = candidateLinks.filter((link) => !fullResults.has(link));
    await forEachWithConcurrency(remainingFullLinks, speedConfig.concurrency, async (link) => {
      const result = context.stages?.speedtestLink
        ? await context.stages.speedtestLink(link, profile.speed_test ?? {}, runtimePath)
        : await testSpeedtestLinkInNode({ link, config: profile.speed_test as any, runtime_path: runtimePath }, { cwd: projectRoot, env });
      if (result.reachable && result.latency_ms <= 0) {
        result.latency_ms = probes.get(result.link)?.latency_ms ?? 0;
      }
      fullResults.set(result.link, result);
      const completed = fullResults.size;
      const passedThreshold = result.reachable && result.average_download_mb_s >= speedConfig.min_download_mb_s;
      emit('log', { message: `[speedtest] ${completed}/${candidateLinks.length} reachable=${result.reachable} speed=${result.average_download_mb_s}MB/s` });
      emit('speedtest_result', {
        completed,
        total: candidateLinks.length,
        link: result.link,
        reachable: result.reachable,
        average_download_mb_s: result.average_download_mb_s,
        latency_ms: result.latency_ms,
        passed_threshold: passedThreshold,
        error: result.error ?? ''
      });
    });

    const orderedFullResults = candidateLinks.map((link) => fullResults.get(link)).filter((result): result is SpeedTestResult => Boolean(result));
    const fastResults = orderedFullResults
      .filter((result) => result.reachable && result.average_download_mb_s >= speedConfig.min_download_mb_s)
      .sort((left, right) => right.average_download_mb_s - left.average_download_mb_s);
    await writeLines(artifactDir, 'vpn_node_speedtest.txt', fastResults.map((result) => result.link));
    await writeJson(artifactDir, 'vpn_node_speedtest_report.json', fastResults);
    summary.counts.speedtest_links = fastResults.length;
    emit('log', { message: `[speedtest] kept ${fastResults.length} links above threshold` });

    if (fastResults.length === 0) {
      await setStage('speedtest', 'failed');
      summary.run_status = 'failed';
      summary.error = 'Error: No links passed speed test';
      await writeReport();
      throw new Error('No links passed speed test');
    }

    await setStage('speedtest', 'success');
    summary.run_status = 'success';
    summary.error = '';
    await writeReport();
    emit('summary', summary as unknown as Record<string, unknown>);
    return summary;
  } catch (error) {
    summary.run_status = 'failed';
    summary.error = errorMessage(error);
    if (summary.stage_status.speedtest === 'running') {
      summary.stage_status.speedtest = 'failed';
      emit('stage', { stage: 'speedtest', status: 'failed' });
    }
    await writeReport();
    emit('summary', summary as unknown as Record<string, unknown>);
    emit('run_failed', { error: summary.error });
    throw error;
  }
}

export async function resumeNodePipeline(options: NodeResumeOptions, context: RunNodePipelineContext = {}): Promise<PipelineSummary> {
  if (options.mode === 'speedtest') {
    return resumeNodeSpeedtest(options, context);
  }
  const projectRoot = path.resolve(options.projectRoot);
  const sessionDir = path.resolve(options.session);
  const sessionPath = path.join(sessionDir, 'session.json');
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`session.json not found: ${sessionPath}`);
  }
  const sessionPayload = await readJson<Record<string, unknown>>(sessionPath, {});
  const artifactDirRaw = String(sessionPayload.artifact_dir ?? '').trim();
  if (!artifactDirRaw) {
    throw new Error(`session artifact_dir is required: ${sessionPath}`);
  }
  const artifactDir = path.resolve(artifactDirRaw);
  if (!artifactDir || !fs.existsSync(artifactDir)) {
    throw new Error(`artifact dir not found: ${artifactDir}`);
  }

  const eventLog = options.eventLog ?? String(sessionPayload.event_log ?? path.join(sessionDir, 'events.jsonl'));
  const humanLog = options.humanLog ?? String(sessionPayload.human_log ?? path.join(sessionDir, 'human.log'));
  const env = mergeProjectEnv(projectRoot, { ...process.env, ...(context.env ?? {}) });
  const runtimeStageEnv = defaultRuntimeStageEnv(env);
  const profile = await readProfile(projectRoot, env);
  const report = await readJson<Record<string, unknown>>(path.join(artifactDir, 'pipeline_report.json'), {});
  const summary = pipelineSummaryFromReport(artifactDir, report);
  const runtimePath = path.join(artifactDir, 'runtime');

  const emit = (type: string, payload: Record<string, unknown> = {}) => {
    const event = { type, ...payload } as AutoVpnEvent;
    appendTextFile(eventLog, eventLogLine(event));
    appendTextFile(humanLog, humanLogLine(event));
    context.emit?.(event);
  };
  const writeReport = () => writeJson(artifactDir, 'pipeline_report.json', summary);
  let activeStage: StageName | undefined;
  const setStage = async (stageName: StageName, status: StageStatus) => {
    summary.stage_status[stageName] = status;
    activeStage = status === 'running' ? stageName : activeStage === stageName ? undefined : activeStage;
    emit('stage', { stage: stageName, status });
    await writeReport();
  };

  const rawLinks = await readLines(path.join(artifactDir, 'vpn_node_raw.txt'));
  const dedupedLinks = await readLines(path.join(artifactDir, 'vpn_node_deduped.txt'));
  const speedtestLinks = await readLines(path.join(artifactDir, 'vpn_node_speedtest.txt'));
  const speedResults = await restoreResumeSpeedResults(artifactDir, eventLog, speedtestLinks);
  summary.counts.raw_links = rawLinks.length;
  summary.counts.deduped_links = dedupedLinks.length;
  summary.counts.speedtest_links = speedResults.length;

  try {
    if (speedResults.length === 0) {
      summary.stage_status.speedtest = 'failed';
      throw new Error('No speedtest results available to continue pipeline');
    }
    for (const baseStage of ['doctor', 'extract', 'dedupe', 'speedtest'] as StageName[]) {
      if (summary.stage_status[baseStage] === 'pending' || summary.stage_status[baseStage] === 'failed') {
        summary.stage_status[baseStage] = 'success';
      }
    }
    emit('resume_pipeline_state', {
      speedtest_links: speedResults.length,
      artifact_dir: artifactDir
    });
    emit('log', { message: `[resume] continue pipeline from speedtest_links=${speedResults.length}` });
    await writeReport();

    await setStage('availability', 'running');
    const availabilityResults = context.stages?.availability
      ? await context.stages.availability(speedResults, profile.speed_test ?? {}, runtimePath, profile.availability_targets)
      : await checkLinkAvailabilityBatchWithBackend({
        results: speedResults,
        config: profile.speed_test ?? {},
        runtime_path: runtimePath,
        targets: profile.availability_targets as any
      }, { cwd: projectRoot, env: runtimeStageEnv });
    const availableLinks = availabilityResults.filter((result) => result.all_passed).map((result) => result.link);
    summary.counts.availability_links = availableLinks.length;
    await writeLines(artifactDir, 'vpn_node_availability.txt', availableLinks);
    await writeJson(artifactDir, 'vpn_node_availability_report.json', availabilityResults);
    if (availableLinks.length === 0) {
      await setStage('availability', 'failed');
      summary.run_status = 'failed';
      summary.error = 'Error: No links passed availability';
      await writeReport();
      throw new Error('No links passed availability');
    }
    await setStage('availability', 'success');

    await setStage('postprocess', 'running');
    const speedResultByLink = new Map(speedResults.map((result) => [result.link, result]));
    const availabilityByLink = new Map(availabilityResults.map((result) => [result.link, result]));
    const countryLookup = context.stages?.countryLookup ?? defaultCountryFor;
    const rankedLinks = availableLinks.map((link) => ({
      link,
      country_code: countryLookup(link, speedResultByLink.get(link) as SpeedTestResult, availabilityByLink.get(link) as AvailabilityResultDict)
    }));
    const postprocessed = context.stages?.countryLookup
      ? { links: rankedLinks.map((item) => decorateLinkWithCountry(item.link, item.country_code)) }
      : await postprocessLinksWithBackend({ ranked_links: rankedLinks, filters: profile.filters as any }, { cwd: projectRoot, env });
    summary.counts.postprocess_links = postprocessed.links.length;
    summary.counts.final_links = postprocessed.links.length;
    await writeLines(artifactDir, 'vpn_node_emoji.txt', postprocessed.links);
    if (postprocessed.links.length === 0) {
      await setStage('postprocess', 'failed');
      summary.run_status = 'failed';
      summary.error = 'Error: No links remained after postprocess filters';
      await writeReport();
      throw new Error('No links remained after postprocess filters');
    }
    await setStage('postprocess', 'success');

    await setStage('render', 'running');
    const template = await readFile(path.join(projectRoot, 'templates', 'vmess_node.js'), 'utf8');
    const rendered = await renderMainDataWithBackend({ template, links: postprocessed.links }, { cwd: projectRoot, env });
    await writeFile(path.join(artifactDir, 'vmess_node.js'), rendered.rendered_source, 'utf8');
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
    const bundleDir = await writeWorkerArtifacts(artifactDir, profile, rendered.rendered_source, workerArtifacts);
    await setStage('obfuscate', 'success');

    await setStage('deploy', 'running');
    const deployment = context.stages?.deploy
      ? await context.stages.deploy({ projectRoot, bundleDir, profile })
      : await deployPagesWithBackend({ projectRoot, bundleDir, deploy: profile.deploy ?? {} }, { cwd: projectRoot, env });
    if (Number(deployment.returncode ?? 1) !== 0) {
      summary.deployment = safeDeployment(deployment);
      throw new Error(`Cloudflare deployment failed: ${JSON.stringify(summary.deployment)}`);
    }
    summary.deployment = safeDeployment(deployment);
    await setStage('deploy', 'success');

    await setStage('verify', 'running');
    const verification = context.stages?.verify
      ? await context.stages.verify({ projectRoot, profile, deployment: summary.deployment })
      : await verifyDeploymentWithBackend({ projectRoot, deploy: profile.deploy ?? {}, deployment: summary.deployment }, { cwd: projectRoot, env });
    summary.deployment = safeDeployment({ ...summary.deployment, ...verification });
    if (!isVerifySuccess(verification)) {
      throw new Error(`Verification failed: ${JSON.stringify(summary.deployment)}`);
    }
    await setStage('verify', 'success');
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

  summary.run_status = 'success';
  summary.error = '';
  await writeReport();
  emit('summary', summary as unknown as Record<string, unknown>);
  return summary;
}
