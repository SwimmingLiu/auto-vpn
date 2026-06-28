const SECRET_DEPLOYMENT_KEYS = new Set([
  'subscription_url',
  'verify_subscription_url',
  'secret_query',
  'share_project_sub_value',
  'pages_secret_admin'
]);

const SECRET_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/(token=)[^&\s"']+/g, '$1<redacted>'],
  [/(serect_key=)[^&\s"']+/g, '$1<redacted>'],
  [/(secret_key=)[^&\s"']+/g, '$1<redacted>'],
  [/(api[_-]?token=)[^&\s"']+/gi, '$1<redacted>'],
  [/vmess:\/\/[A-Za-z0-9_\-+/=]+/g, 'vmess://<redacted>']
];

export function redactText(value: string): string {
  return SECRET_TEXT_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value);
}

function redactNested(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (value === null || ['number', 'boolean'].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactNested);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactNested(item)]));
  }
  return typeof value;
}

export function safeDeployment(deployment: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(deployment)) {
    if (SECRET_DEPLOYMENT_KEYS.has(key)) {
      safe[key] = value ? 'set' : '';
    } else {
      safe[key] = redactNested(value);
    }
  }
  return safe;
}

