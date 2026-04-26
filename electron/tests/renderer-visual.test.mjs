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

const EXPECTED_DIGESTS = {
  dashboard: '6e021fbad6b17ab9a0ffdc2d62017a3448cd6d80a608d523a41f0b8ce5caaf94',
  runs: 'bd79fd72888a0c6a02b87abdc4d38c02225fbf7834179eeb85af7e247fc5596e',
  results: 'eecd6f970ddb76743029c6d1af0bd4c60b1dc0355f73aa7ffc08317f3589993f',
  subscriptions: 'defd7383834254eafcf6c315ad89d6dab947258fd384299e80cbabc012682ac2',
  logs: '00304d3005dec0d78c1c08ae6f4e026004a8a039082aca3b87ccff6de1fa80e5',
  settings: '711fe75b37ca08f520af86fd58e8730dda37259c8526f0fd09236a660c9541f9'
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
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    const target = `${server.origin}/index.html`;

    await page.addInitScript(() => {
      const fixedNow = 1716363045000;
      Date.now = () => fixedNow;
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
    });
    await page.goto(target);
    await page.waitForSelector('.workspace-shell');

    const digests = {};
    for (const [name, navSelector, readySelector] of VISUAL_CASES) {
      await page.locator(navSelector).click();
      await page.waitForSelector(readySelector);
      await page.waitForTimeout(120);
      const buffer = await page.screenshot({ animations: 'disabled' });
      digests[name] = crypto.createHash('sha256').update(buffer).digest('hex');
    }

    assert.deepEqual(digests, EXPECTED_DIGESTS);
  } finally {
    await browser.close();
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
  return 'text/plain';
}
