import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { chromium } from 'playwright';
import { PNG } from 'pngjs';

import { createAutoVpnServer } from '../../npm/autovpn-cli/dist/server/http.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const VISUAL_BASELINE_PLATFORM = process.env.VISUAL_BASELINE_PLATFORM || process.platform;
const MOBILE_BASELINE_DIR = path.join(TEST_DIR, 'visual-baselines/h5', VISUAL_BASELINE_PLATFORM);
const MOBILE_ARTIFACT_DIR = path.join(TEST_DIR, 'visual-artifacts/mobile');
const PIXEL_CHANNEL_THRESHOLD = 12;
const MAX_DIFFERENT_PIXEL_RATIO = 0.002;

function comparePng(actualBuffer, expectedBuffer) {
  const actual = PNG.sync.read(actualBuffer);
  const expected = PNG.sync.read(expectedBuffer);
  assert.equal(actual.width, expected.width, 'screenshot width changed');
  assert.equal(actual.height, expected.height, 'screenshot height changed');
  const diff = new PNG({ width: actual.width, height: actual.height });
  let differentPixels = 0;
  for (let index = 0; index < actual.data.length; index += 4) {
    const delta = Math.max(
      Math.abs(actual.data[index] - expected.data[index]),
      Math.abs(actual.data[index + 1] - expected.data[index + 1]),
      Math.abs(actual.data[index + 2] - expected.data[index + 2]),
      Math.abs(actual.data[index + 3] - expected.data[index + 3])
    );
    const changed = delta > PIXEL_CHANNEL_THRESHOLD;
    if (changed) differentPixels += 1;
    diff.data[index] = changed ? 255 : 255;
    diff.data[index + 1] = changed ? 0 : 255;
    diff.data[index + 2] = changed ? 96 : 255;
    diff.data[index + 3] = 255;
  }
  const totalPixels = actual.width * actual.height;
  return { differentPixels, ratio: differentPixels / totalPixels, diff: PNG.sync.write(diff) };
}

async function enableVisualTestFont(page) {
  await page.addInitScript(() => document.documentElement.dataset.visualTest = 'true');
}

async function waitForVisualTestFont(page) {
  await page.waitForFunction(async () => {
    await document.fonts.load('16px "AutoVPN Visual Test"');
    return document.fonts.check('16px "AutoVPN Visual Test"');
  });
}

async function assertPngBaseline(page, name) {
  const actual = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  const baselinePath = path.join(MOBILE_BASELINE_DIR, `${name}.png`);
  if (process.env.UPDATE_VISUAL_BASELINES === '1') {
    await fs.mkdir(MOBILE_BASELINE_DIR, { recursive: true });
    await fs.writeFile(baselinePath, actual);
    return;
  }
  const baseline = await fs.readFile(baselinePath);
  const comparison = comparePng(actual, baseline);
  if (comparison.ratio > MAX_DIFFERENT_PIXEL_RATIO) {
    await fs.mkdir(MOBILE_ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(path.join(MOBILE_ARTIFACT_DIR, `${name}-actual.png`), actual);
    await fs.writeFile(path.join(MOBILE_ARTIFACT_DIR, `${name}-diff.png`), comparison.diff);
    await fs.writeFile(path.join(MOBILE_ARTIFACT_DIR, `${name}-diff.txt`),
      `expected ${crypto.createHash('sha256').update(baseline).digest('hex')}\nactual   ${crypto.createHash('sha256').update(actual).digest('hex')}\ndifferent pixels ${comparison.differentPixels} (${(comparison.ratio * 100).toFixed(4)}%)\n`);
  }
  assert.ok(comparison.ratio <= MAX_DIFFERENT_PIXEL_RATIO,
    `${name} differs in ${(comparison.ratio * 100).toFixed(4)}% of pixels; inspect electron/tests/visual-artifacts/mobile`);
}

test('pixel comparison tolerates raster noise but rejects visible changes', () => {
  const expected = new PNG({ width: 100, height: 100 });
  expected.data.fill(255);
  const noisy = PNG.sync.read(PNG.sync.write(expected));
  noisy.data[0] -= PIXEL_CHANNEL_THRESHOLD;
  assert.equal(comparePng(PNG.sync.write(noisy), PNG.sync.write(expected)).ratio, 0);
  for (let pixel = 0; pixel < 25; pixel += 1) noisy.data[pixel * 4] = 0;
  assert.ok(comparePng(PNG.sync.write(noisy), PNG.sync.write(expected)).ratio > MAX_DIFFERENT_PIXEL_RATIO);
});

test('visual baselines are selected by operating system without weakening pixel thresholds', () => {
  assert.equal(path.basename(MOBILE_BASELINE_DIR), VISUAL_BASELINE_PLATFORM);
  assert.equal(MAX_DIFFERENT_PIXEL_RATIO, 0.002);
  assert.equal(PIXEL_CHANNEL_THRESHOLD, 12);
});

test('served web ui desktop PNGs match browser baselines', async () => {
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
    await enableVisualTestFont(page);
    await page.addInitScript(() => {
      const fixedNow = 1783051200000;
      Date.now = () => fixedNow;
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
    });
    await page.goto(`${service.origin}/`);
    await waitForVisualTestFont(page);
    await page.waitForSelector('#dashboardOverview');
    await page.waitForFunction(() => document.body.innerText.includes('20260703-120000'));
    await page.screenshot({ animations: 'disabled' });

    for (const [name, navSelector, readySelector] of [
      ['dashboard-1440x960', '#navDashboard', '#dashboardOverview'],
      ['runs-1440x960', '#navRuns', '#runsWorkspace']
    ]) {
      await page.locator(navSelector).click();
      await page.waitForSelector(readySelector);
      await page.waitForTimeout(120);
      await assertPngBaseline(page, name);
    }
  } finally {
    await browser?.close();
    await service.close();
  }
});

test('served web ui mobile PNGs match reviewable browser baselines', async () => {
  let subscriber;
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
          run_status: 'success',
          stage_status: { doctor: 'success', extract: 'success', dedupe: 'success', speedtest: 'success', availability: 'success', postprocess: 'success', render: 'success', obfuscate: 'success', deploy: 'success', verify: 'success' },
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
        logEvents: [{ type: 'log', message: '[verify] latest retained run completed successfully' }]
      }),
      startRun: async () => {
        setTimeout(() => subscriber?.({ type: 'stage', stage: 'speedtest', status: 'running' }), 25);
        return { ok: true, runId: 'visual-running' };
      },
      subscribe: (handler) => { subscriber = handler; return () => { subscriber = undefined; }; }
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
    await enableVisualTestFont(page);
    await page.addInitScript(() => {
      const fixedNow = 1783051200000;
      Date.now = () => fixedNow;
      window.localStorage.setItem('vpn-automation-language', 'zh-CN');
    });
    await page.goto(`${service.origin}/`);
    await waitForVisualTestFont(page);
    await page.waitForSelector('#dashboardOverview');

    for (const [name, navSelector, readySelector] of [
      ['dashboard-390x844', '#navDashboard', '#dashboardOverview'],
      ['runs-idle-390x844', '#navRuns', '#runsWorkspace'],
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
    await page.locator('#navRuns').click();
    await page.locator('#runsWorkspace [data-run-action="start"]').click();
    await page.waitForFunction(() => document.querySelector('#runStateBadge')?.textContent?.includes('运行中'));
    await page.waitForTimeout(60);
    await assertPngBaseline(page, 'runs-running-390x844');
    await page.locator('#navSettings').click();
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
    await enableVisualTestFont(page);
    await page.goto(service.origin);
    await waitForVisualTestFont(page);
    await page.waitForSelector('[data-server-login]');
    await assertPngBaseline(page, 'login-390x844');
  } finally {
    await browser.close();
    await service.close();
  }
});
