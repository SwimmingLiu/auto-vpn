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
    dashboard: '467b324e8d4b9abc77e4148bb9ac891f6df41433c8b796453d9eb27e6587a842',
    runs: 'c76a4add50065ba121a0cb8175fa7be6370b9e2ccb50c694f2f34fcab6b22ac9',
    results: '68dd49e778e74223c346a0eb2515e2cc2ace8a3051a38df44fd35ddcb6a4b4d6',
    subscriptions: '53a4b19b870124028169ccc0e5d2cea19e4a9771ff45de96c7f46169b1d15449',
    logs: '91aa2f3a9ac32e1f5823f44900f0783eb2a7f1cdf85137ec2699f4067db83061',
    settings: 'f9f143698cede1832e2907f3f793257d4dcdd5cc1434ac12b8df98022ceb482e'
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
