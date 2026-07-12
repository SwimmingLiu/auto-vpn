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
    dashboard: '945060b5405a680c1c4c6993c522cbc483f1c3df39597b661c2b8012274d6e56',
    runs: 'ba825da9946a876ec4cb0e781d1a4a874460d0e9fe66f3a67ba39b6b552b7dad',
    results: '0b5b3dbf09902f3761b99dfee55d49e3e128fb6b96c88af70ae6eeb842f43d1b',
    subscriptions: 'be35d2220f6a35096901b8e420f1318553dcab4a1975e609df6052716c4bdaf4',
    logs: 'd4b0e5912c5916c32197815972ae24b30e4bf48b009ba7989c37f713c650a938',
    settings: '786761cebfbca0799ef48e4ab1723cc103293e8d1239df8d5176ec9a03046d3f'
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
