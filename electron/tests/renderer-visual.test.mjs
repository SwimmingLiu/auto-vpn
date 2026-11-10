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
    dashboard: '31a38aa7efbbea6f92a9068ee93e7a057736de210c5c138048eb62d49226a679',
    runs: '88e8e4cb379a2aa5fdc218d5834d29285a5ba14bfaddc41894a649b360166014',
    results: 'b3be55a00edf8e3ac34f5c4a5958ea6094d1502317ab0770089347bd02d31b82',
    logs: 'd14664409435a0eb382eea3e3da61b164f381520694ae3ad7d12670a69a798e9',
    settings: '8e53c3a8ff3bdefc91ca2fafc591d4a99ed3143912ae9bd2e99305039a1ec8d1'
  },
  linux: {
    dashboard: '0dbde9e10a9d2b2e7035010e309f2aa2b4cf4a67356884383399321d40961999',
    runs: '18c3f0eba4df6a2c3ca0da5a8983b847ab728b39c2dde695fc8e6fedaf8bb86c',
    results: '689fff11525014c61387b310d2d760f783483515b2961bd52d0cec15d9f5b73c',
    logs: 'e0e78dc63dfb1e5787b2731d6d96d697ba2216d137460cc07fb25da90b1276cf',
    settings: '3186505a951635844403a4d7887e914e7d0a8703add20f494dd30e6f3dde3773'
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
