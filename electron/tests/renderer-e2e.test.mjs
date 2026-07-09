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

test('renderer hydrates the latest artifact on startup when backend has results', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.addInitScript(() => {
      window.__latestCalls = 0;
      window.vpnAutomation = {
        loadProfile: async () => ({
          sources: {
            leiting: { url: 'https://capture.example/api', key: 'demo', enabled: true, max_iterations: 40 }
          },
          availability_targets: {},
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          deploy: {
            project_name: 'sub-nodes',
            pages_project_url: 'https://sub-nodes.pages.dev',
            subscription_url: 'https://vpn.example.top/sub'
          },
          paths: { project_root: '/Users/user/vpn-sub', artifacts_root: '/Users/user/vpn-sub/artifacts' }
        }),
        latestArtifact: async () => {
          window.__latestCalls += 1;
          return {
            ok: true,
            artifact_dir: '/Users/user/vpn-sub/artifacts/20260426-120000',
            counts: { raw_links: 5, deduped_links: 4, speedtest_links: 3, availability_links: 2 },
            source_counts: { leiting: { raw_links: 5 } },
            retry_context: {
              source_artifact_dir: '/Users/user/vpn-sub/artifacts/20260425-000000',
              source_artifact_name: '20260425-000000',
              start_stage: 'deploy'
            },
            outputFiles: [{ name: 'vpn_node_emoji.txt', size: '2 KB' }],
            nodeRows: [
              {
                name: '🇯🇵 JP latest-node',
                address: '6.6.6.6',
                protocol: 'vmess',
                path: '/latest',
                link: 'vmess://latest'
              }
            ]
          };
        },
        artifactList: async () => ({
          ok: true,
          items: [
            {
              artifact_dir: '/Users/user/vpn-sub/artifacts/20260426-120000',
              artifact_name: '20260426-120000',
              run_status: 'failed',
              stage_status: { speedtest: 'success', deploy: 'failed' },
              counts: { speedtest_links: 3, availability_links: 2, final_links: 2 },
              retryable_stages: ['speedtest', 'availability', 'postprocess', 'render', 'obfuscate', 'deploy', 'verify'],
              retry_context: {}
            },
            {
              artifact_dir: '/Users/user/vpn-sub/artifacts/20260425-000000',
              artifact_name: '20260425-000000',
              run_status: 'success',
              stage_status: { deploy: 'success', verify: 'success' },
              counts: { speedtest_links: 2, availability_links: 2, final_links: 2 },
              retryable_stages: ['deploy', 'verify'],
              retry_context: {
                source_artifact_dir: '/Users/user/vpn-sub/artifacts/20260424-000000',
                source_artifact_name: '20260424-000000',
                start_stage: 'deploy'
              }
            }
          ]
        }),
        saveProfile: async () => ({ ok: true }),
        runPipeline: async () => ({ ok: true, pid: 1 }),
        retryStage: async () => ({ ok: true, pid: 2 }),
        copyText: async (value) => {
          window.__copiedTexts = [...(window.__copiedTexts ?? []), value];
          return { ok: true };
        },
        stopPipeline: async () => ({ ok: true, requested: true }),
        openUrl: async () => ({ ok: true }),
        openPath: async () => ({ ok: true }),
        generateQr: async () => ({ ok: true, dataUrl: 'data:image/mock;base64,latest' }),
        previewArtifact: async () => ({ ok: false, outputFiles: [], nodeRows: [] }),
        onPipelineEvent: () => () => {}
      };
    });

    await page.goto(`${server.origin}/index.html`);
    await page.waitForSelector('#dashboardOverview');
    await page.waitForFunction(() => window.__latestCalls === 1);

    const dashboardText = await page.locator('#dashboardOverview').innerText();
    assert.match(dashboardText, /20260426-120000/);
    assert.match(await page.locator('[data-metric-key="availability_links"]').innerText(), /2/);

    await page.locator('#navResults').click();
    await page.waitForSelector('#resultsWorkspace');
    const resultsText = await page.locator('#resultsWorkspace').innerText();
    assert.match(resultsText, /重试来源/);
    assert.match(resultsText, /20260425-000000/);
    assert.match(resultsText, /deploy/);
    assert.match(resultsText, /latest-node/);
    assert.match(resultsText, /6\.6\.6\.6/);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test('renderer blocks deploy runs when Cloudflare credentials are missing', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.addInitScript(() => {
      window.__runCalls = 0;
      window.__savedProfiles = [];
      window.vpnAutomation = {
        loadProfile: async () => ({
          sources: {
            leiting: { url: 'https://capture.example/api', key: 'demo', enabled: true, max_iterations: 40 }
          },
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: {
            project_name: 'sub-nodes',
            pages_project_url: 'https://sub-nodes.pages.dev',
            subscription_url: 'https://vpn.example.top/sub',
            cloudflare_auth_mode: 'api_token',
            cloudflare_api_token: '',
            cloudflare_global_key: '',
            cloudflare_email: ''
          },
          paths: { project_root: '/Users/user/vpn-sub', artifacts_root: '/Users/user/vpn-sub/artifacts' }
        }),
        saveProfile: async (payload) => {
          window.__savedProfiles.push(structuredClone(payload));
          return { ok: true };
        },
        latestArtifact: async () => ({ ok: false, artifact_dir: '' }),
        artifactList: async () => ({ ok: true, items: [] }),
        runPipeline: async () => {
          window.__runCalls += 1;
          return { ok: true, pid: 1 };
        },
        generateQr: async () => ({ ok: true, dataUrl: 'data:image/mock;base64,preflight' }),
        onPipelineEvent: () => () => {}
      };
    });

    await page.goto(`${server.origin}/index.html`);
    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');
    await page.locator('#runsWorkspace [data-run-action="start"]').click();
    await page.waitForSelector('[data-toast]');

    const toastText = await page.locator('[data-toast]').innerText();
    await page.locator('#navLogs').click();
    await page.waitForSelector('#logCenterTable');
    const logText = await page.locator('#logCenterTable').innerText();
    assert.match(toastText, /Cloudflare Token/);
    assert.match(logText, /部署配置不完整/);
    assert.equal(await page.evaluate(() => window.__runCalls), 0);
    assert.equal(await page.evaluate(() => window.__savedProfiles.length), 0);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test('renderer matches the six-page canvas redesign and supports page navigation', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  let browser;
  try {
    browser = await chromium.launch();
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
          availability_targets: {
            gemini: {
              url: 'https://gemini.google.com',
              enabled: true
            },
            chatgpt_ios: {
              url: 'https://ios.chat.openai.com/',
              enabled: true
            },
            chatgpt_web: {
              url: 'https://api.openai.com/compliance/cookie_requirements',
              enabled: true
            },
            claude: {
              url: 'https://claude.ai/cdn-cgi/trace',
              enabled: true
            }
          },
          deploy: {
            project_name: 'sub-nodes',
            pages_project_url: 'https://sub-nodes.pages.dev',
            subscription_url: 'https://vpn.example.top/179ba8dd-3854-4747-b853-fc1868ef3937',
            cloudflare_api_token: '',
            pages_secret_admin: 'swimmingliu'
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
        latestArtifact: async () => ({ ok: false, artifact_dir: '' }),
        artifactList: async () => ({
          ok: true,
          items: [
            {
              artifact_dir: '/Users/user/vpn-sub/artifacts/20260425-000000',
              artifact_name: '20260425-000000',
              run_status: 'failed',
              stage_status: { deploy: 'failed' },
              counts: { speedtest_links: 1, availability_links: 1, final_links: 1 },
              retryable_stages: ['speedtest', 'availability', 'postprocess', 'render', 'obfuscate', 'deploy', 'verify'],
              retry_context: {}
            },
            {
              artifact_dir: '/Users/user/vpn-sub/artifacts/20260424-000000',
              artifact_name: '20260424-000000',
              run_status: 'success',
              stage_status: { deploy: 'success', verify: 'success' },
              counts: { speedtest_links: 2, availability_links: 2, final_links: 2 },
              retryable_stages: ['deploy', 'verify'],
              retry_context: {
                source_artifact_dir: '/Users/user/vpn-sub/artifacts/20260423-000000',
                source_artifact_name: '20260423-000000',
                start_stage: 'verify'
              }
            }
          ]
        }),
        runPipeline: async () => {
          window.__runCalls += 1;
          return { ok: true, pid: 1 };
        },
        retryStage: async (payload) => {
          window.__retryCalls = (window.__retryCalls ?? 0) + 1;
          window.__lastRetryPayload = structuredClone(payload);
          setTimeout(() => {
            window.__emitPipelineEvent?.({ type: 'finished', ok: true, code: 0, signal: null, stopped: false });
          }, 0);
          return { ok: true, pid: 2 };
        },
        copyText: async (value) => {
          window.__copiedTexts = [...(window.__copiedTexts ?? []), value];
          return { ok: true };
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

    assert.ok(await page.locator('.window-titlebar').isVisible());
    assert.equal(await page.locator('.app-content-shell').count(), 1);
    const titlebarBox = await page.locator('.window-titlebar').boundingBox();
    const topbarBox = await page.locator('.topbar').boundingBox();
    assert.ok(titlebarBox.height >= 32);
    assert.ok(topbarBox.y >= titlebarBox.height);

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
    await page.getByRole('button', { name: '复制节点' }).click();
    await page.waitForSelector('[data-toast]');
    assert.equal(
      await page.evaluate(() => window.__copiedTexts?.at(-1)),
      'vmess://demo'
    );
    assert.match(await page.locator('[data-toast]').innerText(), /已复制 1 条节点/);

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
    await page.evaluate(() => {
      window.__emitPipelineEvent({
        type: 'summary',
        artifact_dir: '/Users/user/vpn-sub/artifacts/20260507-203610',
        run_status: 'success',
        stage_status: { deploy: 'success', verify: 'success' },
        counts: { raw_links: 3, deduped_links: 2, speedtest_links: 1, availability_links: 1, final_links: 1 },
        source_counts: { leiting: { raw_links: 3 } },
        deployment: {
          project_name: 'sub-nodes-04',
          pages_project_url: 'https://sub-nodes-04.pages.dev',
          share_project_name: 'sub-links-share-05'
        }
      });
    });
    const settingsText = await page.locator('#settingsWorkspace').innerText();
    assert.match(settingsText, /数据源配置/);
    assert.match(settingsText, /测速配置/);
    assert.match(settingsText, /AI可达性检测/);
    assert.match(settingsText, /部署配置/);
    assert.match(settingsText, /弹窗/);
    assert.doesNotMatch(settingsText, /右侧抽屉|顶部统一保存/);
    assert.equal(await page.locator('.settings-overview-card').count(), 4);
    assert.equal(await page.locator('.settings-source-table').count(), 0);
    assert.equal(await page.locator('#pageActions [data-action="save-profile"]').count(), 0);

    await page.locator('[data-settings-card="sources"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="true"]');
    assert.match(await page.locator('#settingsDrawerTitle').innerText(), /数据源配置/);
    assert.equal(await page.locator('[data-source-max-iterations]').inputValue(), '40');
    const sourceSettingTops = await page.locator('.source-drawer-settings .field').evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().top))
    );
    assert.equal(new Set(sourceSettingTops).size, 1);

    const curlInput = "curl 'https://www.xnfvjf.info:20000/api/evmess?&proto=v6&platform=ios&ver=5.8.55347&unicode=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&deviceid=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&code=ZRGOIXI&recomm_code=&device_token=&f=2026-04-23&install=2026-04-23&xf_fans=0&token=ZGSNZ19nnZqSl2VobGppZZOWaGZonHGRYWeVk5lu&t=1777190098.382194&width=375.0&height=812.0&area=999' -H 'Host: www.xnfvjf.info:20000'";
    await page.locator('[data-drawer-source="leiting"][data-drawer-key="url"]').fill(curlInput);
    await page.locator('[data-drawer-source="leiting"][data-drawer-key="url"]').blur();
    assert.equal(
      await page.locator('[data-drawer-source="leiting"][data-drawer-key="url"]').inputValue(),
      'https://www.xnfvjf.info:20000/api/evmess?&proto=v6&platform=ios&ver=5.8.55347&unicode=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&deviceid=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&code=ZRGOIXI&recomm_code=&device_token=&f=2026-04-23&install=2026-04-23&xf_fans=0&token=ZGSNZ19nnZqSl2VobGppZZOWaGZonHGRYWeVk5lu&t=1777190098.382194&width=375.0&height=812.0&area=999'
    );

    await page.locator('[data-source-max-iterations]').fill('25');
    await page.locator('[data-source-plateau-limit]').fill('20');
    await page.locator('[data-source-area-min]').fill('20');
    await page.locator('[data-source-area-max]').fill('60');
    assert.equal(await page.locator('[data-source-max-iterations]').inputValue(), '25');
    assert.equal(await page.locator('[data-source-plateau-limit]').inputValue(), '20');
    assert.equal(await page.locator('[data-source-area-min]').inputValue(), '20');
    assert.equal(await page.locator('[data-source-area-max]').inputValue(), '60');
    await page.locator('[data-drawer-save="save"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="false"]');
    assert.equal(
      await page.evaluate(() => window.__savedProfiles.at(-1).sources.leiting.max_iterations),
      25
    );
    assert.equal(
      await page.evaluate(() => window.__savedProfiles.at(-1).sources.leiting.plateau_limit),
      20
    );
    assert.equal(
      await page.evaluate(() => window.__savedProfiles.at(-1).sources.leiting.url),
      'https://www.xnfvjf.info:20000/api/evmess?&proto=v6&platform=ios&ver=5.8.55347&unicode=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&deviceid=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&code=ZRGOIXI&recomm_code=&device_token=&f=2026-04-23&install=2026-04-23&xf_fans=0&token=ZGSNZ19nnZqSl2VobGppZZOWaGZonHGRYWeVk5lu&t=1777190098.382194&width=375.0&height=812.0&area=999'
    );
    assert.deepEqual(
      await page.evaluate(() => [
        window.__savedProfiles.at(-1).sources.leiting.area_min,
        window.__savedProfiles.at(-1).sources.leiting.area_max
      ]),
      [20, 60]
    );

    await page.locator('[data-settings-card="availability_targets"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="true"]');
    assert.match(await page.locator('#settingsDrawerTitle').innerText(), /AI可达性检测/);
    assert.equal(await page.locator('.availability-target-table tbody tr').count(), 4);
    await page.locator('[data-availability-action="add"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.availability-target-table tbody tr').length === 5);
    const lastRow = page.locator('.availability-target-table tbody tr').last();
    await lastRow.locator('[data-availability-key="name"]').fill('tmailor');
    await lastRow.locator('[data-availability-key="url"]').fill('https://tmailor.example/');
    assert.equal(await lastRow.locator('[data-availability-key="allowed_hosts"]').count(), 0);
    assert.equal(await lastRow.locator('[data-availability-key="negative_phrases"]').count(), 0);
    await page.locator('[data-drawer-save="save"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="false"]');
    assert.deepEqual(
      await page.evaluate(() => window.__savedProfiles.at(-1).availability_targets.tmailor),
      {
        url: 'https://tmailor.example/',
        enabled: true
      }
    );

    await page.locator('[data-settings-card="deploy"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="true"]');
    assert.match(await page.locator('#settingsDrawerTitle').innerText(), /部署配置/);
    assert.equal(
      await page.locator('[data-drawer-path="deploy.project_name"]').inputValue(),
      'sub-nodes-04'
    );
    assert.equal(
      await page.locator('[data-drawer-path="deploy.pages_project_url"]').inputValue(),
      'https://sub-nodes-04.pages.dev'
    );
    await page.locator('[data-drawer-path="deploy.project_name"]').fill('custom-pages');
    assert.equal(
      await page.locator('[data-drawer-path="deploy.pages_project_url"]').inputValue(),
      'https://custom-pages.pages.dev'
    );
    await page.locator('[data-drawer-path="deploy.pages_project_url"]').fill('https://mirror.example.dev');
    await page.locator('[data-drawer-path="deploy.project_name"]').fill('custom-pages-2');
    await page.locator('[data-drawer-path="deploy.min_final_links"]').fill('12');
    await page.locator('[data-drawer-path="deploy.cloudflare_api_token"]').fill('cf-token-123');
    await page.locator('[data-drawer-path="deploy.pages_secret_admin"]').fill('custom-admin');
    assert.equal(
      await page.locator('[data-drawer-path="deploy.pages_project_url"]').inputValue(),
      'https://mirror.example.dev'
    );
    assert.equal(
      await page.locator('[data-drawer-path="deploy.cloudflare_api_token"]').getAttribute('type'),
      'password'
    );
    assert.equal(
      await page.locator('[data-drawer-path="deploy.pages_secret_admin"]').getAttribute('type'),
      'password'
    );
    await page.locator('[data-drawer-save="save"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="false"]');
    assert.deepEqual(
      await page.evaluate(() => window.__savedProfiles.at(-1).deploy),
      {
        project_name: 'custom-pages-2',
        pages_project_url: 'https://mirror.example.dev',
        subscription_url: 'https://vpn.example.top/179ba8dd-3854-4747-b853-fc1868ef3937',
        cloudflare_api_token: 'cf-token-123',
        min_final_links: 12,
        pages_secret_admin: 'custom-admin',
        share_project_name: 'sub-links-share-05'
      }
    );
    await page.locator('#navSubscriptions').click();
    await page.waitForSelector('#subscriptionCards');
    assert.match(await page.locator('.qr-image').getAttribute('src') ?? '', /^data:image\//);

    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');
    assert.equal(await page.locator('[data-run-action="start"]').count(), 1);
    assert.equal(await page.locator('[data-run-action="stop"]').count(), 1);
    assert.equal(await page.locator('[data-run-retry-artifact]').count(), 1);
    assert.equal(await page.locator('[data-run-retry-stage]').count(), 1);
    assert.equal(await page.locator('[data-action="retry-stage"]').count(), 1);
    assert.equal(await page.locator('[data-run-retry-artifact-card]').count(), 0);
    assert.equal(await page.locator('#runsLogOutput').count(), 0);

    assert.equal(
      await page.locator('[data-run-retry-artifact]').inputValue(),
      '/Users/user/vpn-sub/artifacts/20260425-000000'
    );
    await page.locator('[data-run-retry-artifact]').selectOption('/Users/user/vpn-sub/artifacts/20260424-000000');
    assert.equal(
      await page.locator('[data-run-retry-artifact]').inputValue(),
      '/Users/user/vpn-sub/artifacts/20260424-000000'
    );
    await page.locator('[data-run-retry-stage]').selectOption('deploy');
    await page.locator('[data-action="retry-stage"]').click();
    await page.waitForFunction(() => window.__retryCalls === 1);
    assert.deepEqual(
      await page.evaluate(() => window.__lastRetryPayload),
      {
        artifactDir: '/Users/user/vpn-sub/artifacts/20260424-000000',
        stage: 'deploy',
        saveBeforeRun: true
      }
    );
    await page.waitForFunction(() => !document.querySelector('[data-action="retry-stage"]').disabled);

    const sameButtonAfterLogs = await page.locator('#runsWorkspace [data-run-action="start"]').evaluate((button) => {
      window.__stableRunButton = button;
      for (let index = 0; index < 5; index += 1) {
        window.__emitPipelineEvent({ type: 'log', message: `[INFO] stable ${index}` });
      }
      return window.__stableRunButton === document.querySelector('#runsWorkspace [data-run-action="start"]');
    });
    assert.equal(sameButtonAfterLogs, true);

    await page.locator('#navDashboard').click();
    await page.waitForSelector('#dashboardOverview');
    const sameDashboardButtonAfterStages = await page.locator('#pageActions [data-run-action="start"]').evaluate((button) => {
      window.__stableDashboardButton = button;
      window.__emitPipelineEvent({ type: 'stage', stage: 'extract', status: 'running' });
      window.__emitPipelineEvent({ type: 'stage', stage: 'dedupe', status: 'running' });
      return window.__stableDashboardButton === document.querySelector('#pageActions [data-run-action="start"]');
    });
    assert.equal(sameDashboardButtonAfterStages, true);

    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');

    await page.locator('#navLogs').click();
    await page.waitForSelector('#logCenterTable');
    await page.evaluate(() => {
      window.__emitPipelineEvent({ type: 'extract_source_started', source_name: 'leiting', requested_iterations: 1000, min_iterations: 0 });
      window.__emitPipelineEvent({ type: 'extract_request_result', source_name: 'leiting', iteration: 1, success: false, via: 'direct', will_retry: true });
      window.__emitPipelineEvent({ type: 'extract_request_result', source_name: 'leiting', iteration: 1, success: true, via: 'direct_curl_tls_fallback' });
      window.__emitPipelineEvent({ type: 'extract_decrypt_result', source_name: 'leiting', iteration: 1, success: true });
      window.__emitPipelineEvent({ type: 'extract_iteration', source_name: 'leiting', iteration: 1, new_items: 1, extracted_links: 2, total_links: 4 });
      window.__emitPipelineEvent({ type: 'extract_source_completed', source_name: 'leiting', successful_iterations: 3, failed_iterations: 0, raw_links: 1 });
    });
    const extractLogText = await page.locator('#logCenterTable').innerText();
    assert.match(extractLogText, /leiting.*开始提取/);
    assert.match(extractLogText, /leiting #1 direct 失败/);
    assert.match(extractLogText, /leiting #1 direct_curl_tls_fallback 成功/);
    assert.match(extractLogText, /leiting #1 新增 1 个，本次解析 2 个，累计 4 个/);
    assert.match(extractLogText, /leiting.*完成/);

    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');

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
    await browser?.close();
    await server.close();
  }
});

test('renderer shows deploy save toast with project and url details', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

    await page.addInitScript(() => {
      window.__savedProfiles = [];
      window.vpnAutomation = {
        loadProfile: async () => ({
          sources: {
            leiting: { url: 'https://capture.example/api', key: 'demo', enabled: true, max_iterations: 40 }
          },
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: {
            project_name: 'sub-nodes',
            pages_project_url: 'https://sub-nodes.pages.dev',
            subscription_url: 'https://vpn.example.top/sub',
            verify_subscription_url: 'https://verify.example/sub',
            cloudflare_api_token: '',
            pages_secret_admin: 'swimmingliu'
          },
          paths: { project_root: '/Users/user/vpn-sub', artifacts_root: '/Users/user/vpn-sub/artifacts' }
        }),
        saveProfile: async (payload) => {
          window.__savedProfiles.push(structuredClone(payload));
          return { ok: true };
        },
        latestArtifact: async () => ({ ok: false, artifact_dir: '' }),
        artifactList: async () => ({ ok: true, items: [] }),
        generateQr: async () => ({ ok: true, dataUrl: 'data:image/mock;base64,toast' }),
        onPipelineEvent: () => () => {}
      };
    });

    await page.goto(`${server.origin}/index.html`);
    await page.locator('#navSettings').click();
    await page.locator('[data-settings-card="deploy"]').click();
    await page.waitForSelector('#settingsDrawer');
    await page.locator('[data-drawer-path="deploy.project_name"]').fill('review-sub-nodes');
    await page.locator('[data-drawer-path="deploy.verify_subscription_url"]').fill('https://verify.example/health');
    await page.locator('[data-drawer-save="save"]').click();
    await page.waitForSelector('[data-toast]');

    const toastText = await page.locator('[data-toast]').innerText();
    assert.match(toastText, /review-sub-nodes/);
    assert.match(toastText, /https:\/\/review-sub-nodes\.pages\.dev/);
    const savedProfile = await page.evaluate(() => window.__savedProfiles.at(-1));
    assert.equal(savedProfile.deploy.verify_subscription_url, 'https://verify.example/health');
    assert.equal(savedProfile.deploy.pages_secret_admin, 'swimmingliu');
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
