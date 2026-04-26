import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..', '..');

test('electron app exposes preload bridge and renders the real saved profile', async () => {
  const app = await electron.launch({ args: [projectRoot] });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#pageContent');
    await page.locator('#navSettings').click();
    await page.waitForSelector('[data-settings-card="sources"]');

    const hasBridge = await page.evaluate(() => Boolean(window.vpnAutomation));
    const hasStopBridge = await page.evaluate(() => typeof window.vpnAutomation?.stopPipeline === 'function');
    const hasRunBridge = await page.evaluate(() => typeof window.vpnAutomation?.runPipeline === 'function');
    const hasQrBridge = await page.evaluate(() => typeof window.vpnAutomation?.generateQr === 'function');
    const hasOpenUrlBridge = await page.evaluate(() => typeof window.vpnAutomation?.openUrl === 'function');
    const hasPreviewBridge = await page.evaluate(() => typeof window.vpnAutomation?.previewArtifact === 'function');
    const pageTitle = await page.locator('#pageTitle').innerText();
    const actionText = await page.locator('#pageActions').innerText();
    const sourceSummary = await page.locator('#settingsCardSummary-sources').innerText();

    assert.equal(hasBridge, true);
    assert.equal(hasStopBridge, true);
    assert.equal(hasRunBridge, true);
    assert.equal(hasQrBridge, true);
    assert.equal(hasOpenUrlBridge, true);
    assert.equal(hasPreviewBridge, true);
    assert.equal(actionText.trim(), '');
    assert.equal(pageTitle, '设置');
    assert.notEqual(sourceSummary.trim(), '');
  } finally {
    await app.close();
  }
});
