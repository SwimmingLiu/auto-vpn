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

export const PAGE_ORDER = [
  'dashboard',
  'config',
  'runs',
  'history',
  'nodes',
  'subscriptions',
  'logs',
  'deploy',
  'monitor',
  'settings',
  'about'
];

export const PAGE_INDEX = Object.fromEntries(
  PAGE_ORDER.map((name, index) => [name, String(index + 1).padStart(2, '0')])
);

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

export function resolveRunControlState(runState = 'idle') {
  if (runState === 'running') {
    return {
      isBusy: true,
      runDisabled: true,
      stopDisabled: false
    };
  }

  if (runState === 'stopping') {
    return {
      isBusy: true,
      runDisabled: true,
      stopDisabled: true
    };
  }

  return {
    isBusy: false,
    runDisabled: false,
    stopDisabled: true
  };
}

export function toMetricItems(counts = {}) {
  return Object.entries(counts).map(([label, value]) => ({
    label: label.replaceAll('_', ' ').toUpperCase(),
    value: String(value)
  }));
}
