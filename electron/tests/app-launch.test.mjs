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
    await page.locator('#navConfig').click();
    await page.waitForSelector('#configPrimarySource');

    const hasBridge = await page.evaluate(() => Boolean(window.vpnAutomation));
    const hasStopBridge = await page.evaluate(() => typeof window.vpnAutomation?.stopPipeline === 'function');
    const pageTitle = await page.locator('#pageTitle').innerText();
    const stopVisible = await page.locator('#stopBtn').isVisible();
    const sourceInputs = page.locator('input[data-source][data-key="url"]');
    const primaryValue = await page.locator('#configPrimarySource').inputValue();

    assert.equal(hasBridge, true);
    assert.equal(hasStopBridge, true);
    assert.equal(stopVisible, true);
    assert.equal(pageTitle, '配置管理');
    assert.equal(await sourceInputs.count(), 5);
    assert.notEqual(primaryValue.trim(), '');

    for (let index = 0; index < 5; index += 1) {
      assert.notEqual((await sourceInputs.nth(index).inputValue()).trim(), '');
    }
  } finally {
    await app.close();
  }
});
