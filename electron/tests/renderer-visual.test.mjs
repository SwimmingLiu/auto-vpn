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
  dashboard: 'eb3cc2a52a71c5a6ce0742c93f3d49b987fec518230dd048f3488c000a9d905a',
  config: '040f19a98c2b35525edd6359a8920c9c8a82e5be7fe0e840e7634c2733e10b46',
  runs: '30a33f4361319f63bc6ce112d11a31ac8e3ebdfee7cc40689b0a15b3e80643a8',
  history: '7789101e98baf182cdb97d5ce82d7f41b889082a1f8fd886347d73c2f4638b0d',
  nodes: '3618362c61debd00dc4d7604309ad365f4bc14c22ca543a092e573e38f194bf7',
  subscriptions: '6fc3a5807f1baa6155cbdfb6a7ddee975fabc8a459bd3e4940e98b9d93228726',
  logs: '3d8a7ae9d981bc1c11b1cf8a688d4892edcc01dd8101ffb489579b03d79cd639',
  deploy: '302e370ea5217fc370985d3db628ffe229d973d8aa86f821118e5c7f2d99c0b4',
  monitor: '7b6629e693bddac55fbe41306b568c8a5a93dd183631a7d9873ad47db6fd0949',
  settings: 'ae1d25d6b999ed58cc2b57bde23cc2fd74eaf114925d149fdf8eea7512bd3025',
  about: '4235924b8a56722b07cc9e4fbf892dd1287ea05b390f409d4038abd5fa8dc5d5'
};

const VISUAL_CASES = [
  ['dashboard', '#navDashboard', '#dashboardOverview'],
  ['config', '#navConfig', '#configPrimarySource'],
  ['runs', '#navRuns', '#runsLogOutput'],
  ['history', '#navHistory', '#historyTable'],
  ['nodes', '#navNodes', '#nodeTable'],
  ['subscriptions', '#navSubscriptions', '#subscriptionCards'],
  ['logs', '#navLogs', '#logCenterTable'],
  ['deploy', '#navDeploy', '#deployPlatformCard'],
  ['monitor', '#navMonitor', '#monitorCpuCard'],
  ['settings', '#navSettings', '#settings-theme'],
  ['about', '#navAbout', '#aboutArchitecture']
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
