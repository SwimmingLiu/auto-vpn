import fs from 'node:fs';
import path from 'node:path';

import { isIsoAlpha2CountryCode } from '../pipeline/country-codes.js';
import { redactText, safeDeployment } from '../runtime/redaction.js';

const FINAL_NODE_FILES = ['vpn_node_emoji.txt', 'vpn_node_availability.txt', 'vpn_node_speedtest.txt'];
// Postprocess decorates every node as `<flag> <CC> <vendor name>`. The country
// code is only trusted in that exact position; a bare two-letter token inside a
// vendor name is not a region.
const LEADING_FLAG_COUNTRY_PATTERN = /^[\u{1F1E6}-\u{1F1FF}]{2}\s+([A-Z]{2})(?:\s|$)/u;

export interface FinalNodeRow {
  name: string;
  address: string;
  protocol: string;
  path: string;
  link: string;
  regionCode: string;
}

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

/**
 * Decode one final-output line into the row the UI renders.
 *
 * Country comes from the decorated name, never from the address: the pipeline
 * writes `<flag> <CC> <vendor name>`, so the prefix is authoritative and a name
 * without one is unknown rather than a guess.
 *
 * A line that is not a decodable vmess link returns null, matching the desktop
 * preview (`electron/lib/artifact-preview.js`): counting it would report a
 * "node" the results table cannot show.
 */
export function parseFinalNode(link: string): FinalNodeRow | null {
  const value = link.trim();
  if (!value.startsWith('vmess://')) {
    return null;
  }
  let encoded = value.slice('vmess://'.length);
  encoded += '='.repeat((4 - (encoded.length % 4)) % 4);
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    const name = String(payload.ps ?? '');
    const match = name.trim().toUpperCase().match(LEADING_FLAG_COUNTRY_PATTERN);
    const regionCode = match && isIsoAlpha2CountryCode(match[1]) ? match[1] : 'OTHER';
    return {
      name,
      address: String(payload.add ?? ''),
      protocol: 'vmess',
      path: String(payload.path ?? ''),
      link: value,
      regionCode
    };
  } catch {
    return null;
  }
}

function readFinalNodes(artifactDir: string): { nodeSource: string; rows: FinalNodeRow[] } {
  const nodeSource = FINAL_NODE_FILES.find((name) => fs.existsSync(path.join(artifactDir, name))) ?? '';
  if (!nodeSource) {
    return { nodeSource, rows: [] };
  }
  const lines = fs.readFileSync(path.join(artifactDir, nodeSource), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines.map((line) => parseFinalNode(line)).filter((row): row is FinalNodeRow => row !== null);
  return { nodeSource, rows };
}

function regionCounts(rows: FinalNodeRow[]): Array<{ region_code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    // The UI folds an undecorated name into US when it charts (buildRegionStats),
    // so the summary must report the same number or the two disagree.
    const regionCode = row.regionCode === 'OTHER' ? 'US' : row.regionCode;
    counts.set(regionCode, (counts.get(regionCode) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([region_code, count]) => ({ region_code, count }));
}

function safeNodeCounts(rows: FinalNodeRow[], nodeSource: string): Record<string, unknown> {
  return {
    node_source: nodeSource,
    final_node_count: rows.length,
    regions: regionCounts(rows)
  };
}

/**
 * Preview one artifact directory.
 *
 * `includeNodeRows` is what the serve runtime asks for: the results page and
 * the 国家分布 donut read those rows, and answering `nodeRows: []` left a
 * browser session at 0 nodes and an empty donut on a complete artifact. The
 * CLI's `artifact preview` keeps them out of its JSON so a 400-node artifact
 * does not print every link.
 */
export function previewArtifact(artifactDir: string, options: { includeNodeRows?: boolean } = {}): Record<string, unknown> {
  const absolute = path.resolve(artifactDir);
  const resolved = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, artifact_dir: resolved };
  }
  const report = loadJson(path.join(resolved, 'pipeline_report.json'));
  const finalNodes = readFinalNodes(resolved);
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
    safe_node_counts: safeNodeCounts(finalNodes.rows, finalNodes.nodeSource),
    ...(options.includeNodeRows ? { nodeRows: finalNodes.rows } : {})
  };
}
