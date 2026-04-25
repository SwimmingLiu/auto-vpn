import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function run() {
  const server = await startStaticServer(path.join(__dirname, 'electron', 'renderer'));
  const browser = await chromium.launch();
  try {
    const artifactsDir = path.join(__dirname, 'artifacts', 'screenshots');
    await fs.mkdir(artifactsDir, { recursive: true });

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const target = `${server.origin}/index.html`;

    await page.addInitScript(() => {
      const fixedNow = 1747290615000;
      Date.now = () => fixedNow;
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
      window.vpnAutomation = {
        loadProfile: async () => ({
          sources: {
            leiting: { url: 'https://capture-1.vpn.example/api/v1/client/subscribe', key: 'lt-demo-key', enabled: true }
          },
          speed_test: {
            min_download_mb_s: 1,
            timeout_seconds: 20,
            concurrency: 3
          },
          deploy: {
            project_name: 'vpn-auto',
            pages_project_url: 'https://vpn-auto.pages.dev',
            subscription_url: 'https://vpn.example.top/179ba8dd-3854-4747-b853-fc1868ef3937'
          },
          paths: {
            project_root: '/Users/swimmingliu/data/VPN/vpn-subscription-automation',
            artifacts_root: '/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts'
          }
        }),
        saveProfile: async () => ({ ok: true }),
        runPipeline: async () => ({ ok: true, pid: 1 }),
        stopPipeline: async () => ({ ok: true, requested: true }),
        openUrl: async () => ({ ok: true }),
        openPath: async () => ({ ok: true }),
        generateQr: async (text) => ({ ok: true, dataUrl: `data:image/mock;value=${encodeURIComponent(text)}` }),
        previewArtifact: async () => ({ ok: true, outputFiles: [], nodeRows: [] }),
        onPipelineEvent: (callback) => {
          setTimeout(() => {
            callback({ type: 'log', message: '[INFO] extract started' });
            callback({ type: 'stage', stage: 'extract', status: 'running' });
            callback({ type: 'log', message: '[ERROR] availability failed' });
            callback({ type: 'log', message: '[WARN] deploy skipped' });
          }, 10);
          return () => {};
        }
      };
    });
    
    await page.goto(target);
    await page.waitForSelector('.workspace-shell');
    await page.waitForTimeout(100);

    const PAGE_CASES = [
      ['#navDashboard', 'dashboard', '#dashboardOverview'],
      ['#navRuns', 'runs', '#runsWorkspace'],
      ['#navResults', 'results', '#resultsWorkspace'],
      ['#navSubscriptions', 'subscriptions', '#subscriptionCards'],
      ['#navLogs', 'logs', '#logsWorkspace'],
      ['#navSettings', 'settings', '#settingsWorkspace']
    ];

    for (const [navSelector, name, readySelector] of PAGE_CASES) {
      await page.locator(navSelector).click();
      await page.waitForSelector(readySelector);
      await page.waitForTimeout(500); // Wait for transition
      await page.screenshot({ path: path.join(artifactsDir, `${name}.png`) });
    }
    
    // Also take screenshot of settings drawer
    await page.locator('#navSettings').click();
    await page.waitForSelector('#settingsWorkspace');
    await page.locator('[data-settings-card="sources"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="true"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(artifactsDir, `settings_drawer.png`) });

    console.log('Screenshots captured in artifacts/screenshots');
  } finally {
    await browser.close();
    await server.close();
  }
}

run().catch(console.error);
