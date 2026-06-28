import fs from 'node:fs';
import path from 'node:path';

import { redactText, safeDeployment } from '../runtime/redaction.js';

const FINAL_NODE_FILES = ['vpn_node_emoji.txt', 'vpn_node_availability.txt', 'vpn_node_speedtest.txt'];

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.ceil(size / 1024)} KB`;
  }
  return `${size} B`;
}

function loadJson(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
  } catch {
    return { error: `invalid ${path.basename(filePath)}` };
  }
}

function fileInventory(artifactDir: string): Array<Record<string, unknown>> {
  return fs.readdirSync(artifactDir)
    .map((name) => path.join(artifactDir, name))
    .filter((item) => fs.statSync(item).isFile())
    .map((item) => ({ name: path.basename(item), size: formatBytes(fs.statSync(item).size) }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function decodeVmessRegion(link: string): string {
  const value = link.trim();
  if (!value.startsWith('vmess://')) {
    return 'OTHER';
  }
  let encoded = value.slice('vmess://'.length);
  encoded += '='.repeat((4 - (encoded.length % 4)) % 4);
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    const match = String(payload.ps ?? '').toUpperCase().match(/\b([A-Z]{2})\b/);
    return match ? match[1] : 'OTHER';
  } catch {
    return 'OTHER';
  }
}

function safeNodeCounts(artifactDir: string): Record<string, unknown> {
  const nodeSource = FINAL_NODE_FILES.find((name) => fs.existsSync(path.join(artifactDir, name))) ?? '';
  if (!nodeSource) {
    return { node_source: '', final_node_count: 0, regions: [] };
  }
  const lines = fs.readFileSync(path.join(artifactDir, nodeSource), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const region = decodeVmessRegion(line);
    counts.set(region, (counts.get(region) ?? 0) + 1);
  }
  return {
    node_source: nodeSource,
    final_node_count: lines.length,
    regions: [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([region_code, count]) => ({ region_code, count }))
  };
}

export function previewArtifact(artifactDir: string): Record<string, unknown> {
  const absolute = path.resolve(artifactDir);
  const resolved = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, artifact_dir: resolved };
  }
  const report = loadJson(path.join(resolved, 'pipeline_report.json'));
  return {
    ok: true,
    artifact_dir: resolved,
    run_status: report.run_status ?? '',
    stage_status: report.stage_status ?? {},
    counts: report.counts ?? {},
    source_counts: report.source_counts ?? {},
    deployment: safeDeployment((report.deployment ?? {}) as Record<string, unknown>),
    retry_context: report.retry_context ?? {},
    error: redactText(String(report.error ?? '')),
    files: fileInventory(resolved),
    safe_node_counts: safeNodeCounts(resolved)
  };
}
