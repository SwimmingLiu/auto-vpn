const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 100;

export function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '').toUpperCase()
    : '';
  const statusMatch = /(?:unexpected status|failed with status)\s+(\d{3})\b/i.exec(message);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status >= 500 && status <= 599;
  }
  if ([
    'AUTOVPN_INTERNAL_TIMEOUT',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT'
  ].includes(code)) {
    return true;
  }
  if (error instanceof TypeError && message.trim().toLowerCase() === 'fetch failed') {
    return true;
  }
  return /(?:connection|connect|download|response body|tls handshake).*timed out/i.test(message)
    || /socket hang up|network is unreachable|temporary failure/i.test(message);
}

export async function retryTransientNetwork<T>(
  operation: () => Promise<T>,
  options: { maxAttempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? DEFAULT_RETRY_DELAY_MS));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientNetworkError(error)) {
        throw error;
      }
      if (delayMs > 0) {
        await sleep(delayMs * attempt);
      }
    }
  }
  throw lastError;
}
