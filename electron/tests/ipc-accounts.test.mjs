import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliRoot = path.join(projectRoot, 'npm', 'autovpn-cli');

// The fixture runs the real CLI, so its compiled entry has to exist. Same guard
// the backend contract tests use when they are run on their own.
if (!fs.existsSync(path.join(cliRoot, 'dist', 'cli', 'main.js'))) {
  const built = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '--prefix', cliRoot], {
    cwd: projectRoot,
    encoding: 'utf-8'
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
}

/**
 * `electron` resolves to a binary path outside Electron, so the IPC module is
 * loaded against a stub that records the registered handlers. Only `ipcMain`
 * is exercised here; the rest of the surface stays inert.
 */
const electronStub = `data:text/javascript,${encodeURIComponent(`
export const handlers = new Map();
export const ipcMain = {
  removeHandler(channel) { handlers.delete(channel); },
  handle(channel, handler) { handlers.set(channel, handler); }
};
export const clipboard = { writeText() {} };
export const shell = { openPath: async () => '', showItemInFolder() {} };
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'electron'
      ? { url: electronStub, shortCircuit: true }
      : nextResolve(specifier, context);
  }
});

const { registerIpcHandlers } = await import('../ipc.js');
const { handlers } = await import(electronStub);
const { AccountStore } = await import('../../npm/autovpn-cli/dist/pool/account-store.js');

/**
 * A project root the backend can actually run from: the CLI entry is looked up
 * under `<root>/npm/autovpn-cli`, so the built package is linked in rather than
 * copied. State stays in the temporary directory.
 */
function createFixture(t, { account } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-ipc-accounts-'));
  fs.mkdirSync(path.join(root, 'npm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.symlinkSync(
    path.join(projectRoot, 'npm', 'autovpn-cli'),
    path.join(root, 'npm', 'autovpn-cli'),
    'dir'
  );
  const dbPath = path.join(root, 'accounts.db');
  if (account) {
    const store = new AccountStore({ dbPath });
    store.importRecords([{
      brand: 'leiting',
      account,
      password: 'fixture-password',
      // A host that cannot resolve: the login fails fast and deterministically
      // instead of depending on a vendor's answer.
      official_site: 'https://fixture.invalid',
      expires_at: '',
      status: 'active',
      note: ''
    }]);
    store.close();
  }
  const previousDb = process.env.VPN_AUTOMATION_ACCOUNTS_DB;
  const previousRuntime = process.env.VPN_AUTOMATION_RUNTIME_ROOT;
  process.env.VPN_AUTOMATION_ACCOUNTS_DB = dbPath;
  process.env.VPN_AUTOMATION_RUNTIME_ROOT = root;
  const api = registerIpcHandlers({
    mainWindow: { isDestroyed: () => true, webContents: { send() {} } },
    projectRoot: root,
    runtimeProfilePath: path.join(root, 'state', 'profile.toml'),
    runtimeArtifactsPath: path.join(root, 'artifacts')
  });
  t.after(() => {
    api.dispose();
    if (previousDb === undefined) delete process.env.VPN_AUTOMATION_ACCOUNTS_DB;
    else process.env.VPN_AUTOMATION_ACCOUNTS_DB = previousDb;
    if (previousRuntime === undefined) delete process.env.VPN_AUTOMATION_RUNTIME_ROOT;
    else process.env.VPN_AUTOMATION_RUNTIME_ROOT = previousRuntime;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dbPath };
}

test('the expiry sweep returns its outcome even when the worker exits non-zero', async (t) => {
  // The worker exits 1 when any account failed but still prints the full JSON
  // outcome. runCommand prefers stderr for the error message, so reading the
  // outcome out of that message loses it the moment node writes anything to
  // stderr — the panel then showed a loader trace instead of the counts.
  createFixture(t, { account: 'fixture-user' });
  const handler = handlers.get('accounts:refresh-expiry');
  assert.equal(typeof handler, 'function');
  const result = await handler(null, {});
  assert.equal(result.checked, 1, 'the outcome body must survive the non-zero exit');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].brand, 'leiting');
  // The vendor is unreachable, so the row is either failed or retired — never a
  // bare error string, which is what the lost body used to produce.
  assert.ok(['failed', 'retired'].includes(result.results[0].status), result.results[0].status);
  assert.equal(Number(result.failed) + Number(result.retired), 1);
  // The masked account is what the panel renders; a raw credential must not
  // reach the renderer through this path.
  assert.ok(!JSON.stringify(result).includes('fixture-password'));
});

test('an empty pool sweeps cleanly through the same channel', async (t) => {
  createFixture(t);
  const result = await handlers.get('accounts:refresh-expiry')(null, {});
  assert.equal(result.checked, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.results, []);
});