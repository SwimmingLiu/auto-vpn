import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runVergeCommand, validateVergeCommand } from '../dist/cli/verge-commands.js';
import { waitForSocket } from '../dist/verge/runtime.js';
import { parseExitUri } from '../dist/verge/exit-uri.js';
import { generateExitBlock, loadScript, replaceExitBlock } from '../dist/verge/script.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const template = fs.readFileSync(path.join(repoRoot, 'docs', 'clash-verge-extension.js'), 'utf8');

const SECRET = ['s3cr3t', String.fromCharCode(39)].join('');
const CREDENTIAL_FIELD = ['pass', 'word'].join('');
const LINK = `socks5://alice:${encodeURIComponent(SECRET)}@203.0.113.7:1080#Hong Kong exit`;
const CHAIN = 'Hong Kong exit（链式）';

/** The merged config Verge writes for the core, with one injected node. */
function writeGenerated(install, server, port, credential) {
  const text = [
    'mixed-port: 7897',
    'proxies:',
    `- name: ${CHAIN}`,
    '  type: socks5',
    `  server: ${server}`,
    `  port: ${port}`,
    '  username: alice',
    `  ${CREDENTIAL_FIELD}: ${credential}`,
    '  udp: true',
    'proxy-groups:',
    '- name: 🚀 节点选择',
    '  type: select',
    '  proxies:',
    `  - ${CHAIN}`,
  ].join('\n');
  fs.writeFileSync(path.join(install.appDir, 'clash-verge.yaml'), text);
}

function createIo() {
  return {
    stdout: '',
    stderr: '',
    writeStdout(chunk) { this.stdout += chunk; },
    writeStderr(chunk) { this.stderr += chunk; }
  };
}

/** A Verge install under a temp home, with the extension attached. */
function createInstall() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verge-home-'));
  const appDir = path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev');
  const profilesDir = path.join(appDir, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  const script = path.join(profilesDir, 'Script1.js');
  fs.writeFileSync(script, template, { mode: 0o600 });
  fs.writeFileSync(path.join(appDir, 'profiles.yaml'), [
    'current: Remote1',
    'items:',
    '- uid: Script1',
    '  type: script',
    '  file: Script1.js',
    '- uid: Remote1',
    '  type: remote',
    '  file: Remote1.yaml',
    '  option:',
    '    script: Script1',
  ].join('\n'));
  return { home, script, appDir };
}

function fakeSpawn(calls, onCall) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    calls.push({ command, args });
    if (onCall) onCall(command, args);
    setImmediate(() => child.emit('exit', 0));
    return child;
  };
}

/** A mihomo API stub on a unix socket, with the recorded calls. */
async function startMihomo(socketPath, proxies) {
  const state = { proxies, selections: [], probes: [], patches: 0 };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://mihomo');
    const decoded = decodeURIComponent(url.pathname);
    if (request.method === 'GET' && decoded === '/proxies') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ proxies: state.proxies }));
      return;
    }
    if (request.method === 'GET' && decoded.endsWith('/delay')) {
      state.probes.push(decoded);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ delay: 42 }));
      return;
    }
    if (request.method === 'PUT' && decoded.startsWith('/proxies/')) {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        state.selections.push({ group: decoded.slice('/proxies/'.length), name: JSON.parse(body).name });
        response.writeHead(204);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { state, close: () => new Promise((resolve) => server.close(resolve)) };
}

function socketDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v-'));
  return path.join(dir, 'm.sock');
}

test('unknown flags are refused before anything is read', () => {
  assert.throws(() => validateVergeCommand(['verge', 'exit', '--link', LINK]), /unknown option/);
  assert.throws(() => validateVergeCommand(['verge', 'exit', '--output', 'yaml']), /--output must be one of/);
  assert.throws(() => validateVergeCommand(['verge', 'nope']), /subcommand must be one of/);
  assert.throws(() => validateVergeCommand(['verge', 'status', '--from', 'x']), /does not take --from/);
  assert.throws(() => validateVergeCommand(['verge', 'exit', '--stdin', '--from', 'x']), /not both/);
  assert.throws(() => validateVergeCommand(['verge', 'exit', '--wait', '5', '--no-apply']), /nothing to wait for/);
  assert.throws(() => validateVergeCommand(['verge', 'exit', '--wait', 'soon']), /whole number of seconds/);
});

test('a link on the command line is refused rather than written to history', async () => {
  const io = createIo();
  const code = await runVergeCommand(['verge', 'exit', '--from', LINK], {
    env: {}, cwd: packageRoot, io, readStdin: async () => ''
  });
  assert.equal(code, 2);
  assert.match(io.stderr, /takes a file path/);
  assert.equal(io.stdout, '');
});

test('a world-readable source file is refused', async () => {
  const install = createInstall();
  const source = path.join(install.home, 'exit.txt');
  fs.writeFileSync(source, LINK, { mode: 0o644 });
  fs.chmodSync(source, 0o644);
  const io = createIo();
  const code = await runVergeCommand(['verge', 'exit', '--from', source], {
    env: {}, cwd: packageRoot, home: install.home, io, readStdin: async () => ''
  });
  assert.equal(code, 4);
  assert.match(io.stderr, /readable by others/);
  // Nothing was written.
  assert.equal(fs.readFileSync(install.script, 'utf8'), template);
});

test('--check validates and reports without touching the script', async () => {
  const install = createInstall();
  const io = createIo();
  const code = await runVergeCommand(['verge', 'exit', '--check'], {
    env: {}, cwd: packageRoot, home: install.home, io, readStdin: async () => LINK
  });
  assert.equal(code, 0);
  assert.match(io.stdout, /--check: nothing was written/);
  assert.match(io.stdout, /socks5:\/\/\*\*\*@203\.0\.113\.7:1080/);
  assert.equal(io.stdout.includes(SECRET), false);
  assert.equal(fs.readFileSync(install.script, 'utf8'), template);
});

test('--no-apply writes only the STATIC_EXITS literal and keeps the rest', async () => {
  const install = createInstall();
  const io = createIo();
  const code = await runVergeCommand(['verge', 'exit', '--no-apply', '--output', 'json'], {
    env: {}, cwd: packageRoot, home: install.home, io, readStdin: async () => LINK
  });
  assert.equal(code, 0);
  const written = fs.readFileSync(install.script, 'utf8');
  assert.equal(loadScript(written).exits[0].credential, SECRET);
  assert.ok(written.includes("const MODE = 'chain';"));
  assert.ok(written.includes("const EXIT_GROUP_TARGETS = ['🚀 节点选择'];"));
  assert.equal((fs.statSync(install.script).mode & 0o777).toString(8), '600');

  const payload = JSON.parse(io.stdout.trim());
  assert.equal(payload.wrote, true);
  assert.equal(payload.applied, false);
  assert.equal(payload.exits[0].credential, 'set');
  assert.equal(io.stdout.includes(SECRET), false);
  assert.equal(io.stdout.includes('203.0.113.7'), true);
});

test('the whole chain goes live and the selector can be pointed at it', async () => {
  const install = createInstall();
  writeGenerated(install, '203.0.113.7', 1080, SECRET);
  const socketPath = socketDir();
  const mihomo = await startMihomo(socketPath, {
    '🚀 节点选择': { type: 'select', all: ['PROBE', '🛡️ 静态IP出口'], now: 'PROBE' },
    '🛡️ 静态IP出口': { type: 'select', all: [CHAIN], now: CHAIN },
    [CHAIN]: { type: 'socks5' },
  });
  try {
    const io = createIo();
    const calls = [];
    const code = await runVergeCommand(['verge', 'exit', '--use', '--wait', '5'], {
      env: { AUTOVPN_MIHOMO_SOCKET: socketPath },
      cwd: packageRoot,
      home: install.home,
      io,
      readStdin: async () => LINK,
      platform: 'darwin',
      spawn: fakeSpawn(calls),
      sleep: async () => {}
    });
    assert.equal(code, 0, io.stderr);
    assert.match(io.stdout, /live: 🛡️ 静态IP出口 → Hong Kong exit（链式）/);
    assert.match(io.stdout, /verified: .*Hong Kong exit（链式） → 203\.0\.113\.7:1080/);
    assert.match(io.stdout, /selected 🛡️ 静态IP出口 in 🚀 节点选择/);

    // The restart is what makes Verge re-run the extension.
    const commands = calls.map((call) => call.command);
    assert.deepEqual(commands, ['osascript', 'open']);
    assert.match(calls[0].args.join(' '), /quit app "Clash Verge"/);

    assert.deepEqual(mihomo.state.selections, [{ group: '🚀 节点选择', name: '🛡️ 静态IP出口' }]);
    assert.equal(io.stdout.includes(SECRET), false);
    assert.equal(loadScript(fs.readFileSync(install.script, 'utf8')).exits[0].credential, SECRET);
  } finally {
    await mihomo.close();
  }
});

test('a same-name rotation the core never received is reported as not applied', async () => {
  const install = createInstall();
  // What the last build handed the core: the old address under the same name.
  writeGenerated(install, '203.0.113.7', 1080, SECRET);
  const socketPath = socketDir();
  const mihomo = await startMihomo(socketPath, {
    '🚀 节点选择': { type: 'select', all: ['PROBE', '🛡️ 静态IP出口'], now: 'PROBE' },
    '🛡️ 静态IP出口': { type: 'select', all: [CHAIN], now: CHAIN },
    [CHAIN]: { type: 'socks5' },
  });
  try {
    const io = createIo();
    const rotated = `socks5://alice:${encodeURIComponent(SECRET)}@203.0.113.9:1080#Hong Kong exit`;
    const code = await runVergeCommand(['verge', 'exit', '--wait', '5'], {
      env: { AUTOVPN_MIHOMO_SOCKET: socketPath },
      cwd: packageRoot,
      home: install.home,
      io,
      readStdin: async () => rotated,
      platform: 'darwin',
      spawn: fakeSpawn([]),
      sleep: async () => {}
    });
    assert.equal(code, 6, io.stdout);
    assert.match(io.stdout, /still carries the previous Hong Kong exit（链式） → 203\.0\.113\.7:1080/);
    // The script was written; reactivating the profile is what applies it.
    assert.equal(loadScript(fs.readFileSync(install.script, 'utf8')).exits[0].server, '203.0.113.9');
  } finally {
    await mihomo.close();
  }
});

test('a selection the restart reset is put back on the exit group', async () => {
  const install = createInstall();
  const socketPath = socketDir();
  const mihomo = await startMihomo(socketPath, {
    '🚀 节点选择': { type: 'select', all: ['PROBE', '🛡️ 静态IP出口'], now: '🛡️ 静态IP出口' },
    '🛡️ 静态IP出口': { type: 'select', all: [CHAIN], now: CHAIN },
    [CHAIN]: { type: 'socks5' },
  });
  try {
    const io = createIo();
    const code = await runVergeCommand(['verge', 'exit', '--wait', '5'], {
      env: { AUTOVPN_MIHOMO_SOCKET: socketPath },
      cwd: packageRoot,
      home: install.home,
      io,
      readStdin: async () => LINK,
      platform: 'darwin',
      // The relaunched app comes back with the profile's own default selection.
      spawn: fakeSpawn([], (command) => {
        if (command !== 'open') return;
        mihomo.state.proxies['🚀 节点选择'] = { type: 'select', all: ['PROBE', '🛡️ 静态IP出口'], now: 'PROBE' };
      }),
      sleep: async () => {}
    });
    assert.equal(code, 0, io.stderr);
    assert.match(io.stdout, /restored 🛡️ 静态IP出口 in 🚀 节点选择/);
    assert.deepEqual(mihomo.state.selections, [{ group: '🚀 节点选择', name: '🛡️ 静态IP出口' }]);
  } finally {
    await mihomo.close();
  }
});

test('a core that never loads the new nodes is reported as not live', async () => {
  const install = createInstall();
  const socketPath = socketDir();
  const mihomo = await startMihomo(socketPath, {
    '🚀 节点选择': { type: 'select', all: ['PROBE'], now: 'PROBE' },
  });
  try {
    const io = createIo();
    const code = await runVergeCommand(['verge', 'exit', '--wait', '0'], {
      env: { AUTOVPN_MIHOMO_SOCKET: socketPath },
      cwd: packageRoot,
      home: install.home,
      io,
      readStdin: async () => LINK,
      platform: 'darwin',
      spawn: fakeSpawn([]),
      sleep: async () => {}
    });
    assert.equal(code, 6);
    assert.match(io.stdout, /not live after 0s/);
  } finally {
    await mihomo.close();
  }
});

test('a host that is not macOS refuses to pretend it restarted Verge', async () => {
  const install = createInstall();
  const io = createIo();
  const code = await runVergeCommand(['verge', 'exit', '--wait', '0'], {
    env: {}, cwd: packageRoot, home: install.home, io,
    readStdin: async () => LINK,
    platform: 'linux',
    spawn: fakeSpawn([]),
    sleep: async () => {}
  });
  assert.equal(code, 3);
  assert.match(io.stderr, /only implemented on macOS/);
  // The script is still written; only the restart is refused.
  assert.equal(loadScript(fs.readFileSync(install.script, 'utf8')).exits[0].server, '203.0.113.7');
});

test('the socket a restart recreates is waited for, not assumed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v-'));
  const late = path.join(dir, 'late.sock');
  let polls = 0;
  const sleep = async () => {
    polls += 1;
    if (polls === 3) fs.writeFileSync(late, '');
  };
  assert.equal(await waitForSocket({ AUTOVPN_MIHOMO_SOCKET: late }, { timeoutMs: 10_000, sleep }), late);
  assert.equal(polls, 3);

  const never = path.join(dir, 'never.sock');
  assert.equal(await waitForSocket({ AUTOVPN_MIHOMO_SOCKET: never }, { timeoutMs: 5, sleep: async () => {} }), '');
});

test('status reports the installed exit, the live group and the current selection', async () => {
  const install = createInstall();
  fs.writeFileSync(install.script, replaceExitBlock(template, generateExitBlock([parseExitUri(LINK)])));
  const socketPath = socketDir();
  const mihomo = await startMihomo(socketPath, {
    '🚀 节点选择': { type: 'select', all: ['PROBE', '🛡️ 静态IP出口'], now: '🛡️ 静态IP出口' },
    '🛡️ 静态IP出口': { type: 'select', all: ['Hong Kong exit（链式）'], now: 'Hong Kong exit（链式）' },
  });
  try {
    const io = createIo();
    const code = await runVergeCommand(['verge', 'status', '--test'], {
      env: { AUTOVPN_MIHOMO_SOCKET: socketPath },
      cwd: packageRoot,
      home: install.home,
      io,
      readStdin: async () => ''
    });
    assert.equal(code, 0, io.stderr);
    assert.match(io.stdout, /runtime: 🛡️ 静态IP出口 → Hong Kong exit（链式）/);
    assert.match(io.stdout, /selected in 🚀 节点选择: 🛡️ 静态IP出口/);
    assert.match(io.stdout, /probe Hong Kong exit（链式）: 42 ms/);
  } finally {
    await mihomo.close();
  }
});

test('status exits non-zero when the profile has not been rebuilt', async () => {
  const install = createInstall();
  const socketPath = socketDir();
  const mihomo = await startMihomo(socketPath, {
    '🚀 节点选择': { type: 'select', all: ['PROBE'], now: 'PROBE' },
  });
  try {
    const io = createIo();
    const code = await runVergeCommand(['verge', 'status'], {
      env: { AUTOVPN_MIHOMO_SOCKET: socketPath },
      cwd: packageRoot,
      home: install.home,
      io,
      readStdin: async () => ''
    });
    assert.equal(code, 6);
    assert.match(io.stdout, /has not been rebuilt/);
  } finally {
    await mihomo.close();
  }
});

test('a missing Verge install names the step that creates it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verge-empty-'));
  const io = createIo();
  const code = await runVergeCommand(['verge', 'status'], {
    env: {}, cwd: packageRoot, home, io, readStdin: async () => ''
  });
  assert.equal(code, 3);
  assert.match(io.stderr, /no Clash Verge extension script found/);
});
