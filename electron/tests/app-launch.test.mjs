import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..', '..');
const launchArgs = [projectRoot, '--ozone-platform=headless', '--disable-gpu', '--no-sandbox'];

async function waitForRendererBootstrap(page) {
  await page.waitForFunction(() => document.querySelector('#pageContent')?.childElementCount > 0);
}

async function resizeNativeWindow(app, page, size) {
  // Viewport emulation leaves the native surface smaller on Linux headless,
  // so pointer coordinates can miss a card even when its DOM box is visible.
  await app.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(width, height);
  }, size);
  await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, size);
}

test('electron preload renders a fresh runtime and opens settings at native sizes', async (t) => {
  // An existing developer profile hid the first-launch missing-section bug.
  // Use an empty runtime and isolated preferences on every platform.
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autovpn-native-launch-'));
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const app = await electron.launch({
    args: [...launchArgs, `--user-data-dir=${path.join(runtimeRoot, 'electron-data')}`],
    env: { ...process.env, VPN_AUTOMATION_RUNTIME_ROOT: runtimeRoot }
  });
  let previousZoom = null;

  try {
    const page = await app.firstWindow();
    previousZoom = await app.evaluate(({ BrowserWindow }) => { const contents = BrowserWindow.getAllWindows()[0].webContents; const zoom = contents.getZoomFactor(); contents.setZoomFactor(1); return zoom; });
    await resizeNativeWindow(app, page, { width: 1280, height: 800 });
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
    assert.equal(await page.evaluate(() => typeof window.vpnAutomation.loadState), 'function');
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
    assert.equal(await page.locator('#sidebarVersion').textContent(), 'v.2.2.4');
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
      // Test the supported minimum too; a clipped native frame must still
      // let the operator reach theme and account controls.
      await resizeNativeWindow(app, page, { width: 880, height: 640 });
      await page.locator('[data-theme-choice="light"]').click();
      const lastControl = page.locator('#settingsWorkspace button:visible, #settingsWorkspace input:visible, #settingsWorkspace select:visible').last();
      await lastControl.scrollIntoViewIfNeeded();
      const lastBox = await lastControl.boundingBox();
      assert.ok(lastBox.y >= 0 && lastBox.y + lastBox.height <= 640);
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
    if (previousZoom !== null) await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoom), previousZoom);
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
