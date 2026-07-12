import fs from 'node:fs';
import path from 'node:path';
import { isIsoAlpha2CountryCode } from './country-codes.js';

const FINAL_NODE_FILES = [
  'vpn_node_emoji.txt',
  'vpn_node_availability.txt',
  'vpn_node_speedtest.txt'
];

export function previewArtifactDirectory(artifactDir) {
  const resolved = path.resolve(String(artifactDir ?? ''));
  if (!resolved || !fs.existsSync(resolved)) {
    return {
      ok: false,
      outputFiles: [],
      nodeRows: [],
      regionCards: [],
      finalNodeCount: 0,
      nodeSource: ''
    };
  }

  const outputFiles = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(resolved, entry.name);
      return { name: entry.name, size: formatBytes(fs.statSync(filePath).size) };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

  const nodeSource = FINAL_NODE_FILES.find((name) => fs.existsSync(path.join(resolved, name))) ?? '';
  const nodeRows = nodeSource
    ? fs.readFileSync(path.join(resolved, nodeSource), 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseVmessLinkForPreview(line))
      .filter(Boolean)
    : [];
  const regionCards = buildRegionCards(nodeRows);
  const finalNodeCount = nodeRows.length;

  return { ok: true, outputFiles, nodeRows, regionCards, finalNodeCount, nodeSource };
}

export function mergeLatestArtifactPreview(report, preview) {
  if (!report?.ok) {
    return { ok: false, artifact_dir: '' };
  }
  return {
    ...report,
    retry_context: report?.retry_context ?? {},
    outputFiles: preview?.outputFiles ?? [],
    nodeRows: preview?.nodeRows ?? [],
    regionCards: preview?.regionCards ?? [],
    finalNodeCount: preview?.finalNodeCount ?? 0,
    nodeSource: preview?.nodeSource ?? ''
  };
}

export function parseVmessLinkForPreview(link) {
  const value = String(link ?? '').trim();
  if (!value.startsWith('vmess://')) {
    return null;
  }

  try {
    const encoded = padBase64(value.slice('vmess://'.length));
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return {
      name: String(payload.ps ?? ''),
      address: String(payload.add ?? ''),
      protocol: 'vmess',
      path: String(payload.path ?? ''),
      link: value,
      regionCode: extractRegionCode(payload.ps)
    };
  } catch {
    return null;
  }
}

function extractRegionCode(name) {
  const text = String(name ?? '').trim().toUpperCase();
  const match = text.match(/^[\u{1F1E6}-\u{1F1FF}]{2}\s+([A-Z]{2})(?:\s|$)/u);
  return match && isIsoAlpha2CountryCode(match[1]) ? match[1] : 'US';
}

function buildRegionCards(nodeRows) {
  const counts = new Map();
  for (const row of nodeRows) {
    const regionCode = String(row?.regionCode ?? 'OTHER') || 'OTHER';
    counts.set(regionCode, (counts.get(regionCode) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([regionCode, count]) => ({ regionCode, count }))
    .sort((left, right) => left.regionCode.localeCompare(right.regionCode, 'en'));
}

function padBase64(value) {
  return value + '='.repeat((4 - (value.length % 4)) % 4);
}

function formatBytes(size) {
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.ceil(size / 1024)} KB`;
  }
  return `${size} B`;
}
