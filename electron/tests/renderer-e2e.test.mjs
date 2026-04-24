import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PAGE_CASES = [
  ['#navDashboard', 'dashboard', '仪表盘总览', '#dashboardOverview'],
  ['#navConfig', 'config', '配置管理', '#configPrimarySource'],
  ['#navRuns', 'runs', '运行任务', '#runsLogOutput'],
  ['#navHistory', 'history', '任务历史', '#historyTable'],
  ['#navNodes', 'nodes', '节点管理', '#nodeTable'],
  ['#navSubscriptions', 'subscriptions', '订阅地址', '#subscriptionCards'],
  ['#navLogs', 'logs', '日志中心', '#logCenterTable'],
  ['#navDeploy', 'deploy', '部署设置', '#deployPlatformCard'],
  ['#navMonitor', 'monitor', '系统监控', '#monitorCpuCard'],
  ['#navSettings', 'settings', '设置', '#settings-theme'],
  ['#navAbout', 'about', '关于', '#aboutArchitecture']
];

test('renderer exposes the full design-mockup workspace and supports page navigation', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const target = `${server.origin}/index.html`;

    await page.addInitScript(() => {
      const fixedNow = 1716363045000;
      Date.now = () => fixedNow;
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
    });
    await page.goto(target);
    await page.waitForSelector('.workspace-shell');

    assert.equal(await page.locator('.sidebar-nav .nav-item').count(), 11);
    assert.equal(await page.locator('.shortcut-action').count(), 4);
    assert.ok(await page.locator('#runBtn').isVisible());
    assert.ok(await page.locator('#stopBtn').isVisible());
    assert.equal(await page.locator('#pageTitle').innerText(), '仪表盘总览');
    assert.match(await page.locator('#pageSubtitle').innerText(), /节点抓取|测速|部署/);

    for (const [navSelector, pageKey, pageTitle, readySelector] of PAGE_CASES) {
      await page.locator(navSelector).click();
      await page.waitForSelector(`${readySelector}`);

      assert.equal(await page.locator('body').getAttribute('data-page'), pageKey);
      assert.equal(await page.locator('#pageTitle').innerText(), pageTitle);
      assert.ok(await page.locator(readySelector).isVisible());
    }

    await page.locator('#shortcutDeploy').click();
    await page.waitForSelector('#deployPlatformCard');
    assert.equal(await page.locator('body').getAttribute('data-page'), 'deploy');

    await page.locator('#shortcutCapture').click();
    await page.waitForSelector('#configPrimarySource');
    assert.equal(await page.locator('body').getAttribute('data-page'), 'config');

    assert.equal(await page.locator('#languageSelect').count(), 0);
    assert.equal(await page.locator('#settingsLanguage').count(), 0);

    const englishMarkup = await page.evaluate(async () => {
      const views = await import('./views.js');
      const i18n = await import('./i18n.js');

      const viewModel = views.buildViewModel(
        {
          profile: null,
          unsubscribe: null,
          stageStatus: {},
          counts: {},
          language: 'en-US',
          activePage: 'dashboard',
          subtabs: {
            config: 'sources',
            logs: 'runtime',
            deploy: 'platform',
            settings: 'general'
          },
          isDemo: false,
          runState: 'idle',
          runResult: 'idle',
          logEntries: [],
          lastUpdateAt: null
        },
        i18n.getMessages('en-US'),
        'en-US'
      );

      return views.buildPageMarkup(
        'dashboard',
        viewModel,
        i18n.getMessages('en-US'),
        'en-US',
        {}
      );
    });

    assert.equal(englishMarkup.includes('English'), false);
    assert.equal(englishMarkup.includes('Local first'), false);
    assert.equal(englishMarkup.includes('Platform'), false);
    assert.equal(englishMarkup.includes('General'), false);
    assert.equal(englishMarkup.includes('Pipeline overview'), false);

    await page.locator('#navDashboard').click();
    await page.waitForSelector('#dashboardOverview');
    assert.equal(await page.locator('#pageTitle').innerText(), '仪表盘总览');
    assert.equal(await page.locator('#runBtn').innerText(), '立即运行');
    assert.equal(await page.locator('#stopBtn').innerText(), '停止运行');
    assert.match(await page.locator('#dashboardOverview').innerText(), /节点抓取|测速|部署/);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    assert.ok(scrollWidth <= innerWidth + 2);
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
