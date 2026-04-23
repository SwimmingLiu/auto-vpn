import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..', '..');

test('electron app exposes preload bridge and renders the real saved profile', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-electron-profile-'));
  const runtimeProfilePath = path.join(runtimeRoot, 'state', 'profiles', 'default.json');
  fs.mkdirSync(path.dirname(runtimeProfilePath), { recursive: true });
  fs.writeFileSync(
    runtimeProfilePath,
    JSON.stringify({
      sources: {
        leiting: { url: 'https://seed.example/leiting', key: 'k1', enabled: true, max_iterations: 40, plateau_limit: 8, use_random_area: true },
        heidong: { url: 'https://seed.example/heidong', key: 'k2', enabled: true, max_iterations: 40, plateau_limit: 8, use_random_area: true },
        mifeng: { url: 'https://seed.example/mifeng', key: 'k3', enabled: true, max_iterations: 40, plateau_limit: 8, use_random_area: true },
        xuanfeng1: { url: 'https://seed.example/xuanfeng1', key: 'k4', enabled: true, max_iterations: 40, plateau_limit: 8, use_random_area: false },
        xuanfeng2: { url: 'https://seed.example/xuanfeng2', key: 'k5', enabled: true, max_iterations: 40, plateau_limit: 8, use_random_area: true }
      },
      speed_test: {
        min_download_mb_s: 1,
        timeout_seconds: 20,
        concurrency: 3,
        urls: ['https://speed.cloudflare.com/__down?bytes=5000000'],
        probe_url: 'https://www.gstatic.com/generate_204',
        max_download_bytes: 5000000,
        startup_wait_seconds: 1
      },
      deploy: {
        project_name: 'vmessnodes',
        subscription_url: 'https://example.com/subscription',
        pages_project_url: 'https://example.pages.dev',
        secret_query: 'secret=1',
        account_id: 'account-id',
        use_wrangler: true
      },
      workspace: {
        project_root: projectRoot,
        workspace_root: path.dirname(projectRoot),
        vpn_catch_nodes_root: '',
        edgetunnel_root: '',
        artifacts_root: path.join(projectRoot, 'artifacts'),
        state_root: path.join(projectRoot, 'state'),
        env_file: path.join(projectRoot, '.env'),
        build_root: path.join(projectRoot, 'build'),
        profile_path: runtimeProfilePath
      },
      filters: {
        excluded_country_codes: ['CN'],
        per_country_limit: { HK: 5, TW: 5 }
      }
    }),
    'utf-8'
  );

  const app = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      VPN_AUTOMATION_PROFILE_PATH: runtimeProfilePath
    }
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#pageContent');
    await page.locator('#navConfig').click();
    await page.waitForSelector('#configPrimarySource');
    await page.waitForFunction(() => {
      const input = document.querySelector('#configPrimarySource');
      return Boolean(input && input.value.trim().length > 0);
    });

    const hasBridge = await page.evaluate(() => Boolean(window.vpnAutomation));
    const hasStopBridge = await page.evaluate(() => typeof window.vpnAutomation?.stopPipeline === 'function');
    const activeLanguage = await page.locator('#languageSelect').inputValue();
    const pageTitle = await page.locator('#pageTitle').innerText();
    const stopVisible = await page.locator('#stopBtn').isVisible();
    const sourceInputs = page.locator('input[data-source][data-key="url"]');
    const primaryValue = await page.locator('#configPrimarySource').inputValue();

    assert.equal(hasBridge, true);
    assert.equal(hasStopBridge, true);
    assert.equal(stopVisible, true);
    assert.equal(pageTitle, activeLanguage === 'zh-CN' ? '配置管理' : 'Configuration');
    assert.equal(await sourceInputs.count(), 5);
    assert.notEqual(primaryValue.trim(), '');

    for (let index = 0; index < 5; index += 1) {
      assert.notEqual((await sourceInputs.nth(index).inputValue()).trim(), '');
    }
  } finally {
    await app.close();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
