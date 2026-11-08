import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  apkDiscoveryFromBytes,
  apkFileName,
  axmlStrings,
  certificateSha1,
  controlPlaneKeyCandidates,
  apkSlot,
  candidateApkUrls,
  cdnConfigUrls,
  dexStrings,
  firstCertificateFromPkcs7,
  inlineDownloadSpec,
  manifestIdentity,
  parseCdnConfig,
  seedDomains
} from '../../dist/pipeline/apk-discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

test('seedDomains keeps only the :20000 control plane and drops sample hosts', () => {
  const literals = [
    'http://www.example.com',
    'http://www.google.com',
    'https://www.google.com/dfp/debugSignals',
    'https://www.ldbjt.cc:20000',
    'https://www.lztyt.cc:20000',
    'https://www.l8el3t.info:20000',
    'https://unrelated.example.org/path'
  ];
  assert.deepEqual(seedDomains(literals), [
    'https://www.ldbjt.cc:20000',
    'https://www.lztyt.cc:20000',
    'https://www.l8el3t.info:20000'
  ]);
});

test('seedDomains tolerates the bare form and normalises the port', () => {
  assert.deepEqual(seedDomains(['https://www.a1b2.cc']), ['https://www.a1b2.cc:20000']);
});

test('apkSlot follows the brand formula hours*(60/interval)+floor(minutes/interval)', () => {
  const at = (hours, minutes) => new Date(2026, 10, 8, hours, minutes, 0);
  // 雷霆 publishes every 2 minutes: slot = h*30 + m/2
  assert.equal(apkSlot(at(14, 57), 2), 14 * 30 + 28);
  // 旋风 publishes every minute: slot = h*60 + m
  assert.equal(apkSlot(at(14, 57), 1), 14 * 60 + 57);
  // 蜜蜂 publishes every 6 minutes: slot = h*10 + m/6
  assert.equal(apkSlot(at(14, 57), 6), 14 * 10 + 9);
  // 黑洞 publishes every 4 minutes: slot = h*15 + m/4
  assert.equal(apkSlot(at(14, 57), 4), 14 * 15 + 14);
});

test('apkFileName zero-pads the date and joins the brand prefix', () => {
  assert.equal(apkFileName(new Date(2026, 0, 5, 3, 0), 'lt', 92), '20260105_lt92.apk');
});

test('candidateApkUrls walks back one interval per step and covers both hosts', () => {
  const urls = candidateApkUrls(
    ['https://men.example.com', 'https://backup.example.com'],
    'lt',
    new Date(2026, 10, 8, 14, 57, 30),
    2,
    3
  );
  assert.equal(urls.length, 6);
  assert.equal(urls[0], 'https://men.example.com/apks64/20261108_lt448.apk');
  assert.equal(urls[1], 'https://backup.example.com/apks64/20261108_lt448.apk');
  // Two minutes earlier: 14:55 -> slot 447.
  assert.equal(urls[2], 'https://men.example.com/apks64/20261108_lt447.apk');
  assert.equal(urls[4], 'https://men.example.com/apks64/20261108_lt446.apk');
});

test('parseCdnConfig reads both hosts and the archive interval', () => {
  const source = [
    'var cdnurl = "https://men.example.com";',
    'var cdnurl2 = "http://1.2.3.4:25555";',
    'const apk_interval = 2;'
  ].join('\n');
  assert.deepEqual(parseCdnConfig(source), {
    download_hosts: ['https://men.example.com', 'http://1.2.3.4:25555'],
    apk_interval_minutes: 2
  });
});

test('parseCdnConfig drops an empty backup host', () => {
  const source = 'var cdnurl = "https://khh.example.com";\nvar cdnurl2 = "";\nconst apk_interval = 1;';
  assert.deepEqual(parseCdnConfig(source).download_hosts, ['https://khh.example.com']);
  assert.equal(parseCdnConfig(source).apk_interval_minutes, 1);
});

test('inlineDownloadSpec reads the fixed host and cadence from an Android chunk', () => {
  const chunk = "document.querySelector('.download-android').href='https://wpk.example.com/apks64/20261107_mf'+index+'.apk?t='+timestamp;" +
    "const clock=new Date(),index=clock.getHours()*10+Math.floor(clock.getMinutes()/6);";
  assert.deepEqual(inlineDownloadSpec(chunk), {
    host: 'https://wpk.example.com',
    prefix: 'mf',
    interval_minutes: 6
  });
});

test('inlineDownloadSpec returns null when the chunk carries no archive host', () => {
  assert.equal(inlineDownloadSpec('const a = 1;'), null);
});

test('cdnConfigUrls requests the cache-busted root config first', () => {
  const urls = cdnConfigUrls('https://www.example.com/', 1_700_000_000_000);
  assert.deepEqual(urls, [
    'https://www.example.com/cdn.js?t=1700000000',
    'https://www.example.com/cdn.js'
  ]);
});

test('manifestIdentity prefers the package the dex repeats with action suffixes', () => {
  const axml = buildAxmlStrings([
    'com.android.vending.BILLING',
    'com.leiting.lt1794098243',
    '3.17940.98243'
  ]);
  const identity = manifestIdentity(axml, [
    'com.leiting.lt1794098243',
    'com.leiting.lt1794098243.action.activity',
    'Lcom/leiting/lt1794098243/ui/LineActivity;'
  ]);
  assert.equal(identity.package_name, 'com.leiting.lt1794098243');
  assert.equal(identity.version_name, '3.17940.98243');
});

test('manifestIdentity falls back to a dex literal shaped like a package', () => {
  const axml = buildAxmlStrings(['com.example.other', '1.2.3']);
  const identity = manifestIdentity(axml, [
    'com.blackhole.hd1794094649',
    'com.blackhole.hd1794094649.action.service'
  ]);
  assert.equal(identity.package_name, 'com.blackhole.hd1794094649');
});

test('controlPlaneKeyCandidates collects every printable 16-character literal', () => {
  const strings = [
    'ks9KUrbWJj46AftX',
    'awdtif20190619ti',
    'too-short',
    'this-one-is-way-too-long-to-be-a-key',
    'ks9KUrbWJj46AftX',
    'has space in it',
    '1234567890123456'
  ];
  assert.deepEqual(controlPlaneKeyCandidates(strings), [
    'ks9KUrbWJj46AftX',
    'awdtif20190619ti',
    '1234567890123456'
  ]);
});

test('controlPlaneKeyCandidates rejects control and non-ASCII characters', () => {
  // A NUL inside the literal, and a 16-character CJK string.
  const withControl = `abcdefghijklmno\u0000`;
  const withWideChars = 'abcdefghijklmnop'.split('').map(() => '\u4e2d').join('').slice(0, 16);
  assert.deepEqual(controlPlaneKeyCandidates([withControl]), []);
  assert.deepEqual(controlPlaneKeyCandidates([withWideChars]), []);
});

test('dexStrings returns an empty list for a non-dex buffer', () => {
  assert.deepEqual(dexStrings(Buffer.from('not a dex file')), []);
});

test('a real APK yields the package, version, certificate and seeds the app uses', (t) => {
  const apkPath = process.env.AUTOVPN_TEST_APK;
  if (!apkPath) {
    t.skip('AUTOVPN_TEST_APK not set');
    return;
  }
  const buffer = execFileSync('cat', [apkPath], { maxBuffer: 128 * 1024 * 1024 });
  const discovery = apkDiscoveryFromBytes(buffer, 'local');
  assert.match(discovery.package_name, /^com\.[a-z]+\.[a-z]+\d+$/i);
  assert.match(discovery.version_name, /^\d+\.\d+\.\d+$/);
  assert.match(discovery.cert_sha1, /^[0-9A-F]{40}$/);
  assert.ok(discovery.seed_domains.length >= 3);
  assert.ok(discovery.seed_domains.every((value) => value.endsWith(':20000')));
});

/**
 * Minimal AXML writer: a string pool chunk only, which is all the identity
 * reader needs when the manifest carries no typed attribute table.
 */
function buildAxmlStrings(values) {
  // UTF-8 pool entries carry a UTF-16 length and a UTF-8 byte length before
  // the characters, which is what the reader parses when flags has 0x100.
  const encodeUtf8Entry = (value) => {
    const body = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([value.length, body.length]), body, Buffer.from([0])]);
  };
  const encoded = values.map(encodeUtf8Entry);
  const headerSize = 28;
  let stringDataSize = 0;
  const offsets = [];
  for (const entry of encoded) {
    offsets.push(stringDataSize);
    stringDataSize += entry.length + (entry.length % 2);
  }
  const stringData = Buffer.alloc(stringDataSize);
  let cursor = 0;
  for (const entry of encoded) {
    entry.copy(stringData, cursor);
    cursor += entry.length + (entry.length % 2);
  }
  const indexTable = Buffer.alloc(values.length * 4);
  offsets.forEach((value, index) => indexTable.writeUInt32LE(value, index * 4));
  const stringsStart = headerSize + indexTable.length;
  const chunkSize = stringsStart + stringData.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0x0001, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(chunkSize, 4);
  header.writeUInt32LE(values.length, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(0x100, 16);
  header.writeUInt32LE(stringsStart, 20);
  header.writeUInt32LE(0, 24);
  const fileHeader = Buffer.alloc(8);
  fileHeader.writeUInt16LE(0x0003, 0);
  fileHeader.writeUInt16LE(8, 2);
  fileHeader.writeUInt32LE(8 + chunkSize, 4);
  return Buffer.concat([fileHeader, header, indexTable, stringData]);
}

/** Builds a DER SEQUENCE around a payload, using the long form above 127 bytes. */
function derSequence(payload) {
  if (payload.length < 0x80) {
    return Buffer.concat([Buffer.from([0x30, payload.length]), payload]);
  }
  const length = Buffer.alloc(3);
  length[0] = 0x82;
  length.writeUInt16BE(payload.length, 1);
  return Buffer.concat([Buffer.from([0x30]), length, payload]);
}

/**
 * Builds a structurally valid X.509-shaped certificate of a given size.
 * `firstCertificateFromPkcs7` identifies the certificate by structure, not by
 * a field the tests care about, so the body only has to be well formed.
 */
function fakeCertificate(totalLength) {
  const body = Buffer.alloc(Math.max(totalLength - 6, 16), 0x41);
  const tbs = derSequence(body);
  // signatureAlgorithm and signatureValue, both minimally encoded SEQUENCEs.
  const algorithm = derSequence(Buffer.alloc(8, 0x06));
  const signature = derSequence(Buffer.alloc(16, 0x42));
  return derSequence(Buffer.concat([tbs, algorithm, signature]));
}

/** Wraps certificates the way PKCS#7 SignedData does: SEQUENCE { OID, [0] certs }. */
function fakePkcs7(certificates) {
  const signedData = Buffer.concat([
    derSequence(Buffer.alloc(34, 0x2a)),          // SignedData body stand-in
    Buffer.concat([Buffer.from([0xa0]), ...certsPayload(certificates)])
  ]);
  return derSequence(signedData);
}

function certsPayload(certificates) {
  const joined = Buffer.concat(certificates);
  if (joined.length < 0x80) {
    return [Buffer.from([joined.length]), joined];
  }
  const length = Buffer.alloc(3);
  length[0] = 0x82;
  length.writeUInt16BE(joined.length, 1);
  return [Buffer.from([0x82]), length, joined];
}

test('the certificate is chosen by structure, not by size', () => {
  // An RSA-4096 certificate nests a large SubjectPublicKeyInfo; a "shortest
  // SEQUENCE" rule picked that instead. The structural rule ignores size.
  const small = fakeCertificate(400);
  const large = fakeCertificate(1600);
  const blob = fakePkcs7([small, large]);
  const found = firstCertificateFromPkcs7(blob);
  assert.ok(found);
  assert.equal(found.length, small.length);
  assert.equal(certificateSha1(found), certificateSha1(small));
});

test('a certificate carrying a long length encoding is read in full', () => {
  const cert = fakeCertificate(1400);
  const found = firstCertificateFromPkcs7(fakePkcs7([cert]));
  assert.ok(found);
  assert.deepEqual(found, cert);
});

test('a blob without a certificate yields null', () => {
  assert.equal(firstCertificateFromPkcs7(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00])), null);
  assert.equal(firstCertificateFromPkcs7(Buffer.alloc(0)), null);
});

test('a declared string count beyond the buffer is bounded', () => {
  // A corrupt manifest can declare 0xFFFFFFFF entries; before the bound this
  // looped for billions of iterations and pinned the process.
  const pool = Buffer.alloc(64);
  pool.writeUInt16LE(0x0003, 0);
  pool.writeUInt16LE(0x0001, 8);
  pool.writeUInt32LE(0xFFFFFFFF, 16);
  pool.writeUInt32LE(0x200, 24);
  const started = Date.now();
  const values = axmlStrings(pool);
  assert.ok(Array.isArray(values));
  assert.ok(Date.now() - started < 1000);
});

test('an APK whose dex carries a very large string table still parses', () => {
  // `strings.push(...dexStrings(...))` threw RangeError past ~124k literals,
  // which real APKs exceed. The parser now appends instead of spreading.
  const literals = Array.from({ length: 200000 }, (_, index) => `literal_${index}`);
  const ulebSize = (value) => {
    let size = 1;
    let rest = value;
    while (rest >= 0x80) {
      rest = Math.floor(rest / 0x80);
      size += 1;
    }
    return size;
  };
  const writeUleb = (buffer, offset, value) => {
    let cursor = offset;
    let rest = value;
    while (rest >= 0x80) {
      buffer.writeUInt8((rest & 0x7f) | 0x80, cursor);
      rest = Math.floor(rest / 0x80);
      cursor += 1;
    }
    buffer.writeUInt8(rest, cursor);
    return cursor + 1;
  };
  const dataSize = literals.reduce((total, value) => total + ulebSize(value.length) + value.length + 1, 0);
  const dataOffset = 112 + literals.length * 4;
  const dex = Buffer.alloc(dataOffset + dataSize);
  dex.write('dex\n035\0', 0, 'latin1');
  dex.writeUInt32LE(literals.length, 56);       // string_ids_size
  dex.writeUInt32LE(112, 60);                   // string_ids_off
  dex.writeUInt32LE(dataOffset, 104);           // data_off
  let cursor = dataOffset;
  literals.forEach((value, index) => {
    // string_data_off is an absolute file offset, as the parser reads it.
    dex.writeUInt32LE(cursor, 112 + index * 4);
    cursor = writeUleb(dex, cursor, value.length);
    dex.write(value, cursor, 'latin1');
    cursor += value.length;
    dex.writeUInt8(0, cursor);
    cursor += 1;
  });
  const parsed = dexStrings(dex);
  assert.equal(parsed.length, literals.length);
  assert.equal(parsed[0], 'literal_0');
  assert.equal(parsed[literals.length - 1], `literal_${literals.length - 1}`);
});

test('inlineDownloadSpec keeps the published scheme and port', () => {
  // The production downloader recovers the origin verbatim from the chunk, so
  // a brand publishing plain http on a custom port is not rewritten to https.
  const chunk = "const u='http://cdn.example:8080/apks64/20261107_lt'+index+'.apk';" +
    "const clock=new Date(),index=clock.getHours()*4+Math.floor(clock.getMinutes()/15);";
  const spec = inlineDownloadSpec(chunk);
  assert.ok(spec);
  assert.equal(spec.host, 'http://cdn.example:8080');
  assert.equal(spec.prefix, 'lt');
  assert.equal(spec.interval_minutes, 15);
});
