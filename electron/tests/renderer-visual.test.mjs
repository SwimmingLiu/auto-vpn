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
  darwin: {
    dashboard: 'f370bc7ed8d530876847d3f83b90879f703203fb56ea6bcbf04c15074272720a',
    config: '2eafa2e4bbe6bf81a847bd4f1b1fa0847c1b5234426cb663d6deca6eac7f8262',
    run: '63cf524f577aa808b2902f280c8a9543e3870cd3ef7e9ff01317315e98d458be',
    artifacts: 'f481ce2f0874374d374843f71e1ac8a7f49759e37623c361e470a35773758e68',
    logs: 'f622ea1af1f6acc605b60d840667ba5f6ea817b0193ab7cba7ea375b55501b30',
    about: 'b1529931e5b61ae84f686adb964c758c8769ffcdd91626b022e1cd219360f8e6'
  },
  linux: {
    dashboard: '40a9292f3bd67543dbb2d0c9763bd8e825c10895c9982b362842ae8a6fe30151',
    config: '3425eb7b3a813e2445cf582298d27415c3f10abbe038c934c349c9c3237d3fcd',
    run: 'd5c8ed8fde15efcca749484ca6abffd476a68576628381aaf9703e50f53ccd0b',
    artifacts: '0b347d5f8cb6981f0713d40db6c9695403400e2d0671200fbbe94ccf0ffe37ae',
    logs: '5e674bd01c171b15189f6691f37ed043cbc6e46644499bfa031ac97919c46305',
    about: '640845dfeac0843163db4220be1d3608caeaf51b05df60d3ddb5cd89ad9b8634'
  }
};

const VISUAL_CASES = [
  ['dashboard', '#navDashboard', '#dashboardOverview'],
  ['config', '#navConfig', '#configPrimarySource'],
  ['run', '#navRun', '#runLogOutput'],
  ['artifacts', '#navArtifacts', '#artifactsPanel'],
  ['logs', '#navLogs', '#logCenterTable'],
  ['about', '#navAbout', '#aboutArchitecture']
];

test('renderer visual hashes match the runtime-aligned empty-state workspace', async () => {
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

    const expected = EXPECTED_DIGESTS[process.platform] ?? EXPECTED_DIGESTS.darwin;
    assert.deepEqual(digests, expected);
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
