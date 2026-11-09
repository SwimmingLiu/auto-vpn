import fs from 'node:fs';
import path from 'node:path';

import { safeDeployment, redactText } from '../runtime/redaction.js';
import { resolveArtifactsRoot } from '../runtime/paths.js';

function loadJson(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
}

function countNonEmptyLines(filePath: string): number | undefined {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined;
  }
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .length;
}

function positiveNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function restoreArtifactCounts(artifactDir: string, counts: Record<string, unknown> = {}): Record<string, unknown> {
  const restored: Record<string, unknown> = { ...counts };
  const fileCounts: Array<[string, string]> = [
    ['raw_links', 'vpn_node_raw.txt'],
    ['deduped_links', 'vpn_node_deduped.txt'],
    ['speedtest_links', 'vpn_node_speedtest.txt'],
    ['availability_links', 'vpn_node_availability.txt'],
    ['final_links', 'vpn_node_emoji.txt'],
    ['postprocess_links', 'vpn_node_emoji.txt']
  ];

  for (const [countKey, fileName] of fileCounts) {
    if (positiveNumber(restored[countKey]) > 0) {
      continue;
    }
    const fileCount = countNonEmptyLines(path.join(artifactDir, fileName));
    if (fileCount && fileCount > 0) {
      restored[countKey] = fileCount;
    }
  }

  return restored;
}

function latestArtifactDir(artifactsRoot: string): string {
  if (!fs.existsSync(artifactsRoot)) {
    return '';
  }
  const candidates = fs.readdirSync(artifactsRoot)
    .map((name) => path.join(artifactsRoot, name))
    .filter((item) => fs.statSync(item).isDirectory())
    .sort((left, right) => {
      const leftStat = fs.statSync(left);
      const rightStat = fs.statSync(right);
      return rightStat.mtimeMs - leftStat.mtimeMs || path.basename(right).localeCompare(path.basename(left));
    });
  return candidates[0] ?? '';
}

export function artifactLatest(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const latest = latestArtifactDir(resolveArtifactsRoot(projectRoot, env));
  if (!latest) {
    return { ok: false, artifact_dir: '' };
  }
  const reportPath = path.join(latest, 'pipeline_report.json');
  const payload: Record<string, unknown> = { ok: true, artifact_dir: latest };
  if (!fs.existsSync(reportPath)) {
    return { ...payload, run_status: '', stage_status: {}, counts: {}, source_counts: {}, deployment: {}, error: '' };
  }
  const report = loadJson(reportPath);
  return {
    ...payload,
    run_status: report.run_status ?? '',
    stage_status: report.stage_status ?? {},
    counts: restoreArtifactCounts(latest, (report.counts ?? {}) as Record<string, unknown>),
    source_counts: report.source_counts ?? {},
    deployment: safeDeployment((report.deployment ?? {}) as Record<string, unknown>),
    error: redactText(String(report.error ?? ''))
  };
}

function hasNonEmptyFile(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
}

function retryableStages(artifactDir: string, stageStatus: Record<string, unknown>): string[] {
  const stages: string[] = [];
  if (hasNonEmptyFile(path.join(artifactDir, 'vpn_node_deduped.txt'))) stages.push('speedtest');
  if (hasNonEmptyFile(path.join(artifactDir, 'vpn_node_speedtest.txt'))) stages.push('availability');
  if (hasNonEmptyFile(path.join(artifactDir, 'vpn_node_availability.txt'))) stages.push('postprocess');
  if (hasNonEmptyFile(path.join(artifactDir, 'vpn_node_emoji.txt'))) stages.push('render');
  if (fs.existsSync(path.join(artifactDir, 'vmess_node.js'))) stages.push('obfuscate');
  if (fs.existsSync(path.join(artifactDir, '_worker.js'))) stages.push('deploy');
  if (stageStatus.deploy === 'success') stages.push('verify');
  return stages;
}

function isArtifactDir(artifactDir: string): boolean {
  if (!/^\d{8}-\d{6}$/.test(path.basename(artifactDir))) {
    return false;
  }
  return fs.existsSync(path.join(artifactDir, 'pipeline_report.json')) || fs.existsSync(path.join(artifactDir, 'run.db'));
}

export function artifactList(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const artifactsRoot = resolveArtifactsRoot(projectRoot, env);
  if (!fs.existsSync(artifactsRoot)) {
    return { ok: true, items: [], activity: [] };
  }
  const directories = fs.readdirSync(artifactsRoot)
    .map((name) => path.join(artifactsRoot, name))
    .filter((item) => fs.statSync(item).isDirectory() && isArtifactDir(item))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
;
  const items = directories.slice(0, 20)
    .map((artifactDir) => {
      const report = loadJson(path.join(artifactDir, 'pipeline_report.json'));
      const stageStatus = (report.stage_status ?? {}) as Record<string, unknown>;
      return {
        artifact_dir: artifactDir,
        artifact_name: path.basename(artifactDir),
        run_status: report.run_status ?? '',
        stage_status: stageStatus,
        counts: restoreArtifactCounts(artifactDir, (report.counts ?? {}) as Record<string, unknown>),
        source_counts: report.source_counts ?? {},
        retry_context: report.retry_context ?? {},
        retryable_stages: retryableStages(artifactDir, stageStatus),
        updated_at: new Date(fs.statSync(artifactDir).mtimeMs).toISOString().replace('Z', '')
      };
    });
  // Retry choices stay bounded; the calendar aggregates every retained run,
  // otherwise a busy day would silently erase most of the year's history.
  const days = new Map<string, { date: string; nodes: number; runs: number }>();
  for (const directory of directories) {
    const report = loadJson(path.join(directory, 'pipeline_report.json'));
    const counts = report.counts;
    const fromReport: unknown = counts?.final_links ?? counts?.availability_links;
    const value = typeof fromReport === 'number' && Number.isFinite(fromReport) && fromReport >= 0
      ? fromReport : countNonEmptyLines(path.join(directory, 'vpn_node_emoji.txt'));
    if (value === undefined) continue;
    const stamp = path.basename(directory).slice(0, 8);
    const date = stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8);
    const day = days.get(date) ?? { date, nodes: 0, runs: 0 };
    day.nodes += Math.floor(value);
    day.runs += 1;
    days.set(date, day);
  }
  return { ok: true, items, activity: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)) };
}
