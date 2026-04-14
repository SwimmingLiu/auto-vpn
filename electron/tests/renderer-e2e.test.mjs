import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('renderer boots in compact single-page mode, supports language switch and expandable sections', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const target = `${server.origin}/index.html`;

  await page.addInitScript(() => {
    window.localStorage.setItem('vpn-automation-language', 'zh-CN');
  });
  await page.goto(target);
  await page.waitForSelector('.summary-card');

  const sourceCount = await page.locator('.summary-card').count();
  const title = await page.locator('.hero-panel h1').innerText();
  const runLabel = await page.locator('#runBtn').innerText();
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const innerHeight = await page.evaluate(() => window.innerHeight);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const innerWidth = await page.evaluate(() => window.innerWidth);

  assert.ok(sourceCount >= 3);
  assert.match(title, /一站式管理/);
  assert.equal(runLabel, '运行全流程');
  assert.ok(scrollHeight <= innerHeight + 2);
  assert.ok(scrollWidth <= innerWidth + 2);

  await page.locator('[data-panel="sources"]').click();
  await page.waitForSelector('.drawer.open');
  assert.equal(await page.locator('.drawer.open input[data-source="leiting"][data-key="url"]').count(), 1);
  await page.locator('#drawerClose').click();
  await page.waitForTimeout(120);

  await page.locator('[data-panel="speed"]').click();
  await page.waitForSelector('.drawer.open');
  await page.locator('#drawerMinSpeed').fill('2.5');
  await page.evaluate(() => document.querySelector('#saveBtn').click());
  await page.waitForTimeout(120);
  const speedSummary = await page.locator('#speedSummary').innerText();
  assert.match(speedSummary, /2\.5/);
  await page.locator('#drawerClose').click();
  await page.waitForTimeout(120);

  await page.locator('#languageSelect').selectOption('en-US');
  await page.waitForTimeout(100);
  const titleEnglish = await page.locator('.hero-panel h1').innerText();
  const runEnglish = await page.locator('#runBtn').innerText();
  assert.match(titleEnglish, /Manage VPN extraction/i);
  assert.equal(runEnglish, 'Run full pipeline');

  await browser.close();
  await server.close();
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
