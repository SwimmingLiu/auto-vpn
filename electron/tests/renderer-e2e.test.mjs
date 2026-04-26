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
  ['#navDashboard', 'dashboard', '概览', '#dashboardOverview'],
  ['#navRuns', 'runs', '运行', '#runsWorkspace'],
  ['#navResults', 'results', '结果', '#resultsWorkspace'],
  ['#navSubscriptions', 'subscriptions', '订阅', '#subscriptionCards'],
  ['#navLogs', 'logs', '日志', '#logsWorkspace'],
  ['#navSettings', 'settings', '设置', '#settingsWorkspace']
];

const REMOVED_NAV = [
  '#navConfig',
  '#navHistory',
  '#navNodes',
  '#navDeploy',
  '#navMonitor',
  '#navAbout'
];

test('renderer matches the six-page canvas redesign and supports page navigation', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const target = `${server.origin}/index.html`;

    await page.addInitScript(() => {
      const fixedNow = 1747290615000;
      Date.now = () => fixedNow;
      window.__runCalls = 0;
      window.__savedProfiles = [];
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
      window.vpnAutomation = {
        loadProfile: async () => ({
          sources: {
            leiting: {
              url: 'https://capture-1.vpn.example/api/v1/client/subscribe',
              key: 'lt-demo-key',
              enabled: true,
              max_iterations: 40
            }
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
            project_root: '/Users/user/vpn-sub',
            artifacts_root: '/Users/user/vpn-sub/artifacts'
          }
        }),
        saveProfile: async (payload) => {
          window.__savedProfiles.push(structuredClone(payload));
          return { ok: true };
        },
        runPipeline: async () => {
          window.__runCalls += 1;
          return { ok: true, pid: 1 };
        },
        stopPipeline: async () => ({ ok: true, requested: true }),
        openUrl: async () => ({ ok: true }),
        openPath: async () => ({ ok: true }),
        generateQr: async (text) => ({ ok: true, dataUrl: `data:image/mock;value=${encodeURIComponent(text)}` }),
        previewArtifact: async () => ({
          ok: true,
          outputFiles: [],
          nodeRows: [
            {
              name: '🇺🇸 US demo-node',
              address: '1.2.3.4',
              protocol: 'vmess',
              path: '/edge',
              link: 'vmess://demo'
            }
          ],
          nodeSource: 'vpn_node_emoji.txt'
        }),
        onPipelineEvent: (callback) => {
          window.__emitPipelineEvent = callback;
          setTimeout(() => {
            callback({ type: 'log', message: '[INFO] extract started' });
            callback({ type: 'stage', stage: 'extract', status: 'running' });
            callback({ type: 'log', message: '[ERROR] availability failed' });
            callback({ type: 'log', message: '[WARN] deploy skipped' });
            callback({
              type: 'summary',
              artifact_dir: '/Users/user/vpn-sub/artifacts/20260425-000000',
              stage_status: { extract: 'success', availability: 'success' },
              counts: { raw_links: 3, deduped_links: 2, speedtest_links: 1, availability_links: 1, final_links: 1 },
              source_counts: { leiting: { raw_links: 3 } }
            });
          }, 10);
          return () => {};
        }
      };
    });
    await page.goto(target);
    await page.waitForSelector('.workspace-shell');
    await page.waitForTimeout(60);

    assert.equal(await page.locator('.sidebar-nav .nav-item').count(), 6);
    assert.equal(await page.locator('.shortcut-action').count(), 0);
    assert.equal(await page.locator('.status-card').count(), 0);
    assert.equal(await page.locator('.page-header-card').count(), 0);
    assert.equal(await page.locator('#pageTitle').innerText(), '概览');
    assert.match(await page.locator('#pageSubtitle').innerText(), /只展示/);

    for (const selector of REMOVED_NAV) {
      assert.equal(await page.locator(selector).count(), 0);
    }

    for (const [navSelector, pageKey, pageTitle, readySelector] of PAGE_CASES) {
      await page.locator(navSelector).click();
      await page.waitForSelector(readySelector);

      assert.equal(await page.locator('body').getAttribute('data-page'), pageKey);
      assert.equal(await page.locator('#pageTitle').innerText(), pageTitle);
      assert.ok(await page.locator(readySelector).isVisible());
    }

    await page.locator('#navDashboard').click();
    await page.waitForSelector('#dashboardOverview');
    const overviewText = await page.locator('#dashboardOverview').innerText();
    assert.match(overviewText, /原始节点/);
    assert.match(overviewText, /雷霆 3/);
    assert.match(overviewText, /最终可用/);
    assert.match(overviewText, /未开始/);
    assert.match(overviewText, /系统状态/);
    assert.doesNotMatch(overviewText, /高频操作/);
    assert.doesNotMatch(overviewText, /不放|占位|合并/);

    await page.evaluate(() => {
      window.__emitPipelineEvent({ type: 'extract_iteration', source_name: 'leiting', total_links: 4, new_items: 1 });
      window.__emitPipelineEvent({ type: 'extract_iteration', source_name: 'heidong', total_links: 2, new_items: 2 });
      window.__emitPipelineEvent({ type: 'speedtest_result', passed_threshold: true });
      window.__emitPipelineEvent({ type: 'availability_link_result', all_passed: true });
    });
    const updatedRawMetric = await page.locator('[data-metric-key="raw_links"]').innerText();
    const updatedSpeedMetric = await page.locator('[data-metric-key="speedtest_links"]').innerText();
    const updatedAvailabilityMetric = await page.locator('[data-metric-key="availability_links"]').innerText();
    assert.match(updatedRawMetric, /6/);
    assert.match(updatedRawMetric, /雷霆 4/);
    assert.match(updatedRawMetric, /黑洞 2/);
    assert.match(updatedSpeedMetric, /2/);
    assert.match(updatedAvailabilityMetric, /2/);

    await page.locator('#navResults').click();
    await page.waitForSelector('#resultsWorkspace');
    await page.waitForFunction(() => document.body.innerText.includes('demo-node'));
    const resultsText = await page.locator('#resultsWorkspace').innerText();
    assert.match(resultsText, /demo-node/);
    assert.match(resultsText, /1\.2\.3\.4/);
    assert.match(resultsText, /vmess/);
    assert.match(resultsText, /\/edge/);
    assert.match(resultsText, /US/);
    assert.doesNotMatch(resultsText, /合并到这里|vpn_node_raw\.txt/);

    await page.locator('#navLogs').click();
    await page.waitForSelector('#logsWorkspace');
    const logText = await page.locator('#logsWorkspace').innerText();
    assert.doesNotMatch(logText, /隐藏|占位|合并/);
    assert.match(logText, /extract started/);

    await page.getByRole('button', { name: '错误' }).click();
    const errorText = await page.locator('#logCenterTable').innerText();
    assert.match(errorText, /availability failed/);
    assert.doesNotMatch(errorText, /extract started/);

    await page.getByRole('button', { name: '运行日志' }).click();
    const runtimeText = await page.locator('#logCenterTable').innerText();
    assert.match(runtimeText, /extract started/);
    assert.doesNotMatch(runtimeText, /availability failed/);

    await page.getByRole('button', { name: '按阶段' }).click();
    const groupedText = await page.locator('#logCenterTable').innerText();
    assert.match(groupedText, /extract/);
    assert.match(groupedText, /其他|availability/);

    await page.getByRole('button', { name: '清空显示' }).click();
    assert.match(await page.locator('#logCenterTable').innerText(), /暂无日志|暂无可显示日志/);

    await page.locator('#navSubscriptions').click();
    await page.waitForSelector('#subscriptionCards');
    assert.equal(await page.locator('#pageActions [data-copy-text]').count(), 0);
    assert.equal(await page.locator('#pageActions [data-open-url]').count(), 0);
    assert.ok(await page.locator('.subscription-tab-scroller').isVisible());
    const defaultSubscription = await page.locator('.subscription-primary').innerText();
    const defaultQr = await page.locator('.qr-image').getAttribute('src');
    const defaultCopyTarget = await page.locator('#subscriptionCards [data-copy-text]').first().getAttribute('data-copy-text');

    await page.getByRole('button', { name: 'Clash Meta' }).click();
    const clashMetaSubscription = await page.locator('.subscription-primary').innerText();
    const clashMetaQr = await page.locator('.qr-image').getAttribute('src');
    const clashMetaCopyTarget = await page.locator('#subscriptionCards [data-copy-text]').first().getAttribute('data-copy-text');
    const clashMetaOpenTarget = await page.locator('#subscriptionCards [data-open-url]').first().getAttribute('data-open-url');

    assert.match(defaultSubscription, /fc1868ef3937$/);
    assert.match(clashMetaSubscription, /\?format=clash-meta$/);
    assert.notEqual(clashMetaQr, defaultQr);
    assert.notEqual(clashMetaCopyTarget, defaultCopyTarget);
    assert.equal(clashMetaCopyTarget, clashMetaSubscription);
    assert.equal(clashMetaOpenTarget, clashMetaSubscription);

    await page.locator('#navSettings').click();
    await page.waitForSelector('#settingsWorkspace');
    const settingsText = await page.locator('#settingsWorkspace').innerText();
    assert.match(settingsText, /数据源配置/);
    assert.match(settingsText, /测速配置/);
    assert.doesNotMatch(settingsText, /部署配置/);
    assert.equal(await page.locator('.settings-overview-card').count(), 2);
    assert.equal(await page.locator('.settings-source-table').count(), 0);

    await page.locator('[data-settings-card="sources"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="true"]');
    assert.match(await page.locator('#settingsDrawerTitle').innerText(), /数据源配置/);
    assert.equal(await page.locator('[data-source-max-iterations]').inputValue(), '40');

    await page.locator('[data-source-max-iterations]').fill('25');
    await page.locator('[data-source-area-min]').fill('20');
    await page.locator('[data-source-area-max]').fill('60');
    assert.equal(await page.locator('[data-source-max-iterations]').inputValue(), '25');
    assert.equal(await page.locator('[data-source-area-min]').inputValue(), '20');
    assert.equal(await page.locator('[data-source-area-max]').inputValue(), '60');
    await page.locator('[data-drawer-save="save"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="false"]');
    await page.locator('#pageActions [data-action="save-profile"]').click();
    assert.equal(
      await page.evaluate(() => window.__savedProfiles.at(-1).sources.leiting.max_iterations),
      25
    );
    assert.deepEqual(
      await page.evaluate(() => [
        window.__savedProfiles.at(-1).sources.leiting.area_min,
        window.__savedProfiles.at(-1).sources.leiting.area_max
      ]),
      [20, 60]
    );

    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');
    assert.equal(await page.locator('[data-run-action="start"]').count(), 1);
    assert.equal(await page.locator('[data-run-action="stop"]').count(), 1);
    assert.equal(await page.locator('[data-action="retry-current-stage"]').count(), 1);
    assert.equal(await page.locator('#runsLogOutput').count(), 0);

    const sameButtonAfterLogs = await page.locator('#runsWorkspace [data-run-action="start"]').evaluate((button) => {
      window.__stableRunButton = button;
      for (let index = 0; index < 5; index += 1) {
        window.__emitPipelineEvent({ type: 'log', message: `[INFO] stable ${index}` });
      }
      return window.__stableRunButton === document.querySelector('#runsWorkspace [data-run-action="start"]');
    });
    assert.equal(sameButtonAfterLogs, true);

    const runButtonBox = await page.locator('#runsWorkspace [data-run-action="start"]').boundingBox();
    await page.mouse.move(runButtonBox.x + runButtonBox.width / 2, runButtonBox.y + runButtonBox.height / 2);
    await page.mouse.down();
    await page.evaluate(() => window.__emitPipelineEvent({ type: 'log', message: '[INFO] during click' }));
    await page.mouse.up();
    await page.waitForFunction(() => window.__runCalls === 1);

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
