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
  dashboard: '54b7bd2c2a6c291c79629ea115f56086c7f5595874fbe87e830a93992e33aed4',
  config: '68055da12dc344175c4cda8cdee4553425e9269110ad8d7cb2d5cb113069c599',
  runs: '0ddd7fa766c305b3afd3e9c1194d3dca1d91453d0c06b6eb5c638c100586a0d4',
  history: '574811aa93934ef64552aad7318fa13d055a0fbb2ad13f23b72e292f02eb6b77',
  nodes: 'c5ef2cd0ac79819fa201c0d0af88b1598f46ca4c848380cf7c65e68efe014da6',
  subscriptions: '5aa9eb1f232e3a65a3c23f1ff112f222512d9844ab4cff762f39447458d25edd',
  logs: 'e3ac2e0cd93b65a9dfe3a72dffe42ba23dca7534609f3774af47db33cd7fbcc1',
  deploy: '3da5fed081b5f17d2b56f18f2c2eb3145e3ba656876b0fa0f443e8fffc631d58',
  monitor: 'b66b23562f394dcb673a4a1f2cfff0282dfc8bb57038cf11620f3ef8ea5b3963',
  settings: '322bac73649ca1163a9abc351a8a3910cef6d1e98deeb0c67147fc05c6457d71',
  about: '5565bdcb014f04927b49016860d0995f555a5d47e4a1d10d1a7f3607dcddaa65'
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
  ['settings', '#navSettings', '#settingsLanguage'],
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
