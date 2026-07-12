import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium, webkit } from 'playwright';

import { createAutoVpnServer } from '../../npm/autovpn-cli/dist/server/http.js';

const VIEWPORTS = [
  [320, 568], [360, 800], [375, 667], [390, 844], [430, 932],
  [720, 900], [721, 900], [768, 1024], [960, 900], [961, 900], [844, 390]
];

export async function assertMobileLayout(page, { width, height }) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(80);
  const root = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  assert.equal(root.clientWidth, width);
  assert.ok(root.scrollWidth <= width, `horizontal overflow at ${width}x${height}: ${JSON.stringify(root)}`);

  const sidebar = await page.locator('.sidebar').boundingBox();
  assert.ok(sidebar, 'navigation must be visible');
  if (width <= 720) {
    assert.ok(sidebar.y + 2 >= height - sidebar.height, `expected bottom navigation at ${width}x${height}`);
  } else if (width <= 960) {
    assert.ok(sidebar.y < 4 && sidebar.width >= width - 2, `expected top navigation at ${width}x${height}`);
  } else {
    assert.ok(sidebar.x < 4 && sidebar.height >= height - 2, `expected sidebar navigation at ${width}x${height}`);
  }

  for (const item of await page.locator('#sidebarNav .nav-item').all()) {
    const box = await item.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, `undersized navigation target: ${JSON.stringify(box)}`);
  }
  assert.equal(await page.locator('#sidebarNav [aria-current="page"]').count(), 1);

  const reachable = page.locator('#pageContent button:visible, #pageContent input:visible, #pageContent select:visible, #pageContent [tabindex="0"]:visible');
  const finalElement = reachable.last();
  if (await reachable.count()) {
    await finalElement.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    const box = await finalElement.boundingBox();
    const nav = await page.locator('.sidebar').boundingBox();
    assert.ok(box && nav);
    if (width <= 720) assert.ok(box.y + box.height <= nav.y + 1, `final control hidden by navigation: ${JSON.stringify({ box, nav })}`);
  }
}

async function createFixture() {
  return createAutoVpnServer({
    host: '127.0.0.1', port: 0, projectRoot: '/repo', auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: { leiting: { url: 'https://capture.example/api', key: 'redacted', enabled: true } },
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: { gemini: { url: 'https://gemini.google.com', enabled: true } },
          deploy: { project_name: 'sub-nodes', subscription_url: 'https://example.test/sub', cloudflare_api_token: '<redacted>' },
          paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
        },
        runState: 'idle',
        artifact: {
          artifact_dir: '/repo/artifacts/20260703-120000',
          counts: { raw_links: 5, deduped_links: 4, speedtest_links: 3, availability_links: 2 },
          source_counts: { leiting: { raw_links: 5, deduped_links: 4 } },
          outputFiles: [], nodeRows: [{ name: 'US', address: '203.0.113.1', protocol: 'vmess', link: 'vmess://demo' }]
        }, retryArtifacts: [], logEvents: [{ type: 'log', message: '[extract] fixture' }]
      }),
      startRun: async () => ({ ok: true, runId: 'mobile' }), stopRun: async () => ({ ok: true, requested: true }),
      subscribe: () => () => {}
    }
  });
}

async function closeWithin(promise, milliseconds = 2000) {
  await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, milliseconds))]);
}

test('all breakpoint contracts preserve navigation, targets, overflow and content reachability', async () => {
  const service = await createFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await page.goto(service.origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dashboardOverview');
    for (const [width, height] of VIEWPORTS) await assertMobileLayout(page, { width, height });
    for (const [nav, ready] of [['Runs', '#runsWorkspace'], ['Results', '#resultsWorkspace'], ['Subscriptions', '#subscriptionCards'], ['Logs', '#logsWorkspace'], ['Settings', '#settingsWorkspace']]) {
      await page.locator(`#nav${nav}`).click();
      await page.waitForSelector(ready);
      await assertMobileLayout(page, { width: 390, height: 844 });
    }
    await page.locator('#navLogs').click();
    await assertMobileLayout(page, { width: 844, height: 390 });
    await page.locator('#navDashboard').click();
    await assertMobileLayout(page, { width: 768, height: 1024 });
  } finally {
    await closeWithin(browser.close());
    await closeWithin(service.close());
  }
});

test('WebKit preserves safe-area navigation, run bar and settings visual viewport', { timeout: 8000 }, async () => {
  const service = await createFixture();
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await page.goto(service.origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dashboardOverview');
    await assertMobileLayout(page, { width: 390, height: 844 });
    await page.evaluate(() => document.querySelector('#navRuns')?.click());
    await page.waitForSelector('#runsWorkspace');
    const { runBar, nav } = await page.evaluate(() => {
      const toBox = (node) => {
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      const button = document.querySelector('#runsWorkspace [data-run-action="start"]');
      return { runBar: toBox(button.parentElement), nav: toBox(document.querySelector('.sidebar')) };
    });
    assert.ok(runBar && nav && runBar.y + runBar.height <= nav.y);
    await page.evaluate(() => document.querySelector('#navSettings')?.click());
    await page.waitForSelector('#settingsWorkspace');
    await page.evaluate(() => document.querySelector('[data-settings-card="deploy"]')?.click());
    assert.equal(await page.locator('[data-drawer-save="save"]').isVisible(), true);
    assert.equal(await page.locator('[data-settings-dialog]').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.visualViewport.width));
  } finally {
    await closeWithin(browser.close());
    await closeWithin(service.close());
  }
});

test('WebKit mobile login reports an inline error and accepts the configured password', { timeout: 8000 }, async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1', port: 0, projectRoot: '/repo',
    auth: { enabled: true, token: 'issued-token', password: 'web-password', maxAttempts: 5 },
    runtime: {
      loadState: async () => ({ profile: { sources: {}, speed_test: {}, availability_targets: {}, deploy: {}, paths: {} }, runState: 'idle', retryArtifacts: [] }),
      subscribe: () => () => {}
    }
  });
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await page.goto(service.origin, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-server-password]').fill('wrong-password');
    await page.locator('[data-server-login-submit]').click();
    await page.waitForFunction(() => document.querySelector('[data-server-login-error]')?.textContent?.trim());
    await page.locator('[data-server-password]').fill('web-password');
    await page.locator('[data-server-login-submit]').click();
    await page.waitForSelector('#dashboardOverview');
    assert.equal(await page.evaluate(() => localStorage.getItem('autovpn.server.token')), 'issued-token');
  } finally {
    await closeWithin(browser.close());
    await closeWithin(service.close());
  }
});
