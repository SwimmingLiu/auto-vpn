import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { chromium } from 'playwright';

import { createAutoVpnServer } from '../../npm/autovpn-cli/dist/server/http.js';

const EXPECTED_DIGESTS = {
  dashboard: '189057c09bfb99fe01dbb8e795ead1ca42a176b65ab99a5b042be8b1a1560065',
  runs: 'c5b74ebaafdc33cc4f7f7d4e9c19200c54dd3edc7b34f4fe0aa5e1081b1bea93'
};

const EXPECTED_MOBILE_DIGESTS = {
  mobileDashboard: 'e2552bf2380a88da147719ca0c855b7f5796a524140ea08285dc192770359054',
  mobileRuns: '14d996e86e498ba5644f6f25054aa6058c6ff8f84567bd9565b4bc03e9404950',
  mobileLogs: '11e7b21472f70547b12eac58cb9c04f908c0f361c6545b0ec545533908a60e98'
};

test('served web ui visual hashes match browser baseline', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: {
            leiting: { url: 'https://capture.example/api', key: 'redacted', enabled: true, max_iterations: 40 }
          },
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: {
            project_name: 'sub-nodes',
            pages_project_url: 'https://sub-nodes.pages.dev',
            subscription_url: 'https://vpn.example.top/sub',
            cloudflare_auth_mode: 'api_token',
            cloudflare_api_token: '<redacted>'
          },
          paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
        },
        runState: 'idle',
        artifact: {
          artifact_dir: '/repo/artifacts/20260703-120000',
          counts: { raw_links: 5, deduped_links: 4, speedtest_links: 3, availability_links: 2 },
          source_counts: { leiting: { raw_links: 5 } },
          outputFiles: [],
          nodeRows: []
        },
        retryArtifacts: []
      }),
      subscribe: () => () => {}
    }
  });

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      const fixedNow = 1783051200000;
      Date.now = () => fixedNow;
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
    });
    await page.goto(`${service.origin}/`);
    await page.waitForSelector('#dashboardOverview');
    await page.waitForFunction(() => document.body.innerText.includes('20260703-120000'));
    await page.screenshot({ animations: 'disabled' });

    const digests = {};
    for (const [name, navSelector, readySelector] of [
      ['dashboard', '#navDashboard', '#dashboardOverview'],
      ['runs', '#navRuns', '#runsWorkspace']
    ]) {
      await page.locator(navSelector).click();
      await page.waitForSelector(readySelector);
      await page.waitForTimeout(120);
      const buffer = await page.screenshot({ animations: 'disabled' });
      digests[name] = crypto.createHash('sha256').update(buffer).digest('hex');
    }

    assert.deepEqual(digests, EXPECTED_DIGESTS);
  } finally {
    await browser?.close();
    await service.close();
  }
});

test('served web ui visual hashes match mobile browser baseline', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: {
            leiting: { url: 'https://capture.example/api', key: 'redacted', enabled: true, max_iterations: 40 }
          },
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: {
            project_name: 'sub-nodes',
            pages_project_url: 'https://sub-nodes.pages.dev',
            subscription_url: 'https://vpn.example.top/sub',
            cloudflare_auth_mode: 'api_token',
            cloudflare_api_token: '<redacted>'
          },
          paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
        },
        runState: 'running',
        artifact: {
          artifact_dir: '/repo/artifacts/20260703-120000',
          run_status: '',
          stage_status: { doctor: 'success', extract: 'success', dedupe: 'success', speedtest: 'running' },
          counts: { raw_links: 132, deduped_links: 119, speedtest_links: 23, availability_links: 0 },
          source_counts: {
            leiting: { raw_links: 32, deduped_links: 28 },
            heidong: { raw_links: 42, deduped_links: 38 },
            mifeng: { raw_links: 58, deduped_links: 53 }
          },
          outputFiles: [],
          nodeRows: []
        },
        retryArtifacts: [],
        logEvents: [
          { type: 'stage', stage: 'speedtest', status: 'running' },
          { type: 'log', message: '[speedtest] selected 50/119 reachable links for full download test' }
        ]
      }),
      subscribe: () => () => {}
    }
  });

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true
    });
    await page.addInitScript(() => {
      const fixedNow = 1783051200000;
      Date.now = () => fixedNow;
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
    });
    await page.goto(`${service.origin}/`);
    await page.waitForSelector('#dashboardOverview');

    const digests = {};
    for (const [name, navSelector, readySelector] of [
      ['mobileDashboard', '#navDashboard', '#dashboardOverview'],
      ['mobileRuns', '#navRuns', '#runsWorkspace'],
      ['mobileLogs', '#navLogs', '#logsWorkspace']
    ]) {
      await page.locator(navSelector).click();
      await page.waitForSelector(readySelector);
      await page.waitForTimeout(160);
      const buffer = await page.screenshot({ animations: 'disabled' });
      digests[name] = crypto.createHash('sha256').update(buffer).digest('hex');
    }

    assert.deepEqual(digests, EXPECTED_MOBILE_DIGESTS);
  } finally {
    await browser?.close();
    await service.close();
  }
});
