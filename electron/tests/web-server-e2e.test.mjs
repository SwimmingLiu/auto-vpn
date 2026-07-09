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

test('served web ui leaves stopping state when stop finds the server run already failed', async () => {
  let subscriber;
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: { leiting: { url: '<redacted>', key: '<redacted>', enabled: true } },
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: { cloudflare_api_token: '<redacted>' },
          paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
        },
        runState: 'idle',
        retryArtifacts: []
      }),
      startRun: async () => {
        queueMicrotask(() => subscriber?.({ type: 'stage', stage: 'extract', status: 'running' }));
        return { ok: true, runId: 'run-already-failed' };
      },
      stopRun: async () => ({ ok: true, requested: false, run_state: 'failed', error: 'Error: fetch failed' }),
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
    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');

    await page.locator('#runsWorkspace [data-run-action="start"]').click();
    await page.waitForFunction(() => !document.querySelector('#runsWorkspace [data-run-action="stop"]')?.disabled);
    await page.locator('#runsWorkspace [data-run-action="stop"]').click();

    await page.waitForFunction(() => !document.querySelector('#runsWorkspace [data-run-action="start"]')?.disabled);
    assert.equal(await page.locator('#runsWorkspace [data-run-action="stop"]').isDisabled(), true);
    assert.doesNotMatch(await page.locator('#runsWorkspace').innerText(), /停止中/);
  } finally {
    await browser?.close();
    await service.close();
  }
});

test('served web ui treats run_failed and failed summaries as terminal states', async () => {
  let subscriber;
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: false, token: '' },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: { leiting: { url: '<redacted>', key: '<redacted>', enabled: true } },
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: { cloudflare_api_token: '<redacted>' },
          paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
        },
        runState: 'idle',
        retryArtifacts: []
      }),
      startRun: async () => {
        queueMicrotask(() => {
          subscriber?.({ type: 'stage', stage: 'extract', status: 'running' });
          subscriber?.({ type: 'summary', run_status: 'failed', error: 'Error: fetch failed', artifact_dir: '/repo/artifacts/failed', stage_status: { extract: 'failed' }, counts: {} });
          subscriber?.({ type: 'run_failed', error: 'Error: fetch failed' });
        });
        return { ok: true, runId: 'run-failed' };
      },
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
    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');
    await page.locator('#runsWorkspace [data-run-action="start"]').click();

    await page.waitForFunction(() => !document.querySelector('#runsWorkspace [data-run-action="start"]')?.disabled);
    assert.equal(await page.locator('#runsWorkspace [data-run-action="stop"]').isDisabled(), true);
    assert.match(await page.locator('#runsWorkspace').innerText(), /失败|failed|fetch failed/i);
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

test('served web ui logs in from a password page with inline failure and ban messages', async () => {
  const seen = [];
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: true, token: 'issued-token', password: 'web-password', maxAttempts: 5 },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: {},
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: { cloudflare_api_token: '<Cloudflare Token>' },
          paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
        },
        runState: 'idle',
        retryArtifacts: []
      }),
      subscribe: () => () => {}
    }
  });

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    let sawDialog = false;
    page.on('dialog', async (dialog) => {
      sawDialog = true;
      await dialog.dismiss();
    });
    page.on('request', (request) => {
      if (request.url().includes('/api/')) {
        seen.push({ url: request.url(), auth: request.headers().authorization ?? '' });
      }
    });

    await page.goto(`${service.origin}/`);
    await page.waitForSelector('[data-server-login]');
    const loginText = await page.locator('[data-server-login]').innerText();
    assert.match(loginText, /AutoNetwork/);
    assert.doesNotMatch(loginText, /VPN/);
    assert.doesNotMatch(loginText, /serve|启动|打印|继续访问/);
    assert.equal(await page.title(), 'AutoNetwork');

    await page.locator('[data-server-password]').fill('wrong-password');
    await page.locator('[data-server-login-submit]').click();
    await page.waitForFunction(() => document.querySelector('[data-server-login-error]')?.textContent?.trim());
    assert.match(await page.locator('[data-server-login-error]').innerText(), /4|剩余|remaining/i);

    await page.locator('[data-server-password]').fill('web-password');
    await page.locator('[data-server-login-submit]').click();
    await page.waitForFunction(() => window.localStorage.getItem('autovpn.server.token') === 'issued-token');
    await page.waitForSelector('#dashboardOverview');

    assert.equal(sawDialog, false);
    assert.equal(await page.evaluate(() => window.localStorage.getItem('autovpn.server.token')), 'issued-token');
    assert.ok(seen.some((item) => item.url.endsWith('/api/auth/login')));
    assert.ok(seen.some((item) => item.url.endsWith('/api/state') && item.auth === 'Bearer issued-token'));
  } finally {
    await browser?.close();
    await service.close();
  }
});

test('served web ui shows an IP ban message on the password page', async () => {
  const service = await createAutoVpnServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot: '/repo',
    auth: { enabled: true, token: 'issued-token', password: 'web-password', maxAttempts: 1 },
    runtime: {
      loadState: async () => ({
        profile: {
          sources: {},
          speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
          availability_targets: {},
          deploy: {},
          paths: { project_root: '/repo', artifacts_root: '/repo/artifacts' }
        },
        runState: 'idle',
        retryArtifacts: []
      }),
      subscribe: () => () => {}
    }
  });

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${service.origin}/`);
    await page.waitForSelector('[data-server-login]');
    await page.locator('[data-server-password]').fill('wrong-password');
    await page.locator('[data-server-login-submit]').click();
    await page.waitForFunction(() => document.querySelector('[data-server-login-error]')?.textContent?.trim());
    assert.match(await page.locator('[data-server-login-error]').innerText(), /封禁|banned/i);
    assert.equal(await page.locator('[data-server-login-submit]').isDisabled(), true);
  } finally {
    await browser?.close();
    await service.close();
  }
});

test('served web ui uses a browser shell instead of the Electron titlebar', async () => {
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
      subscribe: () => () => {}
    }
  });

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${service.origin}/`);
    await page.waitForSelector('#dashboardOverview');

    assert.equal(await page.locator('body').getAttribute('data-runtime'), 'web');
    assert.equal(await page.locator('.window-titlebar').isVisible(), false);
    assert.equal(await page.locator('.app-frame').evaluate((element) => getComputedStyle(element).gridTemplateRows), '820px');
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

test('served web ui handles visible browser controls across all pages', async () => {
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
          availability_targets: {
            gemini: { url: 'https://gemini.google.com', enabled: true }
          },
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
          source_counts: { leiting: { raw_links: 5, deduped_links: 4 } },
          outputFiles: [],
          nodeRows: [
            {
              name: 'US demo',
              address: '203.0.113.10',
              protocol: 'vmess',
              path: '/sub',
              link: 'vmess://demo-node'
            }
          ]
        },
        retryArtifacts: [
          {
            artifact_dir: '/repo/artifacts/20260703-120000',
            artifact_name: '20260703-120000',
            run_status: 'failed',
            retryable_stages: ['render', 'deploy'],
            stage_status: { render: 'success', deploy: 'failed' }
          }
        ]
      }),
      saveProfile: async (profile) => {
        calls.push(['profile', profile.deploy?.project_name ?? '']);
        return { ok: true };
      },
      startRun: async (options) => {
        calls.push(['start', options]);
        queueMicrotask(() => subscriber?.({ type: 'stage', stage: 'extract', status: 'running' }));
        return { ok: true, runId: 'run-1' };
      },
      stopRun: async () => {
        calls.push(['stop']);
        queueMicrotask(() => subscriber?.({ type: 'finished', ok: true, stopped: true }));
        return { ok: true, requested: true };
      },
      startRetry: async (options) => {
        calls.push(['retry', options]);
        queueMicrotask(() => subscriber?.({ type: 'finished', ok: true }));
        return { ok: true, runId: 'retry-1' };
      },
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
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.goto(`${service.origin}/`);
    await page.waitForSelector('#dashboardOverview');

    await page.locator('#pageActions [data-action="open-settings"]').click();
    await page.waitForSelector('#settingsWorkspace');

    for (const section of ['sources', 'speed_test', 'availability_targets', 'deploy']) {
      await page.locator(`[data-settings-card="${section}"]`).click();
      await page.waitForSelector(`#settingsDrawer[data-open="true"][data-section="${section}"]`);
      if (section === 'availability_targets') {
        await page.locator('[data-availability-action="add"]').click();
        await page.locator('[data-availability-key="name"]').last().fill('custom');
      }
      if (section === 'deploy') {
        await page.locator('[data-drawer-path="deploy.project_name"]').fill('web-sub-nodes');
      }
      await page.locator('[data-drawer-save="save"]').click();
      await page.waitForSelector('#settingsDrawer[data-open="false"]');
    }

    await page.locator('#navRuns').click();
    await page.waitForSelector('#runsWorkspace');
    await page.locator('[data-run-retry-stage]').selectOption('deploy');
    await page.locator('[data-action="retry-stage"]').click();
    await page.waitForFunction(() => !document.querySelector('#runsWorkspace [data-run-action="start"]')?.disabled);

    await page.locator('#runsWorkspace [data-run-action="start"]').click();
    await page.waitForFunction(() => !document.querySelector('#runsWorkspace [data-run-action="stop"]')?.disabled);
    await page.locator('#runsWorkspace [data-run-action="stop"]').click();

    await page.locator('#navResults').click();
    await page.waitForSelector('#resultsWorkspace');
    await page.getByRole('button', { name: '复制节点' }).click();
    await page.waitForSelector('[data-toast]');
    assert.match(await page.locator('[data-toast]').innerText(), /复制|已复制/);
    await page.getByRole('button', { name: '打开目录' }).click();

    await page.locator('#navSubscriptions').click();
    await page.waitForSelector('#subscriptionCards');
    await page.getByRole('button', { name: 'Clash Meta' }).click();
    assert.match(await page.locator('#subscriptionCards [data-copy-text]').first().getAttribute('data-copy-text'), /format=clash-meta/);
    await page.getByRole('button', { name: '复制链接' }).click();
    await page.waitForSelector('[data-toast]');

    await page.locator('#navLogs').click();
    await page.waitForSelector('#logsWorkspace');
    await page.getByRole('button', { name: '错误' }).click();
    assert.match(await page.locator('.subtab.active').innerText(), /错误/);
    await page.getByRole('button', { name: '运行日志' }).click();
    await page.getByRole('button', { name: '按阶段' }).click();
    await page.getByRole('button', { name: '复制日志' }).click();
    await page.waitForSelector('[data-toast]');
    await page.getByRole('button', { name: '清空显示' }).click();
    await page.getByRole('button', { name: '打开日志文件' }).click();

    assert.ok(calls.some(([name]) => name === 'retry'));
    assert.ok(calls.some(([name]) => name === 'start'));
    assert.ok(calls.some(([name]) => name === 'stop'));
    assert.ok(calls.some(([name, projectName]) => name === 'profile' && projectName === 'web-sub-nodes'));
  } finally {
    await browser?.close();
    await service.close();
  }
});
