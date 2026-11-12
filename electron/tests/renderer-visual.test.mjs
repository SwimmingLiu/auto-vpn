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
    dashboard: '648db40b62a719b4deac37b2b95aedac39bce2ba4e8614a162e0ceb3b72049e2',
    runs: '6e95e5e5c9e2b8f81d6b128827528f36cdc774a7ca08d5490d86d197131edda3',
    results: '0ccd16a2a754ec92b6e1e6f9bba0a25a2b182d3b6a5d4fa36826e0a6decbe438',
    logs: '17aa54116a49dc1bf92168bb32d440c48e4ef2effe48be16a1a492f686f4940a',
    settings: '04d64f2d076bd8fef9f181b652f308a3c4e18057eaaec88c1578613ad9a0ffd0'
  },
  linux: {
    dashboard: '879f743828a7c17f2044492ac96bf22155002a6eeefadaed1b7cbaa59e3cf06c',
    runs: 'b46887f5a7d91cf2af91b7ddaad3ceff5314aaae399eddd475a82d37183f45aa',
    results: '17c36dd2053361244fa4227673a5822e03210bf8175be4c32b42fbc2541e0054',
    logs: 'e1cbbbaa435dcdca43098fc9fb499609e85e4787243267b6aa4d29d04778d649',
    settings: 'f39c8977860f668d8dbcc30cffd3eae3eb5df2f3151f24406430305e1dad8fd0'
  }
};

const VISUAL_CASES = [
  ['dashboard', '#navDashboard', '#dashboardOverview'],
  ['runs', '#navRuns', '#runsWorkspace'],
  ['results', '#navResults', '#resultsWorkspace'],
  ['logs', '#navLogs', '#logCenterTable'],
  ['settings', '#navSettings', '#settingsWorkspace']
];

test('renderer visual hashes match the five-page workspace', async () => {
  const expectedDigests = EXPECTED_DIGESTS_BY_PLATFORM[process.platform];
  assert.ok(expectedDigests, `renderer visual baselines are not reviewed for ${process.platform}`);
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
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

    if (process.env.UPDATE_RENDERER_DIGESTS === '1') {
      // Baseline regeneration must happen on the OS whose digests are being
      // replaced: Chromium's rasterization differs between macOS and the
      // ubuntu-24.04 runner, so a digest captured elsewhere would fail CI even
      // for an untouched page. The workflow below runs this on the runner.
      console.log(`RENDERER_DIGESTS ${JSON.stringify({ [process.platform]: digests })}`);
      return;
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
