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
    dashboard: '11e6a04f3d7efe14c3e4e665ce0920f67b7ab2b880e349f217528d7288d281b8',
    runs: '19af2f410354c1213f41977dfade2b663f076e2a9055c6f83d63aac3a4e7f127',
    results: 'c92bb9774e2ce2e183567c77f1a15c44c795c2ed80492f9c53c6f189820e6502',
    logs: 'bb7090d73681b5bf54719f733e187ee32f0968a4c255d68f09b21217006675db',
    settings: '23c22ff9abedd85be00f9d8d086b3776f9cd6cb2fed4a1b1a84704d97b9845cc'
  },
  linux: {
    dashboard: '04eed4e4711a4fa2a7802c94467c08b5eec8fa2f3ae4ddba4e8a8b65cded8d7f',
    runs: '7be7eba90d552fa275bff8b87f6041c886908f69ea2fee0ffe91eadbf67fec4c',
    results: '16876d450a0fb703dd1a84e46af24ec7608d6e6cc517a3cab4ef2a7b8acb0dc2',
    logs: '1f262b03a8cf42c1f2d23b7d616a97b603752d277c7d82ff9d9be82b76fe68ef',
    settings: '959838ec31720e47adf0b46eccad243f291331c4d4e622f882b7af9f0ec7d473'
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
