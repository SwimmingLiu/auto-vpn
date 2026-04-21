export const STAGE_ORDER = [
  'doctor',
  'extract',
  'dedupe',
  'speedtest',
  'availability',
  'postprocess',
  'render',
  'obfuscate',
  'deploy',
  'verify'
];

export function buildStageModel(stageStatus = {}) {
  return STAGE_ORDER.map((name) => ({
    name,
    status: stageStatus[name] ?? 'pending'
  }));
}

export function resolveVerifyMetricValue(status = 'pending', messages) {
  if (status === 'success') {
    return messages.verifiedValue;
  }
  if (status === 'pending') {
    return messages.readyValue;
  }
  return messages.statusLabels[status] ?? status;
}

export function toMetricItems(counts = {}) {
  return Object.entries(counts).map(([label, value]) => ({
    label: label.replaceAll('_', ' ').toUpperCase(),
    value: String(value)
  }));
}
