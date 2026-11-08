import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  apkDiscoveryFromBytes,
  apkFileName,
  controlPlaneKeyCandidates,
  apkSlot,
  candidateApkUrls,
  cdnConfigUrls,
  dexStrings,
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
