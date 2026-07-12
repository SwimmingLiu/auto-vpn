import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@iarna/toml';

import { AutoVpnEvent } from '../events/schema.js';
import { mergeProjectEnv } from '../runtime/env.js';
import { resolveArtifactsRoot, resolveProfilePath } from '../runtime/paths.js';
import { redactText } from '../runtime/redaction.js';
import { resolveWorkerTemplatePath } from '../runtime/templates.js';
import { fetchSourceLinksWithBackend, ExtractedSourceResult, SourceConfigInput } from './extract.js';
import { canonicalVmessKey, parseVmessLink } from './dedupe.js';
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
import { RunStore, readLatestStageStatuses } from './run-store.js';
import { AsyncPermitPool, BoundedWorkerPool } from './streaming-coordinator.js';
import { createGeoIpLookup, GeoIpLookupOptions } from './geoip.js';

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
  run_status: 'running' | 'success' | 'failed' | 'stopped';
  error: string;
}

export interface NodePipelineStageOverrides {
  extract?: (input: { source_name: string; source: SourceConfigInput }, stream?: { onLinks: (links: string[]) => Promise<void> }) => ExtractedSourceResult | Promise<ExtractedSourceResult>;
  speedtest?: (links: string[], config: Record<string, unknown>, runtimePath: string) => SpeedTestResult[] | Promise<SpeedTestResult[]>;
  speedtestProbe?: (links: string[], config: Record<string, unknown>, runtimePath: string) => ProbeResult[] | Promise<ProbeResult[]>;
  speedtestLink?: (link: string, config: Record<string, unknown>, runtimePath: string) => SpeedTestResult | Promise<SpeedTestResult>;
  availability?: (results: SpeedTestResult[], config: Record<string, unknown>, runtimePath: string, targets: unknown) => AvailabilityResultDict[] | Promise<AvailabilityResultDict[]>;
  countryLookup?: (link: string, speedResult: SpeedTestResult, availabilityResult: AvailabilityResultDict) => string | Promise<string>;
  obfuscate?: (input: { transformedSource: string; config: Record<string, unknown>; secretQuery: string }) => WorkerBuildArtifacts | Promise<WorkerBuildArtifacts>;
  deploy?: (input: { projectRoot: string; bundleDir: string; profile: PipelineProfile }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  verify?: (input: { projectRoot: string; profile: PipelineProfile; deployment: Record<string, unknown> }) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface RunNodePipelineContext {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  emit?: (event: AutoVpnEvent) => void;
  stages?: NodePipelineStageOverrides;
  geoIp?: GeoIpLookupOptions;
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

function speedtestFailureMessage(results: SpeedTestResult[], minDownloadMbS: number): string {
  const reachable = results.filter((result) => result.reachable);
  if (reachable.length === 0) {
    return 'No links passed speed test';
  }
  const bestSpeed = Math.max(...reachable.map((result) => Number(result.average_download_mb_s) || 0));
  return `No links met minimum speed threshold ${minDownloadMbS}MB/s; best speed was ${bestSpeed}MB/s`;
}

function deployMinimumFinalLinks(profile: PipelineProfile): number {
  const raw = Number(profile.deploy?.min_final_links ?? 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 10;
  }
  return Math.trunc(raw);
}

function assertDeployMinimumFinalLinks(profile: PipelineProfile, finalLinks: string[]): void {
  const minimum = deployMinimumFinalLinks(profile);
  if (minimum > 0 && finalLinks.length < minimum) {
    throw new Error(`final node count ${finalLinks.length} is below deploy minimum ${minimum}`);
  }
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
  return { ...env };
}

function createCountryLookup(context: RunNodePipelineContext): NodePipelineStageOverrides['countryLookup'] {
  if (context.stages?.countryLookup) return context.stages.countryLookup;
  const lookup = createGeoIpLookup(context.geoIp);
  return async (link) => {
    try {
      return lookup(String(parseVmessLink(link).add ?? ''));
    } catch {
      return 'US';
    }
  };
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
    run_status: 'running',
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
    run_status: ['running', 'success', 'failed', 'stopped'].includes(String(report.run_status ?? ''))
      ? String(report.run_status) as PipelineSummary['run_status']
      : 'running',
    error: String(report.error ?? '')
  };
}

function refreshSourceCounts(summary: PipelineSummary, store: RunStore): void {
  const rawCounts = store.sourceRawCounts();
  const dedupedCounts = store.sourceDedupedCounts();
  const progressSources = store.sourceProgress().map((progress) => progress.source);
  for (const source of new Set([...Object.keys(summary.source_counts), ...progressSources, ...Object.keys(rawCounts), ...Object.keys(dedupedCounts)])) {
    summary.source_counts[source] = {
      ...(summary.source_counts[source] ?? {}),
      raw_links: rawCounts[source] ?? 0,
      deduped_links: dedupedCounts[source] ?? 0
    };
  }
}

function passedSpeedResults(allResults: SpeedTestResult[], passedLinks: string[]): SpeedTestResult[] {
  const byLink = new Map(allResults.map((result) => [result.link, result]));
  return passedLinks
    .map((link) => byLink.get(link))
    .filter((result): result is SpeedTestResult => Boolean(result))
    .sort((left, right) => right.average_download_mb_s - left.average_download_mb_s);
}

export function validateSpeedResumeProbeBatch(requestedLinks: string[], results: ProbeResult[]): void {
  const requested = new Set(requestedLinks);
  const seen = new Set<string>();
  if (results.length !== requestedLinks.length) throw new Error('speedtest probe adapter must return exactly one result per requested link');
  for (const result of results) {
    if (!requested.has(result.link) || seen.has(result.link)) throw new Error('speedtest probe adapter returned duplicate, extra, or wrong link');
    seen.add(result.link);
  }
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
  let failed = false;
  let firstError: unknown;
  const workerCount = Math.max(1, Math.min(Math.max(1, Math.floor(concurrency)), items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length && !failed) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await mapper(items[index]);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  });
  await Promise.allSettled(workers);
  if (failed) {
    throw firstError;
  }
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
  const runStore = RunStore.open(path.join(artifactDir, 'run.db'));
  try {
    runStore.initializeRun('running');
  const summary: PipelineSummary = {
    artifact_dir: artifactDir,
    stage_status: stageStatus(),
    counts: {},
    source_counts: {},
    deployment: {},
    retry_context: {},
    run_status: 'running',
    error: ''
  };

  let emitFailure: unknown;
  let handlingFailure = false;
  const emit = (type: string, payload: Record<string, unknown> = {}) => {
    const event = { type, ...payload } as AutoVpnEvent;
    appendTextFile(options.eventLog, eventLogLine(event));
    appendTextFile(options.humanLog, humanLogLine(event));
    try { context.emit?.(event); } catch (error) { emitFailure ??= error; }
  };
  const writeReport = () => writeJson(artifactDir, 'pipeline_report.json', summary);
  let activeStage: StageName | undefined;
  let activeSpeedPool: BoundedWorkerPool<string> | undefined;
  let activeAvailabilityPool: BoundedWorkerPool<SpeedTestResult> | undefined;
  const setStage = async (stage: StageName, status: StageStatus, trackActive = true) => {
    summary.stage_status[stage] = status;
    if (trackActive) {
      activeStage = status === 'running' ? stage : activeStage === stage ? undefined : activeStage;
    }
    emit('stage', { stage, status });
    runStore.setStageStatus(stage, status === 'failed' ? 'failed' : status);
    await writeReport();
    if (!handlingFailure && emitFailure) throw emitFailure;
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

    const sourcesToRun = enabledSources(profile);
    const runtimePath = path.join(artifactDir, 'runtime');
    const speedConfig = normalizeSpeedTestConfig(profile.speed_test as any);
    // Preserve cross-stage streaming even for concurrency=1 while preventing
    // the independent speed and availability pools from doubling larger limits.
    const runtimePermits = new AsyncPermitPool(Math.max(2, speedConfig.concurrency));
    const useStreamingStages = !context.stages?.speedtest || Boolean(context.stages.speedtestLink);
    let rawLinks: string[] = [];
    let dedupedLinks: string[] = [];
    let speedResults: SpeedTestResult[] = [];
    let passedSpeedLinks: string[] = [];
    let availabilityResults: AvailabilityResultDict[] = [];
    let availableLinks: string[] = [];
    let speedCompleted = 0;
    let availabilityCompletedStreaming = 0;
    let dedupeStageStart: Promise<void> | undefined;
    let speedStageStart: Promise<void> | undefined;
    let availabilityStageStart: Promise<void> | undefined;
    const ensureDedupeStageStarted = () => dedupeStageStart ??= setStage('dedupe', 'running', false);
    const ensureSpeedStageStarted = () => speedStageStart ??= setStage('speedtest', 'running', false);
    const ensureAvailabilityStageStarted = () => availabilityStageStart ??= setStage('availability', 'running', false);
    const availabilityPool = activeAvailabilityPool = new BoundedWorkerPool<SpeedTestResult>({
      concurrency: speedConfig.concurrency,
      capacity: speedConfig.concurrency * 2,
      worker: async (speedResult) => {
        runStore.markAvailabilityRunning(speedResult.link);
        let results: AvailabilityResultDict[];
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          results = await runtimePermits.run(async () => context.stages?.availability
            ? await context.stages.availability([speedResult], profile.speed_test ?? {}, runtimePath, profile.availability_targets)
            : await checkLinkAvailabilityBatchWithBackend({ results: [speedResult], config: profile.speed_test ?? {}, runtime_path: runtimePath, targets: profile.availability_targets as any }, { cwd: projectRoot, env: runtimeStageEnv }));
          if (results.length !== 1 || results[0].link !== speedResult.link) throw new Error('availability adapter must return exactly one matching result');
        } catch (error) {
          runStore.recordAvailabilityResult({ link: speedResult.link, all_passed: false, provider_results: {}, error: errorMessage(error) });
          throw error;
        }
        for (const result of results) {
          runStore.recordAvailabilityResult(result);
          availabilityCompletedStreaming += 1;
          const eligibleTotal = runStore.speedResults().filter((entry) => entry.status === 'speed_passed').length;
          emit('availability_link_result', { completed: availabilityCompletedStreaming, total: eligibleTotal, link: result.link, all_passed: result.all_passed, provider_results: result.provider_results });
          emit('log', { message: `[availability] ${availabilityCompletedStreaming}/${eligibleTotal}` });
        }
      }
    });
    const speedPool = activeSpeedPool = new BoundedWorkerPool<string>({
      concurrency: speedConfig.concurrency,
      capacity: speedConfig.concurrency * 2,
      worker: async (link) => {
        runStore.markSpeedRunning(link);
        let probes: ProbeResult[];
        try {
          probes = await runtimePermits.run(async () => context.stages?.speedtestProbe
            ? await context.stages.speedtestProbe([link], profile.speed_test ?? {}, runtimePath)
            : await probeSpeedtestLinksInNode({ links: [link], config: profile.speed_test as any, runtime_path: runtimePath }, { cwd: projectRoot, env: runtimeStageEnv, progressCallback: (message) => emit('log', { message }), eventCallback: (type, payload) => emit(type, payload) }));
          if (probes.length !== 1 || probes[0].link !== link) throw new Error('speedtest probe adapter must return exactly one matching result');
        } catch (error) {
          const failed = { link, reachable: false, latency_ms: 0, error: errorMessage(error) };
          runStore.recordProbe(failed);
          runStore.recordSpeedResult({ ...failed, average_download_mb_s: 0 }, false);
          throw error;
        }
        const probe = probes[0];
        runStore.recordProbe(probe);
        emit('speedtest_probe_result', { completed: runStore.counts().probes, total: runStore.counts().deduped, link, reachable: probe.reachable, latency_ms: probe.latency_ms, error: probe.error ?? '' });
        let result: SpeedTestResult = { link, reachable: false, average_download_mb_s: 0, latency_ms: probe.latency_ms, error: probe.error ?? '' };
        if (probe.reachable) {
          try {
            result = await runtimePermits.run(async () => context.stages?.speedtestLink
              ? await context.stages.speedtestLink(link, profile.speed_test ?? {}, runtimePath)
              : await testSpeedtestLinkInNode({ link, config: profile.speed_test as any, runtime_path: runtimePath }, { cwd: projectRoot, env: runtimeStageEnv }));
            if (result.link !== link) throw new Error('speedtest link adapter must return a matching result');
          } catch (error) {
            runStore.recordSpeedResult({ link, reachable: false, average_download_mb_s: 0, latency_ms: probe.latency_ms, error: errorMessage(error) }, false);
            throw error;
          }
          if (result.latency_ms <= 0) result.latency_ms = probe.latency_ms;
        }
        const passed = result.reachable && result.average_download_mb_s >= speedConfig.min_download_mb_s;
        runStore.recordSpeedResult(result, passed);
        speedCompleted += 1;
        emit('speedtest_result', { completed: speedCompleted, total: runStore.counts().deduped, link, reachable: result.reachable, average_download_mb_s: result.average_download_mb_s, latency_ms: result.latency_ms, passed_threshold: passed, error: result.error ?? '' });
        emit('log', { message: `[speedtest] ${speedCompleted}/${runStore.counts().deduped} reachable=${result.reachable} speed=${result.average_download_mb_s}MB/s` });
        if (passed) {
          await ensureAvailabilityStageStarted();
          await availabilityPool.submit(result);
        }
      }
    });

    const onExtractedLinks = async (sourceName: string, links: string[]): Promise<void> => {
      for (const link of links) {
        await ensureDedupeStageStarted();
        const recorded = runStore.recordExtractedNode(sourceName, link);
        if (recorded.inserted) {
          await ensureSpeedStageStarted();
          await speedPool.submit(link);
        }
      }
    };

    await setStage('extract', 'running');
    if (useStreamingStages) {
      const requestedRuntime = String(runtimeStageEnv.AUTOVPN_SPEEDTEST_RUNTIME ?? '').trim().toLowerCase();
      emit('speedtest_runtime', { runtime_core: requestedRuntime === 'direct' ? 'direct' : 'mihomo', probe_url: speedConfig.probe_url, urls: [...speedConfig.urls] });
      emit('log', { message: `[speedtest] runtime_core=${requestedRuntime === 'direct' ? 'direct' : 'mihomo'} probe_url=${speedConfig.probe_url}` });
    }
    const extractSettled = await Promise.allSettled(sourcesToRun.map(async ([sourceName, source]) => {
      runStore.recordSourceProgress(sourceName, { processed: 0, total: 0, status: 'running' });
      const streamedLinks = new Set<string>();
      const stream = useStreamingStages
        ? {
            onLinks: async (links: string[]) => {
              for (const link of links) {
                streamedLinks.add(link);
              }
              await onExtractedLinks(sourceName, links);
            }
          }
        : undefined;
      let result: ExtractedSourceResult;
      try {
        result = context.stages?.extract
          ? await context.stages.extract({ source_name: sourceName, source }, stream)
          : await fetchSourceLinksWithBackend({ source_name: sourceName, source }, {
            cwd: projectRoot,
            env: runtimeStageEnv,
            eventCallback: (type, payload) => emit(type, payload),
            linksCallback: stream?.onLinks
          });
      } catch (error) {
        runStore.recordSourceProgress(sourceName, { processed: 0, total: 0, status: 'failed', error: errorMessage(error) });
        throw error;
      }
      if (useStreamingStages && stream) {
        const missingLinks = result.links.filter((link) => !streamedLinks.has(link));
        if (missingLinks.length > 0) {
          await stream.onLinks(missingLinks);
        }
      }
      summary.source_counts[result.source_name] = {
        raw_links: result.links.length,
        successful_iterations: result.successful_iterations,
        failed_iterations: result.failed_iterations
      };
      runStore.recordSourceProgress(sourceName, {
        processed: result.requested_iterations,
        total: result.requested_iterations,
        status: 'success'
      });
      return result;
    }));
    const failedExtraction = extractSettled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failedExtraction) throw failedExtraction.reason;
    const extractResults = extractSettled.map((result) => (result as PromiseFulfilledResult<ExtractedSourceResult>).value);
    if (!useStreamingStages) {
      rawLinks = extractResults.flatMap((result) => result.links);
      for (const result of extractResults) {
        for (const link of result.links) {
          await ensureDedupeStageStarted();
          runStore.recordExtractedNode(result.source_name, link);
        }
      }
    } else {
      rawLinks = runStore.rawLinks();
      dedupedLinks = runStore.dedupedLinks();
    }
    if (sourcesToRun.length > 0 && rawLinks.length === 0 && extractResults.some((result) => result.requested_iterations > 0 || result.failed_iterations > 0)) {
      await setStage('dedupe', 'skipped', false);
      await setStage('speedtest', 'skipped', false);
      await setStage('availability', 'skipped', false);
      throw new Error('No links extracted from configured sources');
    }
    summary.counts.raw_links = runStore.counts().raw;
    await writeLines(artifactDir, 'vpn_node_raw.txt', rawLinks);
    await setStage('extract', 'success');

    if (!dedupeStageStart) await setStage('dedupe', 'skipped', false);
    dedupedLinks = runStore.dedupedLinks();
    summary.counts.deduped_links = runStore.counts().deduped;
    refreshSourceCounts(summary, runStore);
    await writeLines(artifactDir, 'vpn_node_deduped.txt', dedupedLinks);
    if (summary.stage_status.dedupe !== 'skipped') await setStage('dedupe', 'success', !useStreamingStages);

    if (useStreamingStages) {
      if (!speedStageStart) await setStage('speedtest', 'skipped', false);
      speedPool.close();
      await speedPool.drain();
      if (!availabilityStageStart) await setStage('availability', 'skipped', false);
      availabilityPool.close();
      await availabilityPool.drain();
      speedResults = runStore.speedResults().map(({ status: _status, ...result }) => result);
      passedSpeedLinks = runStore.speedResults().filter((result) => result.status === 'speed_passed').map((result) => result.link);
      const storedSpeedByLink = new Map(speedResults.map((result) => [result.link, result]));
      availabilityResults = runStore.availabilityResults().map(({ status: _status, error: _error, ...result }) => ({
        ...(storedSpeedByLink.get(result.link) as SpeedTestResult),
        ...result
      } as AvailabilityResultDict));
    }

    if (!useStreamingStages && summary.stage_status.speedtest !== 'running') {
      await setStage('speedtest', dedupedLinks.length > 0 ? 'running' : 'skipped');
    }
    if (!useStreamingStages && dedupedLinks.length > 0) {
      speedResults = context.stages?.speedtest
        ? await context.stages.speedtest(dedupedLinks, profile.speed_test ?? {}, runtimePath)
        : await speedtestLinksWithBackend({ links: dedupedLinks, config: profile.speed_test as any, runtime_path: runtimePath }, {
          cwd: projectRoot,
          env: runtimeStageEnv,
          progressCallback: (message) => emit('log', { message }),
          eventCallback: (type, payload) => emit(type, payload)
        });
      passedSpeedLinks = speedResults
        .filter((result) => result.reachable && result.average_download_mb_s >= Number(profile.speed_test?.min_download_mb_s ?? 0))
        .map((result) => result.link);
      for (const result of speedResults) {
        runStore.recordProbe({ link: result.link, reachable: result.reachable, latency_ms: result.latency_ms, error: result.error ?? '' });
        runStore.recordSpeedResult(result, passedSpeedLinks.includes(result.link));
      }
      speedResults = runStore.speedResults().map(({ status: _status, ...result }) => result);
      passedSpeedLinks = runStore.speedResults().filter((result) => result.status === 'speed_passed').map((result) => result.link);
    }
    summary.counts.speedtest_links = runStore.speedResults().filter((result) => result.status === 'speed_passed').length;
    await writeLines(artifactDir, 'vpn_node_speedtest.txt', passedSpeedLinks);
    await writeJson(artifactDir, 'vpn_node_speedtest_report.json', speedResults);
    if (dedupedLinks.length > 0 && passedSpeedLinks.length === 0) {
      if (!useStreamingStages && summary.stage_status.availability === 'pending') {
        await setStage('availability', 'skipped', false);
      }
      throw new Error(speedtestFailureMessage(speedResults, Number(profile.speed_test?.min_download_mb_s ?? 0)));
    }
    if (summary.stage_status.speedtest !== 'skipped') await setStage('speedtest', 'success');

    if (!useStreamingStages && summary.stage_status.availability !== 'running') {
      await setStage('availability', passedSpeedLinks.length > 0 ? 'running' : 'skipped');
    }
    const speedResultByLink = new Map(speedResults.map((result) => [result.link, result]));
    const candidateSpeedResults = passedSpeedLinks.map((link) => speedResultByLink.get(link)).filter((result): result is SpeedTestResult => Boolean(result));
    availabilityResults = useStreamingStages || passedSpeedLinks.length === 0
      ? availabilityResults
      : context.stages?.availability
      ? await context.stages.availability(candidateSpeedResults, profile.speed_test ?? {}, runtimePath, profile.availability_targets)
      : await checkLinkAvailabilityBatchWithBackend({
        results: candidateSpeedResults,
        config: profile.speed_test ?? {},
        runtime_path: runtimePath,
        targets: profile.availability_targets as any
      }, {
        cwd: projectRoot,
        env: runtimeStageEnv,
        progressCallback: (message) => emit('log', { message }),
        eventCallback: (type, payload) => emit(type, payload)
      });
    if (!useStreamingStages) {
      for (const result of availabilityResults) runStore.recordAvailabilityResult(result);
      const storedSpeedByLink = new Map(speedResults.map((result) => [result.link, result]));
      availabilityResults = runStore.availabilityResults().map(({ status: _status, error: _error, ...result }) => ({
        ...(storedSpeedByLink.get(result.link) as SpeedTestResult),
        ...result
      } as AvailabilityResultDict));
    }
    const availabilityByLinkForOrder = new Map(availabilityResults.map((result) => [result.link, result]));
    availableLinks = passedSpeedLinks.filter((link) => availabilityByLinkForOrder.get(link)?.all_passed);
    summary.counts.availability_links = runStore.availabilityResults().filter((result) => result.status === 'availability_passed').length;
    await writeLines(artifactDir, 'vpn_node_availability.txt', availableLinks);
    await writeJson(artifactDir, 'vpn_node_availability_report.json', availabilityResults);
    if (passedSpeedLinks.length > 0 && availableLinks.length === 0) {
      await setStage('availability', 'failed');
      throw new Error('No links passed availability');
    }
    if (summary.stage_status.availability !== 'skipped') await setStage('availability', 'success', !useStreamingStages);

    await setStage('postprocess', 'running');
    const countryLookup = createCountryLookup(context);
    const availabilityByLink = new Map(availabilityResults.map((result) => [result.link, result]));
    const rankedLinks = await Promise.all(availableLinks.map(async (link) => ({
      link,
      country_code: await countryLookup!(link, speedResultByLink.get(link) as SpeedTestResult, availabilityByLink.get(link) as AvailabilityResultDict)
    })));
    const postprocessed = context.stages?.countryLookup
      ? { links: rankedLinks.map((item) => decorateLinkWithCountry(item.link, item.country_code)) }
      : await postprocessLinksWithBackend({ ranked_links: rankedLinks, filters: profile.filters as any }, { cwd: projectRoot, env });
    summary.counts.final_links = postprocessed.links.length;
    await writeLines(artifactDir, 'vpn_node_emoji.txt', postprocessed.links);
    await setStage('postprocess', 'success');

    await setStage('render', 'running');
    const template = await readFile(resolveWorkerTemplatePath(projectRoot), 'utf8');
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
      assertDeployMinimumFinalLinks(profile, postprocessed.links);
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
    handlingFailure = true;
    activeSpeedPool?.abort(error);
    activeAvailabilityPool?.abort(error);
    await Promise.allSettled([activeSpeedPool?.drain(), activeAvailabilityPool?.drain()].filter((task): task is Promise<void> => Boolean(task)));
    const failedCounts = runStore.counts();
    summary.counts.raw_links = failedCounts.raw;
    summary.counts.deduped_links = failedCounts.deduped;
    refreshSourceCounts(summary, runStore);
    summary.run_status = 'failed';
    summary.error = errorMessage(error);
    runStore.setRunStatus('failed', summary.error);
    for (const stage of STAGES) {
      if (summary.stage_status[stage] === 'running') {
        summary.stage_status[stage] = 'failed';
        runStore.setStageStatus(stage, 'failed', summary.error);
        emit('stage', { stage, status: 'failed' });
      }
    }
    try { await writeReport(); } catch { /* Preserve the original pipeline failure. */ }
    emit('summary', summary as unknown as Record<string, unknown>);
    emit('run_failed', { error: summary.error });
    throw error;
  }

  summary.run_status = 'success';
  runStore.setRunStatus('success');
  await writeReport();
  emit('summary', summary as unknown as Record<string, unknown>);
    return summary;
  } finally {
    runStore.close();
  }
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
  const retryStore = RunStore.seedRetry(sourceArtifactDir, retryArtifactDir, stage);
  refreshSourceCounts(summary, retryStore);
  try {

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
    retryStore.setStageStatus(stageName, status);
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
      const dedupedLinks = retryStore.dedupedLinks();
      if (dedupedLinks.length === 0) {
        throw new Error('No deduped links available to retry speedtest');
      }
      summary.counts.raw_links = retryStore.counts().raw;
      summary.counts.deduped_links = dedupedLinks.length;
      await setStage('speedtest', 'running');
      speedResults = context.stages?.speedtest
        ? await context.stages.speedtest(dedupedLinks, profile.speed_test ?? {}, runtimePath)
        : await speedtestLinksWithBackend({ links: dedupedLinks, config: profile.speed_test as any, runtime_path: runtimePath }, {
          cwd: projectRoot,
          env: runtimeStageEnv,
          progressCallback: (message) => emit('log', { message }),
          eventCallback: (type, payload) => emit(type, payload)
        });
      const retrySpeedConfig = normalizeSpeedTestConfig(profile.speed_test as any);
      for (const result of speedResults) {
        retryStore.recordProbe({ link: result.link, reachable: result.reachable, latency_ms: result.latency_ms, error: result.error ?? '' });
        retryStore.recordSpeedResult(result, result.reachable && result.average_download_mb_s >= retrySpeedConfig.min_download_mb_s);
      }
      const passedSpeedLinks = speedResults
        .filter((result) => result.reachable && result.average_download_mb_s >= Number(profile.speed_test?.min_download_mb_s ?? 0))
        .map((result) => result.link);
      summary.counts.speedtest_links = passedSpeedLinks.length;
      await writeLines(retryArtifactDir, 'vpn_node_speedtest.txt', passedSpeedLinks);
      await writeJson(retryArtifactDir, 'vpn_node_speedtest_report.json', speedResults);
      if (passedSpeedLinks.length === 0) {
        await setStage('speedtest', 'failed');
        summary.run_status = 'failed';
        summary.error = `Error: ${speedtestFailureMessage(speedResults, Number(profile.speed_test?.min_download_mb_s ?? 0))}`;
        await writeReport();
        throw new Error(speedtestFailureMessage(speedResults, Number(profile.speed_test?.min_download_mb_s ?? 0)));
      }
      speedResults = speedResults.filter((result) => passedSpeedLinks.includes(result.link));
      await setStage('speedtest', 'success');
    } else {
      speedResults = retryStore.speedResults().filter((result) => result.status === 'speed_passed');
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
      for (const result of availabilityResults) retryStore.recordAvailabilityResult(result);
      const availableLinks = retryStore.availabilityResults().filter((result) => result.status === 'availability_passed').map((result) => result.link);
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
      const availableLinkSet = new Set(availableLinks);
      availabilityResults = availabilityResults.filter((result) => availableLinkSet.has(result.link));
      await setStage('availability', 'success');
    } else if (isStageAtOrAfter(stage, 'postprocess')) {
      availabilityResults = retryStore.availabilityResults()
        .filter((result) => result.status === 'availability_passed')
        .map(({ status: _status, ...result }) => result as AvailabilityResultDict);
    }

    if (isStageAtOrAfter('postprocess', stage)) {
      if (availabilityResults.length === 0) {
        throw new Error('No availability inputs available to retry postprocess');
      }
      await setStage('postprocess', 'running');
      const speedResultByLink = new Map(speedResults.map((result) => [result.link, result]));
      const countryLookup = createCountryLookup(context);
      const rankedLinks = await Promise.all(availabilityResults.map(async (availabilityResult) => ({
        link: availabilityResult.link,
        country_code: await countryLookup!(availabilityResult.link, speedResultByLink.get(availabilityResult.link) ?? availabilityResult, availabilityResult)
      })));
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
      const template = await readFile(resolveWorkerTemplatePath(projectRoot), 'utf8');
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
      assertDeployMinimumFinalLinks(profile, finalLinks);
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
      retryStore.setStageStatus(activeStage, 'failed', summary.error);
      emit('stage', { stage: activeStage, status: 'failed' });
    }
    await writeReport();
    emit('summary', summary as unknown as Record<string, unknown>);
    emit('run_failed', { error: summary.error });
    retryStore.setRunStatus('failed', summary.error);
    throw error;
  }

  summary.run_status = 'success';
  summary.error = '';
  await writeReport();
  emit('summary', summary as unknown as Record<string, unknown>);
  retryStore.setRunStatus('success');
  return summary;
  } finally {
    retryStore.close();
  }
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
  const hadRunDb = fs.existsSync(path.join(artifactDir, 'run.db'));
  const runStore = RunStore.openOrImport(artifactDir);
  try {
  runStore.reopenForResume();
  runStore.resetInterruptedRunning();
  refreshSourceCounts(summary, runStore);

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
    runStore.setStageStatus(stageName, status);
    await writeReport();
  };

  const rawLinks = runStore.rawLinks();
  const dedupedLinks = runStore.dedupedLinks();
  summary.counts.raw_links = rawLinks.length;
  summary.counts.deduped_links = dedupedLinks.length;
  for (const baseStage of ['doctor', 'extract', 'dedupe'] as StageName[]) {
    if (summary.stage_status[baseStage] === 'pending') {
      summary.stage_status[baseStage] = 'success';
    }
  }

  const { probes, fullResults } = hadRunDb
    ? { probes: new Map<string, ProbeResult>(), fullResults: new Map<string, SpeedTestResult>() }
    : await speedtestResumeStateFromEventLog(resumeEventLog);
  for (const probe of runStore.probeResults()) probes.set(probe.link, probe);
  for (const result of runStore.speedResults().filter((row) => row.status === 'speed_passed' || row.status === 'speed_failed')) fullResults.set(result.link, result);
  emit('speedtest_resume_state', {
    resumed_probe_count: probes.size,
    resumed_full_count: fullResults.size,
    total_links: dedupedLinks.length
  });
  emit('log', { message: `[resume] speedtest resume from probe=${probes.size}/${dedupedLinks.length} full=${fullResults.size}` });

  try {
    await setStage('speedtest', 'running');
    const speedConfig = normalizeSpeedTestConfig(profile.speed_test as any);
    runStore.classifySpeedResults(speedConfig.min_download_mb_s);
    for (const probe of probes.values()) runStore.recordProbe(probe);
    for (const result of fullResults.values()) {
      runStore.recordSpeedResult(result, result.reachable && result.average_download_mb_s >= speedConfig.min_download_mb_s);
    }
    const requestedRuntime = String(env.AUTOVPN_SPEEDTEST_RUNTIME ?? '').trim().toLowerCase();
    const usingInjectedSpeedtestStages = Boolean(context.stages?.speedtestProbe && context.stages?.speedtestLink);
    if (requestedRuntime === 'direct' && !usingInjectedSpeedtestStages) {
      throw new Error('Node resume speedtest cannot use AUTOVPN_SPEEDTEST_RUNTIME=direct');
    }
    const remainingProbeLinks = dedupedLinks.filter((link) => !probes.has(link));
    if (remainingProbeLinks.length > 0) {
      const probeResults = context.stages?.speedtestProbe
        ? await context.stages.speedtestProbe(remainingProbeLinks, profile.speed_test ?? {}, runtimePath)
        : await probeSpeedtestLinksInNode({ links: remainingProbeLinks, config: profile.speed_test as any, runtime_path: runtimePath }, { cwd: projectRoot, env });
      validateSpeedResumeProbeBatch(remainingProbeLinks, probeResults);
      for (let index = 0; index < probeResults.length; index += 1) {
        const result = probeResults[index];
        probes.set(result.link, result);
        runStore.recordProbe(result);
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
    const candidateLinks = orderedProbes.filter((probe) => probe.reachable).map((probe) => probe.link);
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
      runStore.recordSpeedResult(result, result.reachable && result.average_download_mb_s >= speedConfig.min_download_mb_s);
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
      summary.error = `Error: ${speedtestFailureMessage(orderedFullResults, speedConfig.min_download_mb_s)}`;
      await writeReport();
      runStore.setRunStatus('failed', summary.error);
      throw new Error(speedtestFailureMessage(orderedFullResults, speedConfig.min_download_mb_s));
    }

    await setStage('speedtest', 'success');
    summary.run_status = 'success';
    summary.error = '';
    await writeReport();
    emit('summary', summary as unknown as Record<string, unknown>);
    runStore.setRunStatus('success');
    return summary;
  } catch (error) {
    summary.run_status = 'failed';
    summary.error = errorMessage(error);
    if (summary.stage_status.speedtest === 'running') {
      summary.stage_status.speedtest = 'failed';
      runStore.setStageStatus('speedtest', 'failed', summary.error);
      emit('stage', { stage: 'speedtest', status: 'failed' });
    }
    await writeReport();
    emit('summary', summary as unknown as Record<string, unknown>);
    emit('run_failed', { error: summary.error });
    runStore.setRunStatus('failed', summary.error);
    throw error;
  }
  } finally {
    runStore.close();
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
    runStore.setStageStatus(stageName, status);
    await writeReport();
  };

  const runStore = RunStore.openOrImport(artifactDir);
  try {
  runStore.reopenForResume();
  const rawLinks = runStore.rawLinks();
  const dedupedLinks = runStore.dedupedLinks();
  await writeLines(artifactDir, 'vpn_node_raw.txt', rawLinks);
  await writeLines(artifactDir, 'vpn_node_deduped.txt', dedupedLinks);
  let speedResults: SpeedTestResult[] = [];
  const storeCounts = runStore.counts();
  summary.counts.raw_links = storeCounts.raw;
  summary.counts.deduped_links = storeCounts.deduped;
  refreshSourceCounts(summary, runStore);
  summary.counts.speedtest_links = speedResults.length;

  try {
    runStore.resetInterruptedRunning();
    const speedConfig = normalizeSpeedTestConfig(profile.speed_test as any);
    const runtimePermits = new AsyncPermitPool(Math.max(2, speedConfig.concurrency));
    runStore.classifySpeedResults(speedConfig.min_download_mb_s);
    const availabilityPool = new BoundedWorkerPool<SpeedTestResult>({
      concurrency: speedConfig.concurrency,
      capacity: speedConfig.concurrency * 2,
      worker: async (speedResult) => {
        runStore.markAvailabilityRunning(speedResult.link);
        const results = await runtimePermits.run(async () => context.stages?.availability
          ? await context.stages.availability([speedResult], profile.speed_test ?? {}, runtimePath, profile.availability_targets)
          : await checkLinkAvailabilityBatchWithBackend({ results: [speedResult], config: profile.speed_test ?? {}, runtime_path: runtimePath, targets: profile.availability_targets as any }, { cwd: projectRoot, env: runtimeStageEnv }));
        if (results.length !== 1 || results[0].link !== speedResult.link) throw new Error('availability adapter must return exactly one matching result');
        runStore.recordAvailabilityResult(results[0]);
      }
    });
    const availabilityWork = new Set(runStore.availabilityLinksNeedingWork());
    for (const result of runStore.speedResults().filter((row) => row.status === 'speed_passed' && availabilityWork.has(row.link))) {
      await availabilityPool.submit(result);
    }
    const speedPool = new BoundedWorkerPool<string>({
      concurrency: speedConfig.concurrency,
      capacity: speedConfig.concurrency * 2,
      worker: async (link) => {
      runStore.markSpeedRunning(link);
      const probes = await runtimePermits.run(async () => context.stages?.speedtestProbe
        ? await context.stages.speedtestProbe([link], profile.speed_test ?? {}, runtimePath)
        : await probeSpeedtestLinksInNode({ links: [link], config: profile.speed_test as any, runtime_path: runtimePath }, { cwd: projectRoot, env: runtimeStageEnv }));
      if (probes.length !== 1 || probes[0].link !== link) throw new Error('speedtest probe adapter must return exactly one matching result');
      const probe = probes[0];
      runStore.recordProbe(probe);
      let result: SpeedTestResult = { link, reachable: false, average_download_mb_s: 0, latency_ms: probe.latency_ms, error: probe.error ?? '' };
      if (probe.reachable) {
        result = await runtimePermits.run(async () => context.stages?.speedtestLink
          ? await context.stages.speedtestLink(link, profile.speed_test ?? {}, runtimePath)
          : await testSpeedtestLinkInNode({ link, config: profile.speed_test as any, runtime_path: runtimePath }, { cwd: projectRoot, env: runtimeStageEnv }));
        if (result.link !== link) throw new Error('speedtest link adapter must return a matching result');
        if (result.latency_ms <= 0) result.latency_ms = probe.latency_ms;
      }
      const passed = result.reachable && result.average_download_mb_s >= speedConfig.min_download_mb_s;
      runStore.recordSpeedResult(result, passed);
      if (passed) await availabilityPool.submit(result);
      }
    });
    try {
    for (const link of runStore.speedLinksNeedingWork()) {
      await speedPool.submit(link);
    }
    const latestStages = readLatestStageStatuses(path.join(artifactDir, 'run.db'));
    runStore.reopenSourcesForResume(runStore.incompleteSourceProgress().map((row) => row.source));
    const progressBySource = new Map(runStore.sourceProgress().map((row) => [row.source, row]));
    const extractionIncomplete = runStore.incompleteSourceProgress().length > 0
      || (runStore.sourceProgress().length > 0 && !['success', 'skipped'].includes(latestStages.extract ?? summary.stage_status.extract));
    if (extractionIncomplete) {
      await setStage('extract', 'running');
      for (const [sourceName, source] of enabledSources(profile)) {
        if (progressBySource.get(sourceName)?.status === 'success') continue;
        runStore.resetSourceForRerun(sourceName);
        runStore.recordSourceProgress(sourceName, { processed: 0, total: 0, status: 'running' });
        const replayCounts = new Map<string, number>();
        for (const link of runStore.rawLinksForSource(sourceName)) replayCounts.set(link, (replayCounts.get(link) ?? 0) + 1);
        const streamed = new Set<string>();
        const onLinks = async (links: string[]) => {
          for (const link of links) {
            streamed.add(link);
            const replayCount = replayCounts.get(link) ?? 0;
            if (replayCount > 0) {
              replayCounts.set(link, replayCount - 1);
              continue;
            }
            const recorded = runStore.recordExtractedNode(sourceName, link);
            if (recorded.inserted) await speedPool.submit(link);
          }
        };
        try {
          const result = context.stages?.extract
            ? await context.stages.extract({ source_name: sourceName, source }, { onLinks })
            : await fetchSourceLinksWithBackend({ source_name: sourceName, source }, { cwd: projectRoot, env: runtimeStageEnv, linksCallback: onLinks });
          await onLinks(result.links.filter((link) => !streamed.has(link)));
          runStore.recordSourceProgress(sourceName, { processed: result.requested_iterations, total: result.requested_iterations, status: 'success' });
          summary.source_counts[sourceName] = { raw_links: result.links.length, successful_iterations: result.successful_iterations, failed_iterations: result.failed_iterations };
        } catch (error) {
          runStore.recordSourceProgress(sourceName, { processed: 0, total: 0, status: 'failed', error: errorMessage(error) });
          await setStage('extract', 'failed');
          throw error;
        }
      }
      await setStage('extract', 'success');
    }
    speedPool.close();
    await speedPool.drain();
    availabilityPool.close();
    await availabilityPool.drain();
    } catch (error) {
      speedPool.abort(error);
      availabilityPool.abort(error);
      await Promise.allSettled([speedPool.drain(), availabilityPool.drain()]);
      throw error;
    }
    summary.counts.raw_links = runStore.counts().raw;
    summary.counts.deduped_links = runStore.counts().deduped;
    refreshSourceCounts(summary, runStore);
    await writeLines(artifactDir, 'vpn_node_raw.txt', runStore.rawLinks());
    await writeLines(artifactDir, 'vpn_node_deduped.txt', runStore.dedupedLinks());
    const storedPassedSpeedResults = runStore.speedResults().filter((result) => result.status === 'speed_passed');
    speedResults = storedPassedSpeedResults;
    await writeLines(artifactDir, 'vpn_node_speedtest.txt', speedResults.map((result) => result.link));
    await writeJson(artifactDir, 'vpn_node_speedtest_report.json', storedPassedSpeedResults.map(({ status: _status, ...result }) => result));
    summary.counts.speedtest_links = speedResults.length;
    if (speedResults.length === 0) {
      summary.stage_status.speedtest = 'failed';
      throw new Error('No speedtest results available to continue pipeline');
    }
    for (const baseStage of ['doctor', 'extract', 'dedupe', 'speedtest'] as StageName[]) {
      if (['pending', 'failed', 'stopped'].includes(summary.stage_status[baseStage])) {
        summary.stage_status[baseStage] = 'success';
      }
      runStore.setStageStatus(baseStage, summary.stage_status[baseStage]);
    }
    emit('resume_pipeline_state', {
      speedtest_links: speedResults.length,
      artifact_dir: artifactDir
    });
    emit('log', { message: `[resume] continue pipeline from speedtest_links=${speedResults.length}` });
    await writeReport();

    await setStage('availability', 'running');
    const storedAvailabilityResults = runStore.availabilityResults();
    const availabilityResults = storedAvailabilityResults.map(({ status: _status, ...result }) => result as AvailabilityResultDict);
    const availableLinks = storedAvailabilityResults.filter((result) => result.status === 'availability_passed').map((result) => result.link);
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
    const countryLookup = createCountryLookup(context);
    const rankedLinks = await Promise.all(availableLinks.map(async (link) => ({
      link,
      country_code: await countryLookup!(link, speedResultByLink.get(link) as SpeedTestResult, availabilityByLink.get(link) as AvailabilityResultDict)
    })));
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
    const template = await readFile(resolveWorkerTemplatePath(projectRoot), 'utf8');
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

    if (options.skipDeploy) {
      await setStage('deploy', 'skipped');
      await setStage('verify', 'skipped');
    } else {
      await setStage('deploy', 'running');
      assertDeployMinimumFinalLinks(profile, postprocessed.links);
      const deployment = context.stages?.deploy
        ? await context.stages.deploy({ projectRoot, bundleDir, profile })
        : await deployPagesWithBackend({ projectRoot, bundleDir, deploy: profile.deploy ?? {} }, { cwd: projectRoot, env });
      if (Number(deployment.returncode ?? 1) !== 0) {
        summary.deployment = safeDeployment(deployment);
        throw new Error(`Cloudflare deployment failed: ${JSON.stringify(summary.deployment)}`);
      }
      summary.deployment = safeDeployment(deployment);
      await setStage('deploy', 'success');

      if (options.skipVerify) {
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
    }
  } catch (error) {
    summary.run_status = 'failed';
    summary.error = errorMessage(error);
    if (activeStage && summary.stage_status[activeStage] === 'running') {
      summary.stage_status[activeStage] = 'failed';
      runStore.setStageStatus(activeStage, 'failed', summary.error);
      emit('stage', { stage: activeStage, status: 'failed' });
    }
    await writeReport();
    emit('summary', summary as unknown as Record<string, unknown>);
    emit('run_failed', { error: summary.error });
    runStore.setRunStatus('failed', summary.error);
    throw error;
  }

  summary.run_status = 'success';
  summary.error = '';
  await writeReport();
  emit('summary', summary as unknown as Record<string, unknown>);
  runStore.setRunStatus('success');
  return summary;
  } finally {
    runStore.close();
  }
}
