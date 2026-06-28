export type AutoVpnEvent = {
  type: string;
  [key: string]: unknown;
};

const KNOWN_EVENT_TYPES = new Set([
  'run_started',
  'log',
  'stage',
  'summary',
  'run_failed',
  'extract_source_started',
  'extract_request_result',
  'extract_decrypt_result',
  'extract_iteration',
  'extract_source_completed',
  'extract_source_failed',
  'speedtest_runtime',
  'speedtest_probe_result',
  'speedtest_selected',
  'speedtest_result',
  'speedtest_resume_state',
  'resume_pipeline_state',
  'availability_link_result'
]);

export function normalizeEvent(value: unknown): AutoVpnEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backend event must be an object');
  }
  const event = value as Record<string, unknown>;
  if (typeof event.type !== 'string' || !event.type.trim()) {
    throw new Error('Backend event is missing string type');
  }
  const normalized = { ...event, type: event.type.trim() } as AutoVpnEvent;
  return normalized;
}

export function parseEventLine(line: string): AutoVpnEvent {
  try {
    return normalizeEvent(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid backend event JSON: ${error.message}`);
    }
    throw error;
  }
}

export function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type);
}
