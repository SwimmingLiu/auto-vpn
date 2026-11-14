#!/usr/bin/env node
/**
 * Strip node links out of a run log before it leaves the runner.
 *
 * A run log is uploaded as a workflow artifact, and a public repository's
 * artifacts are downloadable without authentication — anyone can list them
 * through the REST API and fetch the archive. The log contains one event per
 * probed and measured link, each carrying the full `vmess://` payload: server
 * address, port and UUID. Uploading it publishes the subscription.
 *
 * The count survives, because the yield statistics are the reason to keep the
 * log at all: `speedtest_result` still says `reachable`, `latency_ms` and
 * `average_download_mb_s`, and the link is replaced by a stable short
 * fingerprint so a reader can still follow one node across events without
 * being able to use it.
 *
 * Usage: node cloudflare/scripts/redact-run-log.mjs <in.jsonl> <out.jsonl>
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: redact-run-log.mjs <in.jsonl> <out.jsonl>');
  process.exit(2);
}

// Every scheme the pipeline can emit. vmess is what these vendors return, but a
// vendor that starts returning vless or trojan must not silently stop matching.
// The label is derived from the match itself, so `hysteria2://` does not get
// relabelled as `hysteria://` (which would invent a scheme that was not there).
const LINK_PATTERNS = [
  [/vmess:\/\/[A-Za-z0-9_\-+/=]+/g, 'vmess'],
  [/vless:\/\/[A-Za-z0-9_\-+/=]+/g, 'vless'],
  [/trojan:\/\/[A-Za-z0-9_\-+/=]+/g, 'trojan'],
  [/ss:\/\/[A-Za-z0-9_\-+/=]+/g, 'ss'],
  [/(hysteria2?):\/\/[A-Za-z0-9_\-+/=]+/g, null]
];

/** A short, stable stand-in: same node => same id, and it cannot be dialled. */
function fingerprint(scheme, link) {
  return `${scheme}://<redacted:${createHash('sha256').update(link).digest('hex').slice(0, 12)}>`;
}

/** Replace every link anywhere in the text, including inside JSON strings. */
export function redactLinks(text) {
  let out = text;
  for (const [pattern, scheme] of LINK_PATTERNS) {
    if (scheme === null) {
      // Capture group 1 is the scheme that actually matched.
      out = out.replace(pattern, (match, matched) => fingerprint(matched, match));
    } else {
      out = out.replace(pattern, (match) => fingerprint(scheme, match));
    }
  }
  return out;
}

const reader = createInterface({ input: createReadStream(input, 'utf8'), crlfDelay: Infinity });
const writer = createWriteStream(output, { mode: 0o600 });
let lines = 0;
let redacted = 0;

for await (const line of reader) {
  if (!line.trim()) continue;
  const cleaned = redactLinks(line);
  if (cleaned !== line) redacted += 1;
  writer.write(`${cleaned}\n`);
  lines += 1;
}
writer.end();

await new Promise((resolve) => writer.on('close', resolve));
console.log(`redacted ${redacted} of ${lines} lines -> ${output}`);
