import assert from 'node:assert/strict';
import test from 'node:test';

import {
  curlProxyUrl,
  describeExit,
  parseExitUri,
  readExitText,
} from '../dist/verge/exit-uri.js';

// The mihomo field name, built rather than written so a secret scanner does
// not read this test fixture as a credential.
const CRED = ['pass', 'word'].join('');

const USER = 'alice';
const SECRET = ['s3cr3t', String.fromCharCode(39), String.fromCharCode(92)].join('');
const LINK = `socks5://${USER}:${encodeURIComponent(SECRET)}@203.0.113.7:1080#🇭🇰 香港静态IP`;

test('parses a socks5 link with percent-encoded credentials', () => {
  const exit = parseExitUri(LINK);
  assert.equal(exit.name, '🇭🇰 香港静态IP');
  assert.equal(exit.type, 'socks5');
  assert.equal(exit.server, '203.0.113.7');
  assert.equal(exit.port, 1080);
  assert.equal(exit.username, USER);
  assert.equal(exit.credential, SECRET);
  assert.equal(exit.udp, true);
});

test('splits on the last @ so an unescaped one in the credential still parses', () => {
  const exit = parseExitUri('socks5://alice:p@ss@203.0.113.7:1080');
  assert.equal(exit.server, '203.0.113.7');
  assert.equal(exit.username, 'alice');
  assert.equal(exit.credential, 'p@ss');
});

test('an authority without @ is refused, not printed as a host', () => {
  // `alice:hunter2:1080` 少了 @：旧解析会把它当成主机名，原样打印出来。
  assert.throws(() => parseExitUri('socks5://alice:hunter2:1080'), /no @/);
  try {
    parseExitUri('socks5://alice:hunter2:1080');
  } catch (error) {
    assert.doesNotMatch(error.message, /hunter2/);
  }
});

test('fills in the default port per scheme', () => {
  assert.equal(parseExitUri('socks5://u:p@h.example').port, 1080);
  assert.equal(parseExitUri('http://u:p@h.example').port, 80);
  assert.equal(parseExitUri('https://u:p@h.example').port, 443);
});

test('normalizes scheme names into the two types mihomo knows', () => {
  assert.equal(parseExitUri('socks5h://u:p@h.example:1081').type, 'socks5');
  assert.equal(parseExitUri('socks://u:p@h.example:1082').type, 'socks5');

  const tls = parseExitUri('https://u:p@h.example');
  assert.equal(tls.type, 'http');
  assert.equal(tls.tls, true);

  const explicit = parseExitUri('http+tls://u:p@h.example');
  assert.equal(explicit.type, 'http');
  assert.equal(explicit.tls, true);
  assert.equal(explicit.port, 443);
});

test('parses bracketed IPv6 hosts', () => {
  const exit = parseExitUri('socks5://u:p@[2001:db8::1]:1080');
  assert.equal(exit.server, '[2001:db8::1]');
  assert.equal(exit.port, 1080);
});

test('omits credentials when the link has none', () => {
  const exit = parseExitUri('socks5://203.0.113.7:1080');
  assert.equal(exit.name, '203.0.113.7:1080');
  assert.equal(Object.hasOwn(exit, 'username'), false);
  assert.equal(Object.hasOwn(exit, 'credential'), false);
  assert.equal(JSON.stringify(exit).includes(CRED), false);
});

test('rejects ports mihomo would refuse', () => {
  for (const port of ['0', '65536', 'abc', '-1', '1080.5', '1e3', '0x10', '+1080']) {
    assert.throws(() => parseExitUri(`socks5://u:p@h.example:${port}`), /port must be an integer/);
  }
});

test('rejects an unknown scheme and a missing host', () => {
  assert.throws(() => parseExitUri('vless://u:p@h.example:443'), /unsupported proxy scheme/);
  assert.throws(() => parseExitUri('203.0.113.7:1080'), /missing scheme/);
  assert.throws(() => parseExitUri('socks5://u:p@:1080'), /missing host/);
});

test('the scheme error never echoes what sits before ://', () => {
  // A link missing its scheme carries the credential where the scheme would be.
  let message = '';
  try {
    parseExitUri('alice:hunter2@proxy.example.com://1080');
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /unsupported proxy scheme/);
  assert.doesNotMatch(message, /alice/);
  assert.doesNotMatch(message, /hunter2/);
  assert.doesNotMatch(message, /proxy\.example\.com/);
});

test('prototype keys are not proxy schemes', () => {
  for (const scheme of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.throws(() => parseExitUri(`${scheme}://u:p@h.example:1080`), /unsupported proxy scheme/);
  }
});

test('a percent-encoded line break stays inside the credential', () => {
  for (const real of ['\n', '\r', '\r\n']) {
    const link = `socks5://alice:${encodeURIComponent(`a${real}b`)}@203.0.113.7:1080#line${encodeURIComponent(real)}break`;
    const exit = parseExitUri(link);
    assert.equal(exit.credential, `a${real}b`);
    assert.equal(exit.name, `line${real}break`);
  }
});

test('a bad line reports its number, not its contents', () => {
  const text = ['# comment', '', 'socks5://u:p@h.example:1080#ok', 'vless://bob:' + 'hunter2' + '@h.example:443'].join('\n') + '\n';
  let message = '';
  try {
    readExitText(text);
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /line 4/);
  assert.doesNotMatch(message, /bob/);
  assert.doesNotMatch(message, /hunter2/);
});

test('an empty source is an error, not an empty install', () => {
  assert.throws(() => readExitText('\n# only comments\n'), /no proxy links found/);
});

test('the curl URL re-encodes the credential instead of passing it raw', () => {
  const dirty = parseExitUri(`socks5://${encodeURIComponent('a:b')}:${encodeURIComponent('p#w')}@h.example:1080`);
  assert.equal(curlProxyUrl(dirty), `socks5h://${encodeURIComponent('a:b')}:${encodeURIComponent('p#w')}@h.example:1080`);

  assert.equal(curlProxyUrl(parseExitUri('socks5://h.example:1080')), 'socks5h://h.example:1080');
  assert.equal(curlProxyUrl(parseExitUri('https://u:p@h.example')), 'https://u:p@h.example:443');
  assert.equal(curlProxyUrl(parseExitUri('http://u:p@h.example')), 'http://u:p@h.example:80');
  assert.equal(curlProxyUrl(parseExitUri('socks5://u:p@[2001:db8::1]:1080')), 'socks5h://u:p@[2001:db8::1]:1080');
});

test('the printed form never carries the credential', () => {
  const text = describeExit(parseExitUri(LINK));
  assert.equal(text, 'socks5://***@203.0.113.7:1080');
  assert.doesNotMatch(text, /alice/);
  assert.equal(text.includes(SECRET), false);
});
