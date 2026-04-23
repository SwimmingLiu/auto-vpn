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
  ['#navRun', 'run', '运行任务', '#runLogOutput'],
  ['#navArtifacts', 'artifacts', '产物与订阅', '#artifactsPanel'],
  ['#navLogs', 'logs', '日志中心', '#logCenterTable'],
  ['#navAbout', 'about', '关于', '#aboutArchitecture']
];

test('renderer exposes only runtime-aligned pages and honest empty states', async () => {
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

    assert.equal(await page.locator('.sidebar-nav .nav-item').count(), 6);
    assert.equal(await page.locator('.shortcut-action').count(), 4);
    assert.ok(await page.locator('#runBtn').isVisible());
    assert.ok(await page.locator('#stopBtn').isVisible());
    assert.equal(await page.locator('#pageTitle').innerText(), '仪表盘总览');
    assert.match(await page.locator('#pageSubtitle').innerText(), /真实功能|运行|配置|日志/);
    assert.match(await page.locator('#dashboardEmptyState').innerText(), /暂无运行数据|尚未运行/);
    assert.equal(await page.locator('button:has-text("暂停")').count(), 0);
    assert.equal(await page.locator('button:has-text("继续")').count(), 0);
    assert.equal(await page.locator('button:has-text("终止")').count(), 0);

    for (const [navSelector, pageKey, pageTitle, readySelector] of PAGE_CASES) {
      await page.locator(navSelector).click();
      await page.waitForSelector(`${readySelector}`);

      assert.equal(await page.locator('body').getAttribute('data-page'), pageKey);
      assert.equal(await page.locator('#pageTitle').innerText(), pageTitle);
      assert.ok(await page.locator(readySelector).isVisible());
    }

    await page.locator('#shortcutArtifacts').click();
    await page.waitForSelector('#artifactsPanel');
    assert.equal(await page.locator('body').getAttribute('data-page'), 'artifacts');

    await page.locator('#shortcutConfig').click();
    await page.waitForSelector('#configPrimarySource');
    assert.equal(await page.locator('body').getAttribute('data-page'), 'config');

    await page.locator('#navDashboard').click();
    await page.waitForSelector('#dashboardOverview');
    await page.locator('#languageSelect').selectOption('en-US');
    await page.waitForTimeout(100);

    assert.equal(await page.locator('#pageTitle').innerText(), 'Dashboard');
    assert.equal(await page.locator('#runBtn').innerText(), 'Run now');
    assert.equal(await page.locator('#stopBtn').innerText(), 'Stop run');
    assert.match(await page.locator('#dashboardEmptyState').innerText(), /No run data|Not started/i);

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
