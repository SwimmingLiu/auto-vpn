import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * A run log is uploaded as a workflow artifact, and a public repository's
 * artifacts are downloadable without authentication. The log carries one event
 * per probed and measured link, each with the full `vmess://` payload — so an
 * unredacted upload publishes the operator's subscription.
 *
 * This is the check that the uploaded file cannot do that.
 */

const SCRIPT = new URL('../../scripts/redact-run-log.mjs', import.meta.url).pathname;

function run(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autovpn-redact-'));
  const input = path.join(dir, 'in.jsonl');
  const output = path.join(dir, 'out.jsonl');
  writeFileSync(input, lines.join('\n') + '\n', 'utf8');
  execFileSync(process.execPath, [SCRIPT, input, output], { encoding: 'utf8' });
  return readFileSync(output, 'utf8');
}

const NODE = 'vmess://eyJ2IjoyLCJwcyI6MSwiYWRkIjoiMTA0LjIzMy4yMzEuMTgzIiwicG9ydCI6IjQ5OTk4In0=';

test('a node link anywhere in the line is replaced', () => {
  const out = run([
    JSON.stringify({ type: 'speedtest_result', link: NODE, reachable: true, average_download_mb_s: 5 }),
    JSON.stringify({ type: 'speedtest_probe_result', link: NODE, latency_ms: 42 }),
    JSON.stringify({ type: 'log', message: `probed ${NODE} ok` })
  ]);
  assert.doesNotMatch(out, /vmess:\/\/eyJ/, 'the payload survived');
  assert.doesNotMatch(out, /104\.233\.231\.183/, 'the server address survived');
  assert.equal((out.match(/vmess:\/\/<redacted:[0-9a-f]{12}>/g) ?? []).length, 3);
});

test('the same node keeps one id, so a reader can still follow it across events', () => {
  const out = run([
    JSON.stringify({ type: 'speedtest_probe_result', link: NODE }),
    JSON.stringify({ type: 'speedtest_result', link: NODE })
  ]);
  const ids = new Set(out.match(/vmess:\/\/<redacted:([0-9a-f]{12})>/g) ?? []);
  assert.equal(ids.size, 1, 'one node produced more than one fingerprint');
});

test('the numbers a held night is diagnosed from survive redaction', () => {
  const out = run([JSON.stringify({
    type: 'speedtest_result', link: NODE, reachable: true,
    average_download_mb_s: 9.65, latency_ms: 120, passed_threshold: true, error: ''
  })]);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.reachable, true);
  assert.equal(parsed.average_download_mb_s, 9.65);
  assert.equal(parsed.latency_ms, 120);
  assert.match(parsed.link, /^vmess:\/\/<redacted:/);
});

test('every scheme the pipeline can emit is covered, not just vmess', () => {
  const out = run([
    JSON.stringify({ link: 'vless://' + 'a'.repeat(40) }),
    JSON.stringify({ link: 'trojan://' + 'b'.repeat(40) }),
    JSON.stringify({ link: 'ss://' + 'c'.repeat(40) }),
    JSON.stringify({ link: 'hysteria2://' + 'd'.repeat(40) })
  ]);
  for (const scheme of ['vless', 'trojan', 'ss', 'hysteria2']) {
    assert.doesNotMatch(out, new RegExp(`${scheme}://[a-d]{40}`), `${scheme} was not redacted`);
    assert.match(out, new RegExp(`${scheme}://<redacted:`), `${scheme} lost its fingerprint`);
  }
});

test('a line with no link is passed through byte-for-byte', () => {
  const line = JSON.stringify({ type: 'summary', counts: { final_links: 36, raw_links: 272 } });
  assert.equal(run([line]).trim(), line);
});
