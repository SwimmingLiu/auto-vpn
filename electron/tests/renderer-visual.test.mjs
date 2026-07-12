import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXPECTED_DIGESTS_BY_PLATFORM = {
  darwin: {
    dashboard: 'c8d7d5cb927bd917148f95be1615b2e7ae3897b9b278441bd94634119003711b',
    runs: 'aeaa065b492713a83c84b944392497c5bb04bf635aa95715c96bf9f1f4ff1789',
    results: 'd3e51557c2061e90235c00445206cc23bbf153a1b4b9e279ea54fa1ea687b318',
    subscriptions: '2ab3fcab937eda0b6ad010cac25e4d213a57d152a3cb48325421fe3ddc2903d5',
    logs: '6ecb9ebe7da65f2a061b99b0e9df6283f20addb9c8410e9c0376675b5bc504cc',
    settings: 'f15d94bfe17e18c7efe25481c78bd158bb9a10e438fe824540e8dda549c4dc36'
  },
  linux: {
    dashboard: '675f3b0895f9430afb31b6d9bb10c6b3577654a021c2ced72b493a8aebd5acf0',
    runs: '4ca6b6fd1d58db366b4aeac1eb54553e65f9e5e7d732c3a47e82a401981abc9a',
    results: '4903b6fedc59e39c4af5a08bd35ec601bb11c2bce2595df9f1fadb0a7b8bd3f1',
    subscriptions: '267278ad45eaef932766446343812841f804d80638740c52421bf1fd427a11aa',
    logs: 'e1d90b1d5fd245f45c446d9c146829753118512fd8e4ee82dead3248683be487',
    settings: '7c2197ed283bdf331b166e9c480fe9664ea7362e741d9da77ff881c766f7d7ac'
  }
};

const VISUAL_CASES = [
  ['dashboard', '#navDashboard', '#dashboardOverview'],
  ['runs', '#navRuns', '#runsWorkspace'],
  ['results', '#navResults', '#resultsWorkspace'],
  ['subscriptions', '#navSubscriptions', '#subscriptionCards'],
  ['logs', '#navLogs', '#logCenterTable'],
  ['settings', '#navSettings', '#settingsWorkspace']
];

test('renderer visual hashes match the full mockup-driven workspace', async () => {
  const expectedDigests = EXPECTED_DIGESTS_BY_PLATFORM[process.platform];
  assert.ok(expectedDigests, `renderer visual baselines are not reviewed for ${process.platform}`);
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    const target = `${server.origin}/index.html`;

    await page.addInitScript(() => {
      const fixedNow = 1716363045000;
      Date.now = () => fixedNow;
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
    });
    await page.goto(target);
    await page.waitForSelector('.workspace-shell');
    // Warm one frame so later page captures don't depend on cold rasterization state.
    await page.screenshot({ animations: 'disabled' });

    const digests = {};
    for (const [name, navSelector, readySelector] of VISUAL_CASES) {
      if (name !== 'dashboard') {
        await page.evaluate((selector) => {
          document.querySelector(selector)?.click();
        }, navSelector);
      }
      await page.waitForSelector(readySelector);
      await page.waitForTimeout(120);
      const buffer = await page.screenshot({ animations: 'disabled' });
      digests[name] = crypto.createHash('sha256').update(buffer).digest('hex');
    }

    assert.deepEqual(digests, expectedDigests);
  } finally {
    await browser?.close();
    await server.close();
  }
});

async function startStaticServer(rootDir) {
  const server = http.createServer(async (request, response) => {
    const url = request.url === '/' ? '/index.html' : request.url;
    const filePath = path.join(rootDir, url);
    try {
      const body = await fs.readFile(filePath);
      response.writeHead(200, { 'Content-Type': contentType(filePath) });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html';
  if (filePath.endsWith('.js')) return 'text/javascript';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'text/plain';
}
