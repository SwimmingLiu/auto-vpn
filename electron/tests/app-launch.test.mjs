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
    await page.waitForSelector('#sourcesSummary .summary-line');

    const hasBridge = await page.evaluate(() => Boolean(window.vpnAutomation));
    const sourcesSummary = await page.locator('#sourcesSummary').innerText();
    const logs = await page.locator('#logOutput').innerText();

    assert.equal(hasBridge, true);
    assert.match(sourcesSummary, /https:\/\/www\./);
    assert.doesNotMatch(logs, /\[demo\]/i);
  } finally {
    await app.close();
  }
});
