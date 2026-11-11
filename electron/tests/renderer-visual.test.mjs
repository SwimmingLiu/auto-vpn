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
    dashboard: '6e459c501cedee82c39298fc0bd4ac7f57852ef1734488fe5c70abd888625394',
    runs: '444e900eba6f4ac1dc7ea6ab3a1ab4cb686c67798c949c5c6065495aa97772ca',
    results: 'acafc749d411ed8239e65b1f4243ece010b17e86969488cddc24b82a591b6840',
    logs: 'a8ef6e2936b76cd75df168694bde3d1160cdafba44f7a2c9a0948d21c4e599a2',
    settings: '443e2f4892166619b48156343f42182b8a8842ffc6a4d484539a71508fda6e02'
  },
  linux: {
    dashboard: '9897ca020058dfcaf9da80de24f882d357b712bee9803db027279ef0334945fd',
    runs: 'd499f8779d7dcf5a6ccb0a84f0703b7448d4aaa75f4efc61a3f2386492de787d',
    results: '5d6efcfbb6c198c413edb4e474157a314b708ec62f7b7f42cef940fe20180190',
    logs: '0175dc381b1cc0461f479ae66833034c8f4ecff0eddac75e3c6e3f128b4f571d',
    settings: '7a1678e4f5c1f9c7adce4f196c2e3553f26d226f3da9149d534f36bf09c574b5'
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
