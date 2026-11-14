#!/usr/bin/env node
/**
 * Assemble the account pool for CI without putting 57 KB of credentials in one
 * repository secret.
 *
 * GitHub Actions has no file secrets. A repository secret is a single string,
 * and while 48 KB is under the 48 KB limit only for small pools, the real
 * constraint is that editing one huge value in the UI is unusable and there is
 * no way to rotate a single vendor's block.
 *
 * So the pool is split across N secrets named ACCOUNTS_PART_1..N, each holding
 * a base64 slice. This verifies they reassemble to the exact original bytes
 * before anything imports them: a truncated or reordered part would otherwise
 * import 600 working accounts and silently drop 31.
 *
 * A structural check is not enough — truncating a base64 string still decodes
 * to text that *starts* like a pool, which is why a missing tail would pass.
 * `ACCOUNTS_POOL_SHA256` (and the byte count) pin the exact file.
 *
 * Usage:
 *   node assemble-account-pool.mjs <output-file>
 * Reads ACCOUNTS_PARTS, ACCOUNTS_POOL_SHA256, ACCOUNTS_POOL_BYTES and
 * ACCOUNTS_PART_1..N from the env.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('usage: assemble-account-pool.mjs <output-file>');
  process.exit(2);
}

const count = Number(process.env.ACCOUNTS_PARTS ?? 0);
if (!Number.isInteger(count) || count < 1) {
  console.error('ACCOUNTS_PARTS is unset or not a positive integer');
  process.exit(2);
}

const parts = [];
for (let index = 1; index <= count; index += 1) {
  const value = process.env[`ACCOUNTS_PART_${index}`];
  if (!value) {
    console.error(`ACCOUNTS_PART_${index} is missing (ACCOUNTS_PARTS=${count})`);
    process.exit(1);
  }
  parts.push(value);
}

let decoded;
try {
  decoded = Buffer.from(parts.join(''), 'base64').toString('utf8');
} catch (error) {
  console.error(`the joined parts are not valid base64: ${error.message}`);
  process.exit(1);
}

// A pool is a list of `[brand]` blocks or a CSV header plus rows. Anything
// else means the parts did not come from one file.
if (!/^\s*\[/.test(decoded) && !/^brand\s*,/.test(decoded)) {
  console.error('the assembled pool starts with neither a [brand] block nor a brand CSV header');
  console.error(`  starts: ${JSON.stringify(decoded.slice(0, 60))}`);
  process.exit(1);
}

const rows = decoded.split('\n').filter((line) => line.trim()).length;

// The structural check above cannot see a missing tail: a base64 prefix still
// decodes to a pool-shaped prefix. Pin the exact file instead of trusting
// shape, or a truncated upload imports most of the pool and reports success.
const bytes = Buffer.byteLength(decoded, 'utf8');
const expectedBytes = Number(process.env.ACCOUNTS_POOL_BYTES ?? 0);
if (expectedBytes > 0 && bytes !== expectedBytes) {
  console.error(`assembled ${bytes} bytes, expected ${expectedBytes} — a part is truncated or out of order`);
  process.exit(1);
}
const expectedSha = String(process.env.ACCOUNTS_POOL_SHA256 ?? '').trim().toLowerCase();
if (expectedSha) {
  const actual = createHash('sha256').update(decoded, 'utf8').digest('hex');
  if (actual !== expectedSha) {
    console.error(`sha256 ${actual} does not match the pinned ${expectedSha} — the parts are not this pool`);
    process.exit(1);
  }
}

writeFileSync(target, decoded, { mode: 0o600 });
// Counts only: the file itself is credentials.
console.log(`assembled ${bytes} bytes, ${rows} non-blank lines, from ${count} secret part(s)`);
if (!expectedSha && !(expectedBytes > 0)) {
  console.log('note: neither ACCOUNTS_POOL_SHA256 nor ACCOUNTS_POOL_BYTES is set, so only the shape was checked');
}
