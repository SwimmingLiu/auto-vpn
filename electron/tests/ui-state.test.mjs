import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStageModel,
  PAGE_ORDER,
  resolveRunControlState,
  resolveVerifyMetricValue,
  toMetricItems
} from '../renderer/state.js';
import { getMessages, resolveLanguage } from '../renderer/i18n.js';
import {
  addAvailabilityTargetDraft,
  applySourceIterationDraft,
  applyAvailabilityTargetDraft,
  buildAvailabilityTargetDraft,
  buildDashboardMetricsMarkup,
  buildPageMarkup,
  buildViewModel,
  buildRegionStats,
  buildSourceIterationDraft,
  classifyLogEntry,
  extractSourceUrlFromCurl,
  filterLogEntries,
  groupLogEntriesByStage,
  removeAvailabilityTargetDraft
} from '../renderer/views.js';

test('buildStageModel marks stages in configured order', () => {
  const rows = buildStageModel({ doctor: 'success', availability: 'running', deploy: 'running' });
  assert.equal(rows[0].name, 'doctor');
  assert.equal(rows[0].status, 'success');
  assert.equal(rows[4].name, 'availability');
  assert.equal(rows[4].status, 'running');
  assert.equal(rows.at(-1).name, 'verify');
});

test('toMetricItems maps summary counts to Chinese labels', () => {
  const cards = toMetricItems({
    raw_links: 12,
    postprocess_links: 5,
    speedtest_links: 3,
    availability_links: 2
  });
  assert.deepEqual(cards[0], { label: '原始节点', value: '12' });
  assert.deepEqual(cards[1], { label: '去重节点', value: '5' });
  assert.deepEqual(cards[2], { label: '测速通过节点', value: '3' });
  assert.deepEqual(cards[3], { label: '最终可用', value: '2' });
});

test('resolveVerifyMetricValue preserves running and failed verify states', () => {
  const zh = getMessages('zh-CN');

  assert.equal(resolveVerifyMetricValue('pending', zh), '待运行');
  assert.equal(resolveVerifyMetricValue('running', zh), '运行中');
  assert.equal(resolveVerifyMetricValue('failed', zh), '失败');
  assert.equal(resolveVerifyMetricValue('success', zh), '已验证');
});

test('resolveRunControlState exposes run and stop availability for each run state', () => {
  assert.deepEqual(resolveRunControlState('idle'), {
    isBusy: false,
    runDisabled: false,
    stopDisabled: true
  });

  assert.deepEqual(resolveRunControlState('running'), {
    isBusy: true,
    runDisabled: true,
    stopDisabled: false
  });

  assert.deepEqual(resolveRunControlState('stopping'), {
    isBusy: true,
    runDisabled: true,
    stopDisabled: true
  });
});

test('resolveLanguage ignores saved and system language and always returns zh-CN', () => {
  assert.equal(resolveLanguage(), 'zh-CN');
  assert.equal(resolveLanguage('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLanguage('en-US', 'en-US'), 'zh-CN');
  assert.equal(resolveLanguage('', 'zh-TW'), 'zh-CN');
});

test('getMessages exposes Chinese-only copy', () => {
  assert.equal(getMessages().appTitle, 'AutoVPN');
  assert.equal(getMessages().sidebarTitle, 'AutoVPN');
  assert.equal(getMessages().sidebarVersion, 'v.1.6.5');
  assert.equal(getMessages().runButton, '立即运行');
  assert.equal(getMessages('en-US').pageTitles.results, '结果');
  assert.equal(
    getMessages('en-US').pageSubtitles.dashboard,
    '只展示运行状态、系统状态摘要、核心指标和最近结果'
  );
  assert.equal(getMessages('en-US').runButton, '立即运行');
  assert.equal(getMessages('en-US').stopButton, '停止运行');
  assert.equal(getMessages('en-US').languageLabel, '');
});

test('getMessages suppresses language-switching copy', () => {
  const messages = getMessages('en-US');

  assert.equal(messages.locale, 'zh-CN');
  assert.equal(messages.pageTitles.dashboard, '概览');
  assert.equal(messages.runButton, '立即运行');
  assert.equal(messages.stopButton, '停止运行');
  assert.equal(messages.languageLabel, '');
});

test('PAGE_ORDER exposes the six-page canvas workspace', () => {
  assert.equal(PAGE_ORDER.length, 6);
  assert.deepEqual(PAGE_ORDER, ['dashboard', 'runs', 'results', 'subscriptions', 'logs', 'settings']);
});

test('getMessages exposes the canvas-aligned workspace copy for the redesigned renderer', () => {
  const zh = getMessages('zh-CN');

  assert.equal(
    zh.brandSubtitle,
    '概览、运行、结果、订阅、日志、设置统一管理'
  );
  assert.equal(zh.pageTitles.dashboard, '概览');
  assert.equal(zh.pageTitles.results, '结果');
  assert.equal(zh.stopButton, '停止运行');
  assert.equal(zh.stageLabels.availability, '站点验证');
  assert.equal(
    zh.pageSubtitles.dashboard,
    '只展示运行状态、系统状态摘要、核心指标和最近结果'
  );
  assert.doesNotMatch(zh.pageSubtitles.dashboard, /高频操作|紧凑|抽屉/);
});

test('classifyLogEntry infers level and stage from log lines', () => {
  const entry = classifyLogEntry('[ERROR] availability failed after extract');

  assert.equal(entry.level, 'error');
  assert.equal(entry.stage, 'availability');
});

test('filterLogEntries filters runtime and error logs separately', () => {
  const entries = [
    classifyLogEntry('[INFO] extract started'),
    classifyLogEntry('[ERROR] availability failed'),
    classifyLogEntry('[WARN] deploy skipped')
  ];

  assert.equal(filterLogEntries(entries, '全部').length, 3);
  assert.deepEqual(
    filterLogEntries(entries, '运行日志').map((entry) => entry.line),
    ['[INFO] extract started', '[WARN] deploy skipped']
  );
  assert.deepEqual(
    filterLogEntries(entries, '错误').map((entry) => entry.line),
    ['[ERROR] availability failed']
  );
});

test('groupLogEntriesByStage groups unknown lines into 其他', () => {
  const groups = groupLogEntriesByStage([
    classifyLogEntry('[INFO] extract started'),
    classifyLogEntry('[ERROR] availability failed'),
    classifyLogEntry('plain line without stage')
  ]);

  assert.equal(groups[0].label, 'extract');
  assert.equal(groups[1].label, 'availability');
  assert.equal(groups.at(-1).label, '其他');
});

test('buildRegionStats counts decoded vmess rows by region prefix', () => {
  const stats = buildRegionStats([
    { name: '🇺🇸 US alpha' },
    { name: '🇺🇸 US beta' },
    { name: '🇯🇵 JP tokyo' },
    { name: 'plain node' }
  ]);

  assert.deepEqual(stats, [
    { region: 'US', count: 2 },
    { region: 'JP', count: 1 },
    { region: '其他', count: 1 }
  ]);
});

test('source iteration draft applies one max_iterations, plateau limit, and area range to all sources', () => {
  const sources = {
    leiting: { url: 'https://a.example', key: 'a', enabled: true, max_iterations: 12, min_iterations: 12, plateau_limit: 11, area_min: 10, area_max: 90 },
    heidong: { url: 'https://b.example', key: 'b', enabled: true, max_iterations: 40, min_iterations: 40, plateau_limit: 8, area_min: 0, area_max: 100 }
  };
  const draft = buildSourceIterationDraft(sources);

  assert.equal(draft.maxIterations, 12);
  assert.equal(draft.plateauLimit, 11);
  assert.equal(draft.areaMin, 10);
  assert.equal(draft.areaMax, 90);
  draft.maxIterations = 25;
  draft.plateauLimit = 20;
  draft.areaMin = 20;
  draft.areaMax = 60;

  assert.deepEqual(
    Object.values(applySourceIterationDraft(sources, draft)).map((source) => source.max_iterations),
    [25, 25]
  );
  assert.deepEqual(
    Object.values(applySourceIterationDraft(sources, draft)).map((source) => [source.area_min, source.area_max]),
    [[20, 60], [20, 60]]
  );
  assert.deepEqual(
    Object.values(applySourceIterationDraft(sources, draft)).map((source) => source.min_iterations),
    [12, 25]
  );
  assert.deepEqual(
    Object.values(applySourceIterationDraft(sources, draft)).map((source) => source.plateau_limit),
    [20, 20]
  );
});

test('availability target draft supports add edit and delete', () => {
  const draft = buildAvailabilityTargetDraft({
    gemini: {
      url: 'https://gemini.google.com',
      enabled: true,
      allowed_hosts: ['gemini.google.com']
    }
  });

  addAvailabilityTargetDraft(draft, 'tmailor');
  draft.targets[1].url = 'https://tmailor.example/';
  removeAvailabilityTargetDraft(draft, 0);

  assert.deepEqual(applyAvailabilityTargetDraft(draft), {
    tmailor: {
      url: 'https://tmailor.example/',
      enabled: true
    }
  });
});

test('settings page renders AI availability target card and drawer table', () => {
  const messages = getMessages('zh-CN');
  const state = {
    profile: {
      sources: {},
      availability_targets: {
        gemini: {
          url: 'https://gemini.google.com',
          enabled: true
        }
      },
      speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
      deploy: { subscription_url: 'https://vpn.example/sub' }
    },
    settingsDrawer: {
      section: 'availability_targets',
      draft: buildAvailabilityTargetDraft({
        gemini: {
          url: 'https://gemini.google.com',
          enabled: true
        }
      })
    }
  };
  const vm = buildViewModel(state, messages, 'zh-CN');
  const markup = buildPageMarkup('settings', vm, messages, 'zh-CN');

  assert.match(markup, /AI可达性检测/);
  assert.match(markup, /data-settings-card="availability_targets"/);
  assert.match(markup, /data-availability-action="add"/);
  assert.doesNotMatch(markup, /data-availability-key="allowed_hosts"/);
  assert.doesNotMatch(markup, /允许域名/);
  assert.doesNotMatch(markup, /data-availability-key="negative_phrases"/);
  assert.doesNotMatch(markup, /屏蔽短语/);
  assert.match(markup, /gemini\.google\.com/);
});

test('settings page renders deploy card and drawer fields', () => {
  const messages = getMessages('zh-CN');
  const state = {
    profile: {
      sources: {},
      availability_targets: {},
      speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
      deploy: {
        project_name: 'sub-nodes',
        pages_project_url: 'https://sub-nodes.pages.dev',
        subscription_url: 'https://vpn.example/sub',
        verify_subscription_url: 'https://verify.example/sub',
        cloudflare_api_token: '',
        pages_secret_admin: 'swimmingliu',
        min_final_links: 10
      }
    },
    settingsDrawer: {
      section: 'deploy',
      draft: {
        project_name: 'sub-nodes',
        pages_project_url: 'https://sub-nodes.pages.dev',
        subscription_url: 'https://vpn.example/sub',
        verify_subscription_url: 'https://verify.example/sub',
        cloudflare_api_token: '',
        pages_secret_admin: 'swimmingliu',
        min_final_links: 10
      }
    }
  };
  const vm = buildViewModel(state, messages, 'zh-CN');
  const markup = buildPageMarkup('settings', vm, messages, 'zh-CN');

  assert.match(markup, /部署配置/);
  assert.match(markup, /data-settings-card="deploy"/);
  assert.match(markup, /deploy\.project_name/);
  assert.match(markup, /deploy\.pages_project_url/);
  assert.match(markup, /deploy\.subscription_url/);
  assert.match(markup, /deploy\.verify_subscription_url/);
  assert.match(markup, /deploy\.cloudflare_api_token/);
  assert.match(markup, /deploy\.pages_secret_admin/);
  assert.match(markup, /deploy\.min_final_links/);
  assert.match(markup, /最少节点数/);
  assert.match(markup, /verify 订阅地址/);
  assert.match(markup, /Cloudflare Token/);
  assert.match(markup, /Pages Secret ADMIN/);
  assert.match(markup, /type="password"/);
  assert.match(markup, /sub-nodes/);
});

test('settings page renders deploy helper copy and results page renders deployment summary', () => {
  const messages = getMessages('zh-CN');
  const state = {
    profile: {
      sources: {},
      availability_targets: {},
      speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
      deploy: {
        project_name: 'sub-nodes',
        pages_project_url: 'https://sub-nodes.pages.dev',
        subscription_url: 'https://vpn.example/sub'
      }
    },
    deployment: {
      project_name: 'sub-nodes',
      pages_project_url: 'https://sub-nodes.pages.dev',
      worker_entry: '/tmp/artifacts/pages_bundle/_worker.js',
      module_manifest_path: '/tmp/artifacts/pages_bundle/manifest.json'
    },
    artifactDir: '/tmp/artifacts/20260429-230000',
    nodeRows: [],
    counts: { raw_links: 0, deduped_links: 0, speedtest_links: 0, availability_links: 0 }
  };

  const vm = buildViewModel(state, messages, 'zh-CN');
  const settingsMarkup = buildPageMarkup('settings', vm, messages, 'zh-CN');
  const resultsMarkup = buildPageMarkup('results', vm, messages, 'zh-CN');

  assert.match(settingsMarkup, /项目名变化会自动联动默认 Pages 地址/);
  assert.match(settingsMarkup, /手动修改 URL 后，后续不再自动覆盖/);
  assert.match(resultsMarkup, /本次 deploy 目标/);
  assert.match(resultsMarkup, /\/tmp\/artifacts\/pages_bundle\/_worker\.js/);
  assert.match(resultsMarkup, /manifest\.json/);
});

test('extractSourceUrlFromCurl returns the first request URL from a pasted curl command', () => {
  const value = extractSourceUrlFromCurl(
    "curl 'https://www.xnfvjf.info:20000/api/evmess?&proto=v6&platform=ios&ver=5.8.55347&unicode=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&deviceid=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&code=ZRGOIXI&recomm_code=&device_token=&f=2026-04-23&install=2026-04-23&xf_fans=0&token=ZGSNZ19nnZqSl2VobGppZZOWaGZonHGRYWeVk5lu&t=1777190098.382194&width=375.0&height=812.0&area=999' -H 'Host: www.xnfvjf.info:20000'"
  );

  assert.equal(
    value,
    'https://www.xnfvjf.info:20000/api/evmess?&proto=v6&platform=ios&ver=5.8.55347&unicode=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&deviceid=CDC37303-6CEC-4AB2-AAD9-AE88DEF1CF10&code=ZRGOIXI&recomm_code=&device_token=&f=2026-04-23&install=2026-04-23&xf_fans=0&token=ZGSNZ19nnZqSl2VobGppZZOWaGZonHGRYWeVk5lu&t=1777190098.382194&width=375.0&height=812.0&area=999'
  );
  assert.equal(extractSourceUrlFromCurl('https://already.example/sub'), 'https://already.example/sub');
  assert.equal(extractSourceUrlFromCurl('curl --compressed'), '');
});

test('dashboard metrics show deduped node copy and per-source dedupe counts', () => {
  const messages = getMessages('zh-CN');
  const vm = buildViewModel(
    {
      profile: {
        sources: {
          leiting: { url: 'https://a.example', key: 'a', enabled: true },
          heidong: { url: 'https://b.example', key: 'b', enabled: true }
        },
        availability_targets: {},
        speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
        deploy: { subscription_url: 'https://vpn.example/sub' }
      },
      counts: {
        raw_links: 12,
        deduped_links: 9,
        speedtest_links: 5,
        availability_links: 4
      },
      sourceCounts: {
        leiting: { raw_links: 7, deduped_links: 5 },
        heidong: { raw_links: 5, deduped_links: 4 }
      }
    },
    messages,
    'zh-CN'
  );

  const markup = buildDashboardMetricsMarkup(vm);

  assert.match(markup, /原始节点/);
  assert.match(markup, /去重节点/);
  assert.match(markup, /雷霆 7/);
  assert.match(markup, /雷霆 5/);
  assert.match(markup, /黑洞 4/);
  assert.doesNotMatch(markup, /去重后/);
});
