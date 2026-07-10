export interface DedupeBackendOptions {}

export function parseVmessLink(link: string): Record<string, unknown> {
  const encoded = link.replace(/^vmess:\/\//, '');
  const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function canonicalVmessKey(payload: Record<string, unknown>): string {
  return JSON.stringify([
    payload.add ?? '',
    payload.port ?? '',
    payload.id ?? '',
    payload.net ?? '',
    payload.host ?? '',
    payload.path ?? '',
    payload.tls ?? '',
    payload.sni ?? ''
  ].map((value) => String(value)));
}

export function dedupeVmessLinks(links: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const link of links) {
    const key = canonicalVmessKey(parseVmessLink(link));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(link);
  }
  return result;
}

export async function dedupeVmessLinksWithBackend(links: string[], options: DedupeBackendOptions = {}): Promise<string[]> {
  void options;
  return dedupeVmessLinks(links);
}
