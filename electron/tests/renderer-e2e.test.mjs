import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('renderer fits the compact dashboard contract at 960x720', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    const target = `${server.origin}/index.html`;

    await page.addInitScript(() => {
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
    });
    await page.goto(target);
    await page.waitForSelector('.dashboard-shell');

    const summaryCards = await page.locator('.summary-card').count();
    const heroTitle = await page.locator('#heroTitle').innerText();
    const heroBody = await page.locator('#heroBody').innerText();
    const metricsTitle = await page.locator('#metricsCardTitle').innerText();
    const stagesVisible = await page.locator('#stages').isVisible();
    const logsVisible = await page.locator('#logOutput').isVisible();
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const innerHeight = await page.evaluate(() => window.innerHeight);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth = await page.evaluate(() => window.innerWidth);

    assert.equal(summaryCards, 4);
    assert.equal(heroTitle, '紧凑查看节点抓取、测速、部署与运行状态');
    assert.equal(metricsTitle, '运行指标');
    assert.ok(stagesVisible);
    assert.ok(logsVisible);
    assert.equal(
      heroBody,
      '在一个控制台里维护抓包源、测速阈值和发布配置，并持续查看阶段进度与日志摘要。'
    );
    assert.ok(scrollHeight <= innerHeight + 2);
    assert.ok(scrollWidth <= innerWidth + 2);

    await page.locator('[data-panel="sources"]').click();
    await page.waitForSelector('.drawer.open');
    await page.waitForTimeout(260);
    const drawerBox = await page.locator('.drawer.open').boundingBox();
    assert.ok(drawerBox.width <= 360);
    assert.ok(drawerBox.x >= 0);
    assert.ok(drawerBox.x + drawerBox.width <= innerWidth);

    await page.locator('#drawerClose').click();
    await page.waitForTimeout(120);

    await page.locator('[data-panel="speed"]').click();
    await page.waitForSelector('.drawer.open');
    await page.waitForTimeout(260);
    await page.locator('#drawerMinSpeed').fill('2.5');
    await page.locator('#drawerSave').click();
    await page.waitForTimeout(120);
    const speedSummary = await page.locator('#speedSummary').innerText();
    assert.match(speedSummary, /2\.5/);

    await page.locator('#languageSelect').selectOption('en-US');
    await page.waitForTimeout(100);
    const titleEnglish = await page.locator('#heroTitle').innerText();
    const bodyEnglish = await page.locator('#heroBody').innerText();
    const metricsEnglish = await page.locator('#metricsCardTitle').innerText();

    assert.equal(
      titleEnglish,
      'Track capture, speed tests, deployment and runtime health in one compact view'
    );
    assert.equal(
      bodyEnglish,
      'Maintain sources, thresholds and publish settings in one console while keeping stage progress and log summaries visible.'
    );
    assert.equal(metricsEnglish, 'Run Metrics');
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
