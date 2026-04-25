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
  'runs',
  'results',
  'subscriptions',
  'logs',
  'settings'
];

export const PAGE_INDEX = Object.fromEntries(
  PAGE_ORDER.map((name, index) => [name, String(index + 1).padStart(2, '0')])
);

const METRIC_LABELS = {
  raw_links: '原始节点',
  postprocess_links: '去重后',
  speedtest_links: '测速通过节点',
  availability_links: '最终可用'
};

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
    label: METRIC_LABELS[label] ?? label,
    value: String(value)
  }));
}
