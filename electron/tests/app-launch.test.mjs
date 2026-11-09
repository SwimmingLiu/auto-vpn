import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..', '..');
const launchArgs = [projectRoot, '--ozone-platform=headless', '--disable-gpu', '--no-sandbox'];

async function waitForRendererBootstrap(page) {
  await page.waitForFunction(() => document.querySelector('#pageContent')?.childElementCount > 0);
}

test('electron app exposes preload bridge and renders the real saved profile', async () => {
  const app = await electron.launch({ args: launchArgs });

  try {
    const page = await app.firstWindow();
    await waitForRendererBootstrap(page);
    await page.evaluate(() => document.querySelector('#navSettings')?.click());
    await page.waitForSelector('[data-settings-card="sources"]', { state: 'attached' });

    const hasBridge = await page.evaluate(() => Boolean(window.vpnAutomation));
    const hasStopBridge = await page.evaluate(() => typeof window.vpnAutomation?.stopPipeline === 'function');
    const hasRunBridge = await page.evaluate(() => typeof window.vpnAutomation?.runPipeline === 'function');
    const hasQrBridge = await page.evaluate(() => typeof window.vpnAutomation?.generateQr === 'function');
    const hasOpenUrlBridge = await page.evaluate(() => typeof window.vpnAutomation?.openUrl === 'function');
    const hasPreviewBridge = await page.evaluate(() => typeof window.vpnAutomation?.previewArtifact === 'function');
    const hasArtifactListBridge = await page.evaluate(() => typeof window.vpnAutomation?.artifactList === 'function');
    const hasRetryStageBridge = await page.evaluate(() => typeof window.vpnAutomation?.retryStage === 'function');
    const hasCopyTextBridge = await page.evaluate(() => typeof window.vpnAutomation?.copyText === 'function');
    // Pages identified by navigation no longer repeat a visible top heading.
    const pageTitle = await page.locator('#pageTitle').textContent();
    const actionText = await page.locator('#pageActions').innerText();
    const sourceSummary = await page.locator('#settingsCardSummary-sources').innerText();

    assert.equal(hasBridge, true);
    assert.equal(hasStopBridge, true);
    assert.equal(hasRunBridge, true);
    assert.equal(hasQrBridge, true);
    assert.equal(hasOpenUrlBridge, true);
    assert.equal(hasPreviewBridge, true);
    assert.equal(hasArtifactListBridge, true);
    assert.equal(hasRetryStageBridge, true);
    assert.equal(hasCopyTextBridge, true);
    assert.equal(actionText.trim(), '');
    assert.equal(pageTitle, '设置');
    assert.notEqual(sourceSummary.trim(), '');
    assert.equal(await page.locator('#sidebarVersion').textContent(), 'v.2.0.1');
    assert.match(await page.locator('.brand-mark').getAttribute('src'), /vpn-auto-logo-v3.png/);
    assert.equal(await page.locator('.brand-mark').evaluate((image) => image.complete && image.naturalWidth > 0), true);

    // Exercise actual file:// + preload rendering as well as the H5 gate.
    // Restore the user's saved appearance after testing the local preference.
    const previousTheme = await page.evaluate(() => localStorage.getItem('autovpn.ui.theme'));
    try {
      await page.locator('[data-theme-choice="dark"]').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      for (const name of ['Dashboard', 'Runs', 'Results', 'Logs', 'Settings']) {
        await page.locator('#nav' + name).click();
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await page.locator('[data-settings-card="speed_test"]').click();
      assert.ok((await page.locator('[data-settings-dialog]').boundingBox()).width <= 560);
      await page.locator('[data-settings-dialog]').press('Escape');
    } finally {
      await page.evaluate((value) => {
        if (value === null) localStorage.removeItem('autovpn.ui.theme');
        else localStorage.setItem('autovpn.ui.theme', value);
      }, previousTheme);
    }
  } finally {
    await app.close();
  }
});

test('electron app can close the only window and reopen on macOS activate', { skip: process.platform !== 'darwin' }, async () => {
  const app = await electron.launch({ args: launchArgs });

  try {
    const page = await app.firstWindow();
    await waitForRendererBootstrap(page);
    await page.close();

    await app.evaluate(({ app }) => app.emit('activate'));
    const reopenedPage = await app.firstWindow();
    await waitForRendererBootstrap(reopenedPage);

    assert.equal(await reopenedPage.locator('#pageTitle').innerText(), '概览');
  } finally {
    await app.close();
  }
});
