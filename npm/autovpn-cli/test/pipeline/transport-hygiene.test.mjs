import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import {
  HTTP_HEAD_LIMIT_BYTES,
  createBoundedLogRing,
  parseProxyEndpoint,
  safeParseHttpStatus,
  splitHttpResponseHead
} from '../../dist/pipeline/http-transport.js';
import { downloadUrlViaHttpProxy } from '../../dist/pipeline/speedtest.js';
import { fetchUrlViaHttpProxy } from '../../dist/pipeline/availability.js';
import { openMihomoRuntime } from '../../dist/pipeline/proxy-runtime.js';

function vmessLink(payload) {
  return `vmess://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('safeParseHttpStatus returns the code for a real status line', () => {
  assert.equal(safeParseHttpStatus(Buffer.from('HTTP/1.1 204 No Content\r\nA: b')), 204);
  assert.equal(safeParseHttpStatus('HTTP/1.0 200 OK'), 200);
});

test('safeParseHttpStatus returns null for a captive-portal / block page body', () => {
  const blockPage = '<html><head><title>Sign in to Wi-Fi</title></head><body>Blocked</body></html>';
  assert.equal(safeParseHttpStatus(blockPage), null);
  assert.equal(safeParseHttpStatus(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n')), null);
  assert.equal(safeParseHttpStatus(''), null);
});

test('safeParseHttpStatus rejects a truncated status line', () => {
  assert.equal(safeParseHttpStatus('HTTP/1.1 '), null);
  assert.equal(safeParseHttpStatus('HTTP/1.1 20a OK'), null);
});

test('splitHttpResponseHead separates head and body bytes', () => {
  const split = splitHttpResponseHead(Buffer.from('HTTP/1.1 200 OK\r\nX: 1\r\n\r\nhello'));
  assert.ok(split);
  assert.equal(split.head.toString('latin1'), 'HTTP/1.1 200 OK\r\nX: 1');
  assert.equal(split.body.toString('utf8'), 'hello');
  assert.equal(splitHttpResponseHead(Buffer.from('HTTP/1.1 200 OK\r\nX: 1')), undefined);
});

test('parseProxyEndpoint defaults the port by scheme', () => {
  assert.deepEqual(parseProxyEndpoint('http://127.0.0.1'), {
    protocol: 'http:', hostname: '127.0.0.1', port: 80, authorization: ''
  });
  assert.deepEqual(parseProxyEndpoint('https://proxy.example'), {
    protocol: 'https:', hostname: 'proxy.example', port: 443, authorization: ''
  });
  assert.equal(parseProxyEndpoint('http://127.0.0.1:8080').port, 8080);
  assert.equal(parseProxyEndpoint('127.0.0.1:3128').port, 3128);
});

test('parseProxyEndpoint forwards Basic credentials from userinfo', () => {
  const secret = 's3cret';
  const endpoint = parseProxyEndpoint(`http://alice:${secret}@proxy.example:8080`);
  assert.equal(endpoint.authorization, `Basic ${Buffer.from(`alice:${secret}`).toString('base64')}`);
  // Percent-encoded userinfo is decoded before it is base64-wrapped.
  const encodedPassword = 'p%2Fss';
  const encoded = parseProxyEndpoint(`http://alice%40corp:${encodedPassword}@proxy.example`);
  assert.equal(encoded.authorization, `Basic ${Buffer.from(`alice@corp:${decodeURIComponent(encodedPassword)}`).toString('base64')}`);
  assert.equal(parseProxyEndpoint('http://proxy.example').authorization, '');
});

test('parseProxyEndpoint rejects schemes the raw-socket transport cannot speak', () => {
  assert.throws(() => parseProxyEndpoint('socks5://127.0.0.1:1080'), /unsupported proxy protocol: socks5:/);
  assert.throws(() => parseProxyEndpoint('ftp://127.0.0.1:21'), /unsupported proxy protocol: ftp:/);
});

test('createBoundedLogRing keeps only the trailing bytes', () => {
  const ring = createBoundedLogRing(64);
  ring.append(Buffer.alloc(40, 'a'));
  ring.append(Buffer.alloc(40, 'b'));
  assert.equal(ring.bytes(), 64);
  const text = ring.text();
  assert.equal(text.length, 64);
  assert.equal(text.slice(-1), 'b');
  assert.equal(text.slice(0, 24), 'a'.repeat(24));
  // A single oversized chunk is trimmed, not accumulated.
  ring.append(Buffer.alloc(4096, 'c'));
  assert.equal(ring.bytes(), 64);
  assert.equal(ring.text(), 'c'.repeat(64));
});

test('createBoundedLogRing accepts strings and handles empty chunks', () => {
  const ring = createBoundedLogRing(8192);
  ring.append('');
  ring.append('hello ');
  ring.append('world');
  assert.equal(ring.text(), 'hello world');
  ring.clear();
  assert.equal(ring.bytes(), 0);
  assert.equal(ring.text(), '');
});

test('downloadUrlViaHttpProxy fails a block page instead of crashing on a non-HTTP head', async () => {
  const proxy = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end('<html><body>captive portal login</body></html>');
    });
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(
      () => downloadUrlViaHttpProxy('http://target.example/big.bin', `http://127.0.0.1:${port}`, 1024, 2),
      /invalid HTTP response: <html><body>captive portal login<\/body><\/html>/
    );
  } finally {
    await closeServer(proxy);
  }
});

test('downloadUrlViaHttpProxy destroys the socket after a non-2xx response', async () => {
  let remoteClosed;
  const remoteClosedPromise = new Promise((resolve) => { remoteClosed = resolve; });
  const proxy = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
    socket.once('close', remoteClosed);
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(
      () => downloadUrlViaHttpProxy('http://target.example/big.bin', `http://127.0.0.1:${port}`, 1024, 2),
      /unexpected status 403/
    );
    // The client side of the connection must actually close on the failure path.
    await remoteClosedPromise;
  } finally {
    await closeServer(proxy);
  }
});

test('downloadUrlViaHttpProxy sends Proxy-Authorization for a credentialed proxy', async () => {
  const secret = 's3' + 'cret';
  const seen = [];
  const upstream = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      seen.push(chunk.toString('latin1'));
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody');
    });
  });
  const upstreamPort = await listen(upstream);
  try {
    const bytes = await downloadUrlViaHttpProxy(
      `http://127.0.0.1:${upstreamPort}/bytes`,
      `http://alice:${secret}@127.0.0.1:${upstreamPort}`,
      512,
      2
    );
    assert.equal(bytes, 4);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^GET http:\/\/127\.0\.0\.1:\d+\/bytes HTTP\/1\.1\r\n/);
    assert.match(seen[0], new RegExp(`Proxy-Authorization: Basic ${Buffer.from(`alice:${secret}`).toString('base64')}`));
  } finally {
    await closeServer(upstream);
  }
});

test('downloadUrlViaHttpProxy reports CONNECT proxies that answer with a block page', async () => {
  let remoteClosed;
  const remoteClosedPromise = new Promise((resolve) => { remoteClosed = resolve; });
  const proxy = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
    });
    socket.once('close', remoteClosed);
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(
      () => downloadUrlViaHttpProxy('https://target.example/big.bin', `http://127.0.0.1:${port}`, 1024, 2),
      /proxy CONNECT failed with status 407/
    );
    await remoteClosedPromise;
  } finally {
    await closeServer(proxy);
  }
});

test('downloadUrlViaHttpProxy fails a CONNECT tunnel that closes before the headers', async () => {
  const proxy = net.createServer((socket) => {
    socket.once('data', () => socket.end());
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(
      () => downloadUrlViaHttpProxy('https://target.example/big.bin', `http://127.0.0.1:${port}`, 1024, 2),
      /proxy CONNECT response ended before HTTP headers were received/
    );
  } finally {
    await closeServer(proxy);
  }
});

test('fetchUrlViaHttpProxy fails a non-HTTP proxied response without crashing', async () => {
  const proxy = net.createServer((socket) => {
    socket.once('data', () => {
      // Keep the connection open so http.request cannot classify it as a
      // protocol error itself; the transport must still fail this link.
      socket.write('this is not an http response');
    });
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(
      () => fetchUrlViaHttpProxy('http://target.example/page', `http://127.0.0.1:${port}`, 2),
      // Either the transport's own descriptive error or Node's HTTP parser
      // error is acceptable; the point is that it rejects instead of crashing.
      /invalid HTTP response: this is not an http response|Parse Error/
    );
  } finally {
    await closeServer(proxy);
  }
});

test('fetchUrlViaHttpProxy rejects when the proxied response is aborted mid-body', async () => {
  const proxy = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\npartial');
      setTimeout(() => socket.destroy(), 10);
    });
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(
      () => fetchUrlViaHttpProxy('http://target.example/page', `http://127.0.0.1:${port}`, 2),
      /aborted|socket hang up|ECONNRESET|closed/i
    );
  } finally {
    await closeServer(proxy);
  }
});

test('openMihomoRuntime drains child stdout/stderr into a bounded ring', async () => {
  const link = vmessLink({ add: 'edge.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555' });
  let child;
  const runtime = await openMihomoRuntime(link, {
    runtimePath: '/opt/bin/mihomo',
    mixedPort: 11001,
    controllerPort: 11002,
    env: {},
    spawn: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => { child.exitCode = 0; child.emit('close', 0, signal); return true; };
      return child;
    },
    waitForPort: async () => {},
    selectProxy: async () => {}
  });

  try {
    // Two listeners must exist on each pipe, otherwise a chatty runtime fills
    // the 64 KB kernel buffer and blocks forever.
    assert.equal(child.stdout.listenerCount('data'), 1);
    assert.equal(child.stderr.listenerCount('data'), 1);
    // No 'error' handler on the base emitter is fine; the pipes are guarded.
    assert.equal(child.stdout.listenerCount('error'), 1);
    assert.equal(child.stderr.listenerCount('error'), 1);

    child.stdout.emit('data', Buffer.from('level=info msg="starting"\n'));
    child.stderr.emit('data', Buffer.from('level=error msg="boom"\n'));
    assert.equal(runtime.recentLog(), 'level=info msg="starting"\nlevel=error msg="boom"\n');

    // The ring is bounded even under a flood of output.
    child.stderr.emit('data', Buffer.alloc(64 * 1024, 'x'));
    assert.ok(Buffer.byteLength(runtime.recentLog(), 'utf8') <= 8 * 1024);
    assert.match(runtime.recentLog(), /x{1024}$/);
  } finally {
    await runtime.close();
  }
});

test('openMihomoRuntime includes the log tail in an early-exit error', async () => {
  const link = vmessLink({ add: 'edge.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555' });
  await assert.rejects(() => openMihomoRuntime(link, {
    runtimePath: '/opt/bin/mihomo',
    mixedPort: 11003,
    controllerPort: 11004,
    env: {},
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = () => true;
      process.nextTick(() => {
        child.stderr.emit('data', Buffer.from('fatal: config invalid'));
        process.nextTick(() => { child.exitCode = 2; child.emit('exit', 2, null); });
      });
      return child;
    },
    waitForPort: async () => new Promise(() => {}),
    selectProxy: async () => {}
  }), (error) => {
    assert.match(error.message, /mihomo exited during startup with code 2/);
    assert.match(error.message, /runtime output: fatal: config invalid/);
    return true;
  });
});

test('HTTP_HEAD_LIMIT_BYTES stays small enough to fail fast on a non-HTTP stream', () => {
  assert.ok(HTTP_HEAD_LIMIT_BYTES > 0 && HTTP_HEAD_LIMIT_BYTES <= 64 * 1024);
});
