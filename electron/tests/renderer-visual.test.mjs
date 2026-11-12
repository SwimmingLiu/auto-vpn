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
    dashboard: '10af284b7c8999ed51bdc246746c18fa4fef8d2f5a04806abdff6dece2d912a4',
    runs: '70db3dc32ca53f555b0b3ba24f99987b6567aa208e743db458d010b0f2abb53b',
    results: '76887955e8d4880c6299ca757130ee8e90da1dc998506346ef2d8bbf815fba66',
    logs: '4ff5f58a22fcfe810668201fb1b1d9431b38fe7db82cd65002538deae38f9e4c',
    settings: '134183fba03df6a86c2504769b85f3fe76583ee8551046926f356fe4da56b5c4'
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
