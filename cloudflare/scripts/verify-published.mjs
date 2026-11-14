#!/usr/bin/env node
/**
 * Verify a published subscription the way a client would.
 *
 * The pipeline's own verify stage only checks that the subscription URL answers
 * 200 (`verifyUrl` passes with no expected fragment). A wrong key, a stale
 * deployment and a correct one all answer 200 — the wrong key returns random
 * bytes and the stale one returns last night's nodes. So the real acceptance
 * test decodes the body and compares it to what the run actually measured.
 *
 * Usage:
 *   node verify-published.mjs <subscription-url> <artifact-dir>
 *
 * Exit 0 only when the decoded payload is a vmess link list and at least one of
 * its links appears in the artifact the run produced.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [url, artifactDir] = process.argv.slice(2);
if (!url || !artifactDir) {
  console.error('usage: verify-published.mjs <subscription-url> <artifact-dir>');
  process.exit(2);
}

const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
if (!response.ok) {
  console.error(`FAIL published URL answered ${response.status}`);
  process.exit(1);
}
const body = (await response.text()).trim();

/** Peel base64 layers until the text looks like a link list. */
function decode(text) {
  let current = text;
  for (let depth = 0; depth < 4; depth += 1) {
    const links = current.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^vmess:\/\//.test(line));
    if (links.length) return { links, depth };
    const padded = current.replace(/\s+/g, '') + '='.repeat((4 - (current.replace(/\s+/g, '').length % 4)) % 4);
    let decoded = '';
    try {
      decoded = Buffer.from(padded, 'base64').toString('utf8');
    } catch {
      return { links: [], depth };
    }
    if (!decoded || decoded === current) return { links: [], depth };
    current = decoded.trim();
  }
  return { links: [], depth: 4 };
}

const published = decode(body);
if (published.links.length === 0) {
  // This is exactly what a wrong key produces: btoa() of random bytes.
  console.error(`FAIL the published body decoded to 0 vmess links after ${published.depth} base64 layer(s) — wrong key or empty payload`);
  console.error(`  body: ${body.length} bytes, starts ${JSON.stringify(body.slice(0, 40))}`);
  process.exit(1);
}

const emojiPath = path.join(artifactDir, 'vpn_node_emoji.txt');
if (!existsSync(emojiPath)) {
  console.error(`FAIL no vpn_node_emoji.txt in ${artifactDir} to compare against`);
  process.exit(1);
}
const measured = new Set(
  readFileSync(emojiPath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
);
// Links carry a country emoji prefix in the artifact; the published list is the
// same strings, so compare on the vmess body only.
const strip = (link) => {
  const at = link.indexOf('vmess://');
  return at === -1 ? link : link.slice(at);
};
const measuredBodies = new Set([...measured].map(strip));
const overlap = published.links.filter((link) => measuredBodies.has(strip(link)));

console.log(`published links: ${published.links.length} (decoded through ${published.depth} base64 layer(s))`);
console.log(`measured links:  ${measured.size}`);
console.log(`overlap:         ${overlap.length}`);
if (overlap.length === 0) {
  console.error('FAIL the published subscription contains none of the links this run measured — it is stale or from another run');
  process.exit(1);
}
console.log('OK the published subscription serves this run\'s payload');
