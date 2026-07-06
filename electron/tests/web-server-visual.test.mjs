import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { chromium } from 'playwright';

import { createAutoVpnServer } from '../../npm/autovpn-cli/dist/server/http.js';

const EXPECTED_DIGESTS = {
  dashboard: '3f373970b0d02b9759b14383279680d5a4ec13a066b46fd7267f12f86a430212',
  runs: '9596fabf90291418ae7a254ab83cfcd291b34624ecb6ed227f398be37e01fc44'
};

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
