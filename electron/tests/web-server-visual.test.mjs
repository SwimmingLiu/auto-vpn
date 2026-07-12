import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { createAutoVpnServer } from '../../npm/autovpn-cli/dist/server/http.js';

const EXPECTED_DIGESTS = {
  dashboard: 'd6afd41d0e154e800e6d03942fb18ce5d6f5ccba7eb59197d21386623c307930',
  runs: '0ebd70e19e508b41d26a27a547deeb0a7bdf3c91634aa1b7b6c83d40d0731eba'
};

const MOBILE_BASELINE_DIR = path.resolve('electron/tests/visual-baselines/mobile');
const MOBILE_ARTIFACT_DIR = path.resolve('electron/tests/visual-artifacts/mobile');

async function assertPngBaseline(page, name) {
  const actual = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  const baselinePath = path.join(MOBILE_BASELINE_DIR, `${name}.png`);
  if (process.env.UPDATE_VISUAL_BASELINES === '1') {
    await fs.mkdir(MOBILE_BASELINE_DIR, { recursive: true });
    await fs.writeFile(baselinePath, actual);
    return;
  }
  const baseline = await fs.readFile(baselinePath);
  if (!actual.equals(baseline)) {
    await fs.mkdir(MOBILE_ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(path.join(MOBILE_ARTIFACT_DIR, `${name}-actual.png`), actual);
    const diffDataUrl = await page.evaluate(async ({ expectedUrl, actualUrl }) => {
      const load = (src) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
      });
      const [expectedImage, actualImage] = await Promise.all([load(expectedUrl), load(actualUrl)]);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(expectedImage.width, actualImage.width);
      canvas.height = Math.max(expectedImage.height, actualImage.height);
      const context = canvas.getContext('2d');
      context.drawImage(expectedImage, 0, 0);
      const expectedPixels = context.getImageData(0, 0, canvas.width, canvas.height);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(actualImage, 0, 0);
      const actualPixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < actualPixels.data.length; index += 4) {
        const delta = Math.max(
          Math.abs(actualPixels.data[index] - expectedPixels.data[index]),
          Math.abs(actualPixels.data[index + 1] - expectedPixels.data[index + 1]),
          Math.abs(actualPixels.data[index + 2] - expectedPixels.data[index + 2]),
          Math.abs(actualPixels.data[index + 3] - expectedPixels.data[index + 3])
        );
        actualPixels.data[index] = delta ? 255 : 255;
        actualPixels.data[index + 1] = delta ? 0 : 255;
        actualPixels.data[index + 2] = delta ? 96 : 255;
        actualPixels.data[index + 3] = 255;
      }
      context.putImageData(actualPixels, 0, 0);
      return canvas.toDataURL('image/png');
    }, {
      expectedUrl: `data:image/png;base64,${baseline.toString('base64')}`,
      actualUrl: `data:image/png;base64,${actual.toString('base64')}`
    });
    await fs.writeFile(path.join(MOBILE_ARTIFACT_DIR, `${name}-diff.png`), Buffer.from(diffDataUrl.split(',')[1], 'base64'));
    await fs.writeFile(path.join(MOBILE_ARTIFACT_DIR, `${name}-diff.txt`),
      `expected ${crypto.createHash('sha256').update(baseline).digest('hex')}\nactual   ${crypto.createHash('sha256').update(actual).digest('hex')}\n`);
  }
  assert.deepEqual(actual, baseline, `${name} differs; inspect electron/tests/visual-artifacts/mobile`);
}

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

test('served web ui mobile PNGs match reviewable browser baselines', async () => {
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

    for (const [name, navSelector, readySelector] of [
      ['dashboard-390x844', '#navDashboard', '#dashboardOverview'],
      ['runs-running-390x844', '#navRuns', '#runsWorkspace'],
      ['results-390x844', '#navResults', '#resultsWorkspace'],
      ['subscriptions-390x844', '#navSubscriptions', '#subscriptionCards'],
      ['logs-390x844', '#navLogs', '#logsWorkspace'],
      ['settings-390x844', '#navSettings', '#settingsWorkspace']
    ]) {
      await page.locator(navSelector).click();
      await page.waitForSelector(readySelector);
      await page.waitForTimeout(160);
      await assertPngBaseline(page, name);
    }
    await page.locator('[data-settings-card="deploy"]').click();
    await page.waitForSelector('#settingsDrawer[data-open="true"]');
    await assertPngBaseline(page, 'settings-sheet-390x844');
    await page.locator('[data-drawer-close="cancel"]').last().click();

    await page.setViewportSize({ width: 360, height: 800 });
    await assertPngBaseline(page, 'settings-360x800');
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.locator('#navDashboard').click();
    await assertPngBaseline(page, 'dashboard-tablet-768x1024');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.locator('#navRuns').click();
    await assertPngBaseline(page, 'runs-landscape-844x390');
  } finally {
    await browser?.close();
    await service.close();
  }
});

test('served web login PNG matches mobile browser baseline', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1', port: 0, projectRoot: '/repo',
    auth: { enabled: true, token: 'issued-token', password: 'web-password', maxAttempts: 5 },
    runtime: {
      loadState: async () => ({
        profile: { sources: {}, speed_test: {}, availability_targets: {}, deploy: {}, paths: {} },
        runState: 'idle', retryArtifacts: []
      }),
      subscribe: () => () => {}
    }
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
    await page.goto(service.origin);
    await page.waitForSelector('[data-server-login]');
    await assertPngBaseline(page, 'login-390x844');
  } finally {
    await browser.close();
    await service.close();
  }
});
