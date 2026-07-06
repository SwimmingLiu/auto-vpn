import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import { createAutoVpnServer } from '../../npm/autovpn-cli/dist/server/http.js';

test('served web ui loads profile and starts a run through the web adapter', async () => {
  const calls = [];
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
          counts: { raw_links: 5, deduped_links: 4, speedtest_links: 3, availability_links: 2 },
          source_counts: { leiting: { raw_links: 5 } },
          outputFiles: [],
          nodeRows: []
        },
        retryArtifacts: []
      }),
      startRun: async (options) => {
        calls.push(['start', options]);
        queueMicrotask(() => subscriber?.({ type: 'stage', stage: 'extract', status: 'running' }));
        return { ok: true, runId: 'run-1' };
      },
      stopRun: async () => ({ ok: true, requested: true }),
      subscribe: (handler) => {
        subscriber = handler;
        return () => {
          subscriber = undefined;
        };
      }
    }
  });

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${service.origin}/`);
    await page.waitForSelector('#dashboardOverview');

    assert.doesNotMatch(await page.locator('body').innerText(), /演示模式/);

    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');
    await page.locator('#runsWorkspace [data-run-action="start"]').click();
    await page.waitForTimeout(150);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['start', { skipDeploy: false, skipVerify: false, resumeLatest: false }]);
    assert.match(await page.locator('#runsWorkspace').innerText(), /extract|运行|日志/);
  } finally {
    await browser?.close();
    await service.close();
  }
});

test('served web ui stores token from url and authorizes api and sse requests', async () => {
  const seen = [];
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: true, token: 'server-secret' },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: {},
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: { cloudflare_api_token: '<redacted>' },
          paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
        },
        runState: 'idle',
        retryArtifacts: []
      }),
      startRun: async () => ({ ok: true, runId: 'token-run' }),
      subscribe: () => () => {}
    }
  });

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    page.on('request', (request) => {
      if (request.url().includes('/api/')) {
        seen.push({ url: request.url(), auth: request.headers().authorization ?? '' });
      }
    });
    await page.goto(`${service.origin}/?token=server-secret`);
    await page.waitForSelector('#dashboardOverview');
    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');
    await page.locator('[data-run-action="start"]').click();
    await page.waitForTimeout(150);

    assert.equal(await page.evaluate(() => window.localStorage.getItem('autovpn.server.token')), 'server-secret');
    assert.ok(seen.some((item) => item.url.endsWith('/api/state') && item.auth === 'Bearer server-secret'));
    assert.ok(seen.some((item) => item.url.includes('/api/events?token=server-secret')));
    assert.ok(!seen.some((item) => item.url.includes('/api/state?token=')));
    assert.ok(!seen.some((item) => item.url.includes('/api/runs?token=')));
  } finally {
    await browser?.close();
    await service.close();
  }
});

test('served web adapter saves profile, generates QR, and starts retry stage', async () => {
  const calls = [];
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: {},
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: { subscription_url: 'https://vpn.example/sub' },
          paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
        },
        runState: 'idle',
        retryArtifacts: []
      }),
      saveProfile: async (profile) => {
        calls.push(['profile', profile]);
        return { ok: true };
      },
      startRetry: async (options) => {
        calls.push(['retry', options]);
        return { ok: true, runId: 'retry-1' };
      },
      subscribe: () => () => {}
    }
  });

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${service.origin}/`);
    await page.waitForSelector('#dashboardOverview');

    const result = await page.evaluate(async () => {
      const profile = await window.vpnAutomation.saveProfile({ deploy: { pages_project_url: 'https://example.dev' } });
      const qr = await window.vpnAutomation.generateQr('https://vpn.example/sub');
      const retry = await window.vpnAutomation.retryStage({ artifactDir: '/repo/artifacts/run-1', stage: 'render' });
      return { profile, qr, retry };
    });

    assert.equal(result.profile.ok, true);
    assert.match(result.qr.dataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(result.retry, { ok: true, runId: 'retry-1' });
    assert.deepEqual(calls, [
      ['profile', { deploy: { pages_project_url: 'https://example.dev' } }],
      ['retry', { artifactDir: '/repo/artifacts/run-1', stage: 'render' }]
    ]);
  } finally {
    await browser?.close();
    await service.close();
  }
});
