import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { chromium } from 'playwright';
import { createAutoVpnServer } from '../../npm/autovpn-cli/dist/server/http.js';
import { createServerRuntime } from '../../npm/autovpn-cli/dist/server/runtime.js';

const evidence = path.resolve('electron/tests/visual-artifacts/workspace');
const pages = ['dashboard', 'runs', 'results', 'logs', 'settings'];

async function fixture() {
  const profile = {
    sources: { leiting: { official_site: 'https://example.test', enabled: true, max_iterations: 4, plateau_limit: 2 } },
    speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
    availability_targets: { gemini: { url: 'https://gemini.google.com', enabled: true } },
    deploy: { project_name: 'sub-nodes', subscription_url: 'https://example.test/sub' },
    paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
  };
  return createAutoVpnServer({
    host: '127.0.0.1', port: 0, projectRoot: '/repo', auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({
        profile, runState: 'idle', retryArtifacts: [],
        activity: [{ date: '2026-11-09', nodes: 30, runs: 2 }],
        artifact: {
          artifact_dir: '/repo/artifacts/20261109-120000',
          counts: { raw_links: 60, deduped_links: 42, speedtest_links: 36, availability_links: 30 },
          stage_status: { extract: 'success', dedupe: 'success', speedtest: 'success' },
          source_counts: { leiting: { raw_links: 60, deduped_links: 42 } },
          outputFiles: [],
          nodeRows: Array.from({ length: 30 }, (_, index) => ({
            name: (index < 20 ? 'US' : 'JP') + ' · Node ' + (index + 1), address: '203.0.113.' + (index + 1),
            protocol: 'vmess', path: '/edge/long-path/' + 'segment/'.repeat(8), link: 'vmess://fixture-' + index
          }))
        }, logEvents: [{ type: 'log', message: '[extract] 采集完成' },
          { type: 'extract_substage', source_name: 'leiting', platform: 'android', substage: 'apk_download', status: 'cached' },
          { type: 'extract_substage', source_name: 'leiting', platform: 'android', substage: 'apk_analysis', status: 'cached' },
          { type: 'extract_substage', source_name: 'leiting', platform: 'android', substage: 'domain_discovery', status: 'success' }]
      }),
      loadAccounts: async () => ({
        ok: true, stats: { total: 2, active: 2, by_brand: [{ brand: 'leiting', total: 2, active: 2 }] },
        accounts: [1, 2].map((id) => ({
          id, brand: 'leiting', account_masked: 'user' + id + '***@example.test',
          status: 'active', note: 'Fixture ' + id, use_count: id
        }))
      }),
      saveProfile: async () => ({ ok: true }),
      subscribe: () => () => {}
    }
  });
}

async function launch(t, options = {}) {
  const service = await fixture();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await service.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...options });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'renderer must not throw'));
  await page.addInitScript(() => { Date.now = () => 1794211200000; });
  await page.goto(service.origin);
  await page.waitForSelector('#dashboardOverview');
  return page;
}

test('web themes persist, follow the system and cover all five responsive pages', async (t) => {
  const page = await launch(t, { colorScheme: 'light', reducedMotion: 'reduce' });
  await fs.mkdir(evidence, { recursive: true });
  await page.locator('#navSettings').click();
  await page.locator('[data-theme-choice="dark"]').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.reload();
  await page.waitForSelector('#dashboardOverview');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  for (const theme of ['light', 'dark']) {
    await page.locator('#navSettings').click();
    await page.locator('[data-theme-choice="' + theme + '"]').click();
    for (const [width, height] of [[1440, 900], [1280, 800], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const name of pages) {
        await page.locator('#sidebarNav [data-page-target="' + name + '"]').click();
        assert.ok(await page.locator('[data-page-shell="' + name + '"]').isVisible());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ' overflows');
        await page.screenshot({ path: path.join(evidence, theme + '-' + name + '-' + width + '.png'), animations: 'disabled' });
      }
    }
  }
  await page.locator('[data-theme-choice="system"]').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await page.locator('[data-theme-choice="system"]').getAttribute('aria-pressed'), 'true');
});

test('table dragging, keyboard resizing and saved layout preserve data alignment', async (t) => {
  const page = await launch(t);
  await page.locator('#navResults').click();
  const table = page.locator('[data-column-table="nodes"]');
  const keys = () => table.locator('thead th').evaluateAll((cells) => cells.map((cell) => cell.dataset.columnKey));
  await table.locator('[data-column-key="address"] .column-grip').dragTo(table.locator('[data-column-key="name"] .column-grip'));
  assert.deepEqual(await keys(), ['index', 'address', 'name', 'protocol', 'path']);
  assert.match(await table.locator('tbody tr').first().locator('td').nth(1).innerText(), /203.0.113.1/);
  const handle = table.locator('[data-column-key="name"] .column-resize');
  const before = await table.locator('th[data-column-key="name"]').boundingBox();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await table.locator('th[data-column-key="name"]').boundingBox();
  assert.ok(after.width >= before.width + 130);
  await handle.press('ArrowRight');
  const keyboard = await table.locator('th[data-column-key="name"]').boundingBox();
  assert.ok(keyboard.width >= after.width + 15);
  await table.locator('[data-column-key="address"] .column-grip').press('Alt+ArrowRight');
  assert.deepEqual(await keys(), ['index', 'name', 'address', 'protocol', 'path']);
  const addressGrip = table.locator('[data-column-key="address"] .column-grip');
  await addressGrip.focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowLeft');
  assert.equal(await addressGrip.evaluate((node) => document.activeElement === node), true);
  assert.equal((await keys())[0], 'address');
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowRight');

  await page.locator('#navLogs').click();
  await page.locator('#navResults').click();
  assert.ok((await table.locator('th[data-column-key="name"]').boundingBox()).width >= keyboard.width - 1);
  await page.locator('.column-options > summary').click();
  await page.locator('[data-column-width="path"]').fill('880');
  await page.locator('[data-column-width="path"]').press('Tab');
  await page.locator('.column-options > summary').press('Escape');
  const wrap = page.locator('#resultNodePreview');
  await wrap.focus();
  await wrap.press('End');
  await page.mouse.move(600, 400);
  await wrap.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
  assert.ok(await wrap.evaluate((node) => node.scrollLeft > 0));
  await page.waitForFunction(() => document.querySelector('#resultNodePreview').hasAttribute('data-scroll-active'));
  await page.waitForFunction(() => !document.querySelector('#resultNodePreview').hasAttribute('data-scroll-active'));
  assert.equal(await wrap.evaluate((node) => getComputedStyle(node, '::-webkit-scrollbar').height), '4px');
  await page.reload();
  await page.waitForSelector('#dashboardOverview');
  await page.locator('#navResults').click();
  await page.locator('.column-options > summary').click();
  assert.equal(await page.locator('[data-column-width="path"]').inputValue(), '880');
  await page.locator('[data-columns-reset]').click();
  assert.deepEqual(await keys(), ['index', 'name', 'address', 'protocol', 'path']);
  assert.equal(await page.locator('[data-column-width="path"]').inputValue(), '300');
  await page.locator('#navSettings').click();
  await page.locator('[data-column-table="accounts"]').waitFor();
  await page.locator('[data-column-table="accounts"] [data-column-key="brand"] .column-grip').press('Alt+ArrowLeft');
  assert.match(await page.locator('[data-column-table="accounts"] tbody tr').first().locator('td').first().innerText(), /雷霆/);
  await page.locator('[data-account-search]').fill('Fixture 2');
  assert.equal(await page.locator('[data-account-row]').count(), 1);
  assert.equal(await page.locator('[data-column-table="accounts"] th').first().getAttribute('data-column-key'), 'brand');
});

test('compact dialogs retain labels, cancel drafts and offer touch column controls', async (t) => {
  const page = await launch(t);
  await page.locator('#navSettings').click();
  await page.locator('[data-settings-card="speed_test"]').click();
  const dialog = page.locator('[data-settings-dialog]');
  assert.ok((await dialog.boundingBox()).width <= 560);
  const input = page.locator('[data-drawer-path="speed_test.concurrency"]');
  assert.ok((await input.boundingBox()).width <= 180);
  await input.fill('7');
  await dialog.press('Escape');
  await page.locator('[data-settings-card="speed_test"]').click();
  assert.equal(await input.inputValue(), '3');
  await dialog.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-theme-choice="dark"]').click();
  await page.locator('[data-settings-card="deploy"]').click();
  const save = page.locator('[data-drawer-save]');
  await save.scrollIntoViewIfNeeded();
  assert.ok((await save.boundingBox()).height >= 44);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await dialog.press('Escape');
  await page.locator('#navResults').click();
  await page.locator('.column-options > summary').click();
  const move = page.locator('[data-column-option="path"] [data-column-move="left"]');
  assert.ok((await move.boundingBox()).width >= 44);
  await move.click();
  await page.locator('.column-options > summary').press('Escape');
  assert.match(await page.locator('#resultNodePreview tbody tr').first().innerText(), /US · Node 1/);
});

test('web account upload persists in the same SQLite store used by desktop and CLI', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autovpn-web-pool-'));
  await fs.copyFile('electron/runtime/default-profile.toml', path.join(runtimeRoot, 'profile.toml'));
  const env = { ...process.env, VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot, AUTOVPN_SERVER_HISTORY_RETENTION_DAYS: '0' };
  const runtime = createServerRuntime({ projectRoot: process.cwd(), env });
  const service = await createAutoVpnServer({ host: '127.0.0.1', port: 0, projectRoot: process.cwd(), auth: { enabled: false, token: '' }, runtime });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await service.close(); await fs.rm(runtimeRoot, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(service.origin);
  await page.locator('#navSettings').click();
  await page.locator('[data-account-file]').setInputFiles({
    name: 'accounts.csv', mimeType: 'text/csv',
    buffer: Buffer.from('brand,account,password\nleiting,ui-fixture-account,fixture-password\n')
  });
  await page.waitForSelector('[data-account-row]');
  assert.equal(await page.locator('[data-account-row]').count(), 1);
  await page.locator('[data-account-action="refresh"]').click();
  await page.waitForSelector('[data-account-row]');
  await page.reload();
  await page.locator('#navSettings').click();
  await page.waitForSelector('[data-account-row]');
  assert.equal(await page.locator('[data-account-row]').count(), 1);
  const reconnected = createServerRuntime({ projectRoot: process.cwd(), env });
  const snapshot = await reconnected.loadAccounts();
  assert.equal(snapshot.stats.total, 1);
  assert.doesNotMatch(JSON.stringify(snapshot.accounts), /fixture-password/);
  await reconnected.close();
});

test('sidebar collapse preserves content bounds and persists without hiding navigation', async (t) => {
  const page = await launch(t);
  await page.locator('#navSettings').click();
  await page.waitForSelector('[data-account-row]');
  for (const collapsed of [true, false, true]) {
    await page.locator('#sidebarToggle').click();
    assert.equal(await page.locator('#sidebarToggle').getAttribute('aria-expanded'), String(!collapsed));
    const geometry = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const content = document.querySelector('#pageContent');
      const panel = document.querySelector('#accountPoolPanel').getBoundingClientRect();
      return { sidebarRight: sidebar.right, panelLeft: panel.left, panelRight: panel.right, viewWidth: innerWidth, scrollLeft: content.scrollLeft, client: content.clientWidth, scroll: content.scrollWidth };
    });
    assert.ok(geometry.panelLeft >= geometry.sidebarRight);
    assert.ok(geometry.panelRight <= geometry.viewWidth);
    assert.equal(geometry.scrollLeft, 0);
    assert.equal(geometry.client, geometry.scroll);
  }
  await page.reload();
  await page.waitForSelector('#dashboardOverview');
  assert.equal(await page.locator('#sidebarToggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#sidebarNav .nav-item').count(), 5);
});

test('beUI charts expose the real node distributions and keyboard heatmap details', async (t) => {
  const page = await launch(t, { reducedMotion: 'reduce' });
  await page.waitForSelector('[data-component-source="beui"]');
  assert.equal(await page.getByRole('img', { name: '国家分布' }).count(), 1);
  assert.equal(await page.getByRole('img', { name: '加速器贡献' }).count(), 1);
  const chartGeometry = await page.locator('.analytics-distribution').first().evaluate((node) => {
    const caption = node.querySelector('.overflow-hidden p');
    const text = caption.getBoundingClientRect(), clip = caption.parentElement.getBoundingClientRect();
    return { listStyle: getComputedStyle(node.querySelector('ul')).listStyleType, captionVisible: text.top >= clip.top - 1 && text.bottom <= clip.bottom + 1 };
  });
  assert.equal(chartGeometry.listStyle, 'none');
  assert.equal(chartGeometry.captionVisible, true);
  assert.equal(await page.locator('.calendar-scroll').evaluate((node) => getComputedStyle(node, '::-webkit-scrollbar').height), '4px');

  assert.match(await page.locator('.analytics-distribution').nth(1).innerText(), /雷霆[\s\S]*42/);
  assert.match(await page.locator('.analytics-heading').innerText(), /30 个节点/);
  const cell = page.locator('[data-heat-cell]').last();
  await cell.focus();
  await page.waitForSelector('[role="tooltip"]');
  assert.ok(await page.locator('[role="tooltip"]').isVisible());
  const box = await page.locator('[role="tooltip"]').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 1280);
  await cell.press('Escape');
});

test('run monitor scrolls actual extraction substages without duplicate run actions', async (t) => {
  const page = await launch(t);
  await page.locator('#navRuns').click();
  assert.equal(await page.locator('[data-run-action]').count(), 0);
  assert.match(await page.locator('.timeline-substeps').innerText(), /APK 下载[\s\S]*缓存[\s\S]*域名探测/);
  const timeline = page.locator('.timeline');
  assert.ok(await timeline.evaluate((node) => node.scrollHeight > node.clientHeight));
  await timeline.focus();
  await timeline.press('End');
  await page.waitForFunction(() => document.querySelector('.timeline').scrollTop > 0);
});

test('finishing a web run refreshes the visible contribution calendar without navigation', async (t) => {
  let activity = [];
  let publish;
  const service = await createAutoVpnServer({ host: '127.0.0.1', port: 0, projectRoot: '/repo', auth: { enabled: false, token: '' }, runtime: {
    loadState: async () => ({ profile: { sources: {}, speed_test: {}, deploy: { subscription_url: 'https://example.test/sub' }, paths: {} }, runState: 'idle', retryArtifacts: [], activity }),
    subscribe: (handler) => { publish = handler; return () => {}; }
  } });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await service.close(); });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.addInitScript(() => { Date.now = () => 1794211200000; });
  const connected = page.waitForResponse((response) => response.url().includes('/api/events'));
  await page.goto(service.origin);
  await connected;
  await page.waitForSelector('.analytics-heading');
  assert.match(await page.locator('.analytics-heading').innerText(), /0 个节点/);
  activity = [{ date: '2026-11-09', nodes: 7, runs: 1 }];
  publish({ type: 'finished', ok: true });
  await page.waitForFunction(() => document.querySelector('.analytics-heading')?.textContent?.includes('7 个节点'));
  assert.equal(await page.locator('body').getAttribute('data-page'), 'dashboard');
});
