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
  applyNetworkDraft,
  applySourceIterationDraft,
  applyAvailabilityTargetDraft,
  buildAccountPoolRecords,
  buildAvailabilityTargetDraft,
  buildDashboardMetricsMarkup,
  buildNetworkDraft,
  buildPageMarkup,
  buildSidebarNav,
  buildViewModel,
  buildRegionStats,
  buildSourceIterationDraft,
  classifyLogEntry,
  extractSourceUrlFromCurl,
  filterAccountPoolAccounts,
  filterLogEntries,
  groupLogEntriesByStage,
  normalizeOfficialSourceDraft,
  removeAvailabilityTargetDraft,
  resolveDashboardRunSummary,
  validateSourceDraft
} from '../renderer/views.js';

test('buildSidebarNav marks only the active page as current', () => {
  const nav = buildSidebarNav(getMessages('zh-CN'), 'runs');

  assert.match(nav, /id="navRuns"[^>]*aria-current="page"/);
  assert.doesNotMatch(nav, /id="navDashboard"[^>]*aria-current/);
});

test('buildStageModel marks stages in configured order', () => {
  const rows = buildStageModel({ doctor: 'success', availability: 'running', deploy: 'running' });
  assert.equal(rows[0].name, 'doctor');
  assert.equal(rows[0].status, 'success');
  assert.equal(rows[4].name, 'availability');
  assert.equal(rows[4].status, 'running');
  assert.equal(rows.at(-1).name, 'verify');
});

test('runs workspace exposes secondary controls and textual stage status', () => {
  const messages = getMessages('zh-CN');
  const vm = buildViewModel({
    runState: 'idle',
    stageStatus: { doctor: 'success', extract: 'running' },
    retryArtifacts: []
  }, messages, 'zh-CN');
  const markup = buildPageMarkup('runs', vm, messages, 'zh-CN');

  assert.match(markup, /<details[^>]+class="[^"]*run-secondary-controls/);
  assert.match(markup, /doctor[\s\S]*?完成/);
  assert.match(markup, /extract[\s\S]*?运行中/);
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
  assert.equal(getMessages().sidebarVersion, 'v.2.3.0');
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

test('PAGE_ORDER exposes five pages with subscriptions included in results', () => {
  assert.equal(PAGE_ORDER.length, 5);
  assert.deepEqual(PAGE_ORDER, ['dashboard', 'runs', 'results', 'logs', 'settings']);
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

test('logs workspace exposes an accessible stream and separated destructive action', () => {
  const messages = getMessages('zh-CN');
  const vm = buildViewModel({
    runtime: 'web',
    logFilter: '错误',
    logEntries: ['[ERROR] availability failed'],
    logView: { follow: false, unseenCount: 3, clearedSnapshot: null }
  }, messages, 'zh-CN');
  const markup = buildPageMarkup('logs', vm, messages, 'zh-CN');

  assert.match(markup, /id="logCenterTable"[^>]*role="log"/);
  assert.match(markup, /data-log-filter="错误"[^>]*aria-pressed="true"/);
  assert.match(markup, /data-log-filter="全部"[^>]*aria-pressed="false"/);
  assert.match(markup, /class="[^"]*log-destructive-actions[^"]*"[\s\S]*data-action="clear-log"/);
  assert.match(markup, /data-log-jump-latest[\s\S]*3 条新消息/);
});

test('logs workspace hides latest and undo actions without pending state', () => {
  const messages = getMessages('zh-CN');
  const vm = buildViewModel({ logEntries: [], logView: { follow: true, unseenCount: 0, clearedSnapshot: null } }, messages, 'zh-CN');
  const markup = buildPageMarkup('logs', vm, messages, 'zh-CN');

  assert.doesNotMatch(markup, /data-log-jump-latest/);
  assert.doesNotMatch(markup, /data-log-undo-clear/);
});

test('buildRegionStats counts decoded vmess rows by region prefix', () => {
  const stats = buildRegionStats([
    { name: '🇺🇸 US alpha' },
    { name: '🇺🇸 US beta' },
    { name: '🇯🇵 JP tokyo' },
    { name: 'plain node' }
  ]);

  assert.deepEqual(stats, [
    { region: 'US', count: 3 },
    { region: 'JP', count: 1 }
  ]);
});

test('buildRegionStats trusts preview regionCode and defaults unknown regions to US', () => {
  const stats = buildRegionStats([
    { name: '🏳️ ZZ first', regionCode: 'OTHER' },
    { name: '🏳️ ZZ second', regionCode: 'ZZ' },
    { name: '🇺🇸 US real', regionCode: 'US' },
    { name: '🇯🇵 JP stale name', regionCode: 'US' }
  ]);

  assert.deepEqual(stats, [
    { region: 'US', count: 4 }
  ]);
});

test('the dashboard hero does not claim a finished run while one is in flight', () => {
  // A live run creates its artifact directory before it produces anything, so
  // `hasResult` is already true. The hero card must follow runState, or the
  // user sees green "success" while the counters beside it are still moving.
  const messages = getMessages('zh-CN');
  const running = buildViewModel({
    runState: 'running',
    artifactDir: '/tmp/artifacts/20261109-220238',
    counts: { raw_links: 54, deduped_links: 51 }
  }, messages, 'zh-CN');
  const runningMarkup = buildPageMarkup('dashboard', running, messages, 'zh-CN');
  // Check the actual state, rather than retaining redundant explanatory copy.
  assert.match(runningMarkup, /运行中/);
  assert.doesNotMatch(runningMarkup, /最近一次运行已完成/);
  assert.match(runningMarkup, /status-hero-card is-running/);
  assert.match(runningMarkup, /aria-label="立即运行"/);
  assert.doesNotMatch(runningMarkup, /最近运行结果|系统状态/);

  const finished = buildViewModel({
    runState: 'success',
    artifactDir: '/tmp/artifacts/20261109-220238',
    counts: { raw_links: 54, deduped_links: 51 }
  }, messages, 'zh-CN');
  const finishedMarkup = buildPageMarkup('dashboard', finished, messages, 'zh-CN');
  assert.match(finishedMarkup, /id="dashboardAnalytics"/);
  assert.doesNotMatch(finishedMarkup, /status-hero-card is-running/);

  const nextRun = buildViewModel({ runState: 'running', runResult: 'success' }, messages, 'zh-CN');
  assert.equal(nextRun.currentStatusLabel, '运行中');
  const idle = buildViewModel({ runState: 'idle' }, messages, 'zh-CN');
  assert.match(buildPageMarkup('dashboard', idle, messages, 'zh-CN'), /空闲/);
});

test('results page renders unknown preview regions as US', () => {
  const messages = getMessages('zh-CN');
  const vm = buildViewModel({
    runState: 'success',
    artifactDir: '/tmp/artifact',
    nodeRows: [
      { name: '🏳️ ZZ node', regionCode: 'OTHER' },
      { name: '🇺🇸 US node', regionCode: 'US' }
    ]
  }, messages, 'zh-CN');
  const markup = buildPageMarkup('results', vm, messages, 'zh-CN');

  assert.match(markup, />US<\/span>[\s\S]*?<strong>2<\/strong>/);
  assert.doesNotMatch(markup, />其他<\/span>/);
  assert.doesNotMatch(markup, />ZZ<\/span>/);
});

test('the source drawer drafts only the four official sites and their rounds', () => {
  const sources = {
    'xuanfeng-area': { mode: 'credential', official_site: 'https://xf.example', enabled: true, max_iterations: 3, min_iterations: 10, plateau_limit: 2 },
    'xuanfeng-all-area': { mode: 'credential', official_site: 'https://xf.example', enabled: false, max_iterations: 7 },
    leiting: { url: 'https://a.example', key: 'a', enabled: true, max_iterations: 3000, min_iterations: 10, plateau_limit: 20, area_min: 10, area_max: 90 }
  };
  const draft = buildSourceIterationDraft(sources);

  // One row per vendor, in a stable order, with no url-mode leftovers.
  assert.deepEqual(Object.keys(draft.sources), ['leiting', 'heidong', 'mifeng', 'xuanfeng']);
  assert.equal(draft.sources.xuanfeng.max_iterations, 3);
  for (const source of Object.values(draft.sources)) {
    assert.equal(source.mode, 'credential');
    assert.equal(source.url, undefined);
    assert.equal(source.key, undefined);
    assert.equal(source.account, undefined);
    assert.equal(source.password, undefined);
    assert.equal(source.platform, undefined);
    assert.equal(source.area_min, undefined);
  }
  // A credential row's round floor is still read by the round policy, so it
  // survives the drawer. A legacy url row's floor describes 10 URL fetches, not
  // 10 route-loop rounds, so it goes with the other URL-mode caps.
  assert.equal(draft.sources.xuanfeng.min_iterations, 10);
  assert.equal(draft.sources.leiting.min_iterations, undefined);
  // A round is one cursor step over the fixed area list, so an unset round
  // budget falls back to 200 rather than the old full-sweep default of 4.
  assert.equal(draft.sources.leiting.max_iterations, 200);
  assert.equal(draft.sources.leiting.plateau_limit, 50);
  assert.equal(draft.sources.leiting.areas_per_round, 8);
  assert.equal(draft.sources.leiting.area_concurrency, 4);
});

test('a custom url source survives saving the sources drawer', () => {
  // The drawer renders only the four vendors, so a profile that also carries a
  // url-mode source must not lose it just because the drawer was saved.
  const sources = {
    leiting: { mode: 'credential', official_site: 'https://s.example', max_iterations: 4 },
    'my-relay': { mode: 'url', url: 'https://relay.example/list', key: 'k1', enabled: true, max_iterations: 9 }
  };
  const saved = applySourceIterationDraft(sources, buildSourceIterationDraft(sources));
  assert.deepEqual(saved['my-relay'], sources['my-relay']);
  assert.equal(saved.leiting.official_site, 'https://s.example');
});

test('a cleared official site is not refilled from the vendor default mid-edit', () => {
  // Refilling on every render replaced the input's value under the caret.
  const cleared = normalizeOfficialSourceDraft({ leiting: { mode: 'credential', official_site: '', max_iterations: 4 } });
  assert.equal(cleared.leiting.official_site, '');
  const fresh = normalizeOfficialSourceDraft({});
  assert.equal(fresh.leiting.official_site, 'https://www.68123836.com');
});

test('an untouched save keeps max_areas, which the credential flow still honours', () => {
  // The drawer never rendered this field, but extract.ts slices the frozen
  // route list by it. Deleting it in the obsolete-field sweep quietly widened
  // a capped crawl the moment the operator opened and saved the drawer.
  const stored = { leiting: { mode: 'credential', official_site: 'https://s.example', max_areas: 3, account_retry_limit: 120 } };
  const saved = applySourceIterationDraft(stored, buildSourceIterationDraft(stored));
  assert.equal(saved.leiting.max_areas, 3);
  assert.equal(saved.leiting.account_retry_limit, 120);
  // The old URL-mode shape is still dropped: those fields no longer run.
  const legacy = normalizeOfficialSourceDraft({ leiting: { url: 'https://x/api', key: 'k', use_random_area: true, area_min: 1 } });
  assert.equal(legacy.leiting.use_random_area, undefined);
  assert.equal(legacy.leiting.url, undefined);
});

test('saving the source drawer keeps each row\'s own rounds and area controls', () => {
  const sources = {
    leiting: { mode: 'credential', official_site: 'https://site.example', max_iterations: 3, plateau_limit: 2, areas_per_round: 5, area_concurrency: 8 },
    xuanfeng: { mode: 'credential', official_site: 'https://xf.example', max_iterations: 9, plateau_limit: 5 }
  };
  const draft = buildSourceIterationDraft(sources);
  draft.sources.leiting.max_iterations = 6;
  draft.sources.leiting.plateau_limit = 3;
  draft.sources.leiting.areas_per_round = 2;
  draft.sources.leiting.area_concurrency = 6;
  const saved = applySourceIterationDraft(draft.sources, draft);
  assert.equal(saved.leiting.max_iterations, 6);
  assert.equal(saved.leiting.plateau_limit, 3);
  assert.equal(saved.leiting.areas_per_round, 2);
  assert.equal(saved.leiting.area_concurrency, 6);
  assert.equal(saved.xuanfeng.max_iterations, 9);
  assert.equal(saved.xuanfeng.plateau_limit, 5);
  // A row that never stored the new fields gets the shipped defaults.
  assert.equal(saved.xuanfeng.areas_per_round, 8);
  assert.equal(saved.xuanfeng.area_concurrency, 4);
  // A caller that only passes the shared values still stamps every row.
  const shared = applySourceIterationDraft(sources, { maxIterations: 7, plateauLimit: 4, areasPerRound: 3, areaConcurrency: 2 });
  const stamped = Object.values(shared);
  assert.equal(stamped.length, 4);
  assert.deepEqual([...new Set(stamped.map((source) => source.max_iterations))], [7]);
  assert.deepEqual([...new Set(stamped.map((source) => source.plateau_limit))], [4]);
  assert.deepEqual([...new Set(stamped.map((source) => source.areas_per_round))], [3]);
  assert.deepEqual([...new Set(stamped.map((source) => source.area_concurrency))], [2]);
});

test('the source drawer rejects area values outside their documented bounds', () => {
  const draft = buildSourceIterationDraft({});
  assert.equal(validateSourceDraft(draft), '');
  draft.sources.leiting.areas_per_round = 65;
  assert.match(validateSourceDraft(draft), /每轮区域数/);
  draft.sources.leiting.areas_per_round = 64;
  assert.equal(validateSourceDraft(draft), '');
  draft.sources.leiting.area_concurrency = 0;
  assert.match(validateSourceDraft(draft), /同时请求数/);
  draft.sources.leiting.area_concurrency = 16;
  assert.equal(validateSourceDraft(draft), '');
  draft.sources.leiting.area_concurrency = 17;
  assert.match(validateSourceDraft(draft), /同时请求数/);
});

test('the source drawer refuses an enabled row with no official site', () => {
  const draft = buildSourceIterationDraft({});
  assert.equal(validateSourceDraft(draft), '');
  draft.sources.leiting.official_site = '';
  assert.match(validateSourceDraft(draft), /雷霆/);
  // A disabled row never reaches the network, so its empty site is fine.
  draft.sources.leiting.enabled = false;
  assert.equal(validateSourceDraft(draft), '');
  draft.maxIterations = 0;
  assert.match(validateSourceDraft(draft), /轮数/);
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
  assert.match(markup, /<aside[^>]*data-settings-dialog[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="settingsDrawerTitle"/);
  assert.match(markup, /aria-label="Gemini：URL"/);
});

test('settings drawer is inert and has no actions while closed, with explicit source field names when open', () => {
  const messages = getMessages('zh-CN');
  const profile = {
    sources: { leiting: { url: 'https://example.com', key: 'secret', enabled: true } },
    availability_targets: {},
    speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
    deploy: { subscription_url: '' }
  };
  const closedMarkup = buildPageMarkup('settings', buildViewModel({ profile }, messages, 'zh-CN'), messages, 'zh-CN');
  assert.match(closedMarkup, /id="settingsDrawer"[^>]*hidden[^>]*inert/);
  assert.doesNotMatch(closedMarkup, /data-drawer-close="cancel"|data-drawer-save="save"/);

  const openState = {
    profile,
    settingsDrawer: { section: 'sources', draft: { sources: profile.sources } }
  };
  const openMarkup = buildPageMarkup('settings', buildViewModel(openState, messages, 'zh-CN'), messages, 'zh-CN');
  // The drawer asks for an official site and the lap controls, nothing else:
  // credentials come from the pool and the control-plane key from the APK.
  assert.match(openMarkup, /aria-label="雷霆：官网地址"/);
  assert.match(openMarkup, /aria-label="雷霆：抓取遍数"/);
  assert.match(openMarkup, /aria-label="雷霆：空转早停（遍）"/);
  assert.match(openMarkup, /aria-label="雷霆：同时请求数"/);
  assert.match(openMarkup, /抓取遍数/);
  assert.match(openMarkup, /同时请求数/);
  // The round-era controls are gone from the drawer surface.
  assert.doesNotMatch(openMarkup, /data-drawer-key="max_iterations"|data-drawer-key="plateau_limit"|data-drawer-key="areas_per_round"/);
  assert.doesNotMatch(openMarkup, /aria-label="雷霆：密钥"|aria-label="雷霆：账号"|aria-label="雷霆：密码"/);
  assert.doesNotMatch(openMarkup, /data-drawer-mode/);
});

test('the source drawer help states per-platform laps and cross-platform fingerprints', () => {
  const messages = getMessages('zh-CN');
  const profile = {
    sources: { leiting: { mode: 'credential', official_site: 'https://example.com', max_iterations: 1000, plateau_limit: 50 } },
    availability_targets: {},
    speed_test: {},
    deploy: {}
  };
  const markup = buildPageMarkup(
    'settings',
    buildViewModel({ profile, settingsDrawer: { section: 'sources', draft: buildSourceIterationDraft(profile.sources) } }, messages, 'zh-CN'),
    messages,
    'zh-CN'
  );
  // 50 laps means 50 on each platform, never 25 + 25.
  assert.match(markup, /Android 与 iOS 两个通道同时抓取/);
  assert.match(markup, /50 遍就是 Android 50 遍加 iOS 50 遍，不是 25\+25/);
  // A lap is one full pass over the fixed area list, with the measured counts.
  assert.match(markup, /固定区域列表/);
  assert.match(markup, /一遍 = 把该加速器全部区域各请求一次/);
  assert.match(markup, /雷霆 30 \/ 黑洞 31 \/ 蜜蜂 31 \/ 旋风 26/);
  assert.match(markup, /一遍就是一轮，双端各自计遍/);
  // Early stop is judged on a fingerprint deduped across both platforms.
  assert.match(markup, /节点指纹/);
  assert.match(markup, /address \/ port \/ id \/ transport \/ host \/ path \/ tls \/ sni/);
  assert.match(markup, /另一端已经抓到的节点/);
  // The legacy production row seeds to 258 laps at the reference count 31,
  // and the estimate line shows the converted request budget before saving.
  assert.match(markup, /data-drawer-key="max_laps" value="258"/);
  assert.match(markup, /区域 31（估算） · 最多 258 遍 × 31 区域 = 7998 次请求\/端/);
});

test('the lap estimate uses the measured area count and clamps waves to the list', () => {
  const messages = getMessages('zh-CN');
  const profile = {
    sources: { leiting: { mode: 'credential', official_site: 'https://example.com', max_laps: 50, dry_laps: 13 } },
    availability_targets: {},
    speed_test: {},
    deploy: {}
  };
  const state = {
    profile,
    sourceCounts: { leiting: { raw_links: 10, area_count: 30 } },
    settingsDrawer: { section: 'sources', draft: buildSourceIterationDraft(profile.sources, { leiting: { area_count: 30 } }) }
  };
  const markup = buildPageMarkup('settings', buildViewModel(state, messages, 'zh-CN'), messages, 'zh-CN');
  assert.match(markup, /区域 30（实测） · 最多 50 遍 × 30 区域 = 1500 次请求\/端 · 并发 4 → 每遍 8 批（约 8 秒\/遍） · 早停 13 遍 = 390 次/);
  // A tiny debug list clamps the workers to its own length: 2 areas at
  // concurrency 4 is one wave, not ceil(2/4) reported as if 4 ran.
  const tiny = buildSourceIterationDraft({ leiting: { mode: 'credential', official_site: 'https://example.com', max_laps: 4, dry_laps: 2, area_concurrency: 4 } });
  const tinyMarkup = buildPageMarkup(
    'settings',
    buildViewModel({ profile, sourceCounts: { leiting: { area_count: 2 } }, settingsDrawer: { section: 'sources', draft: tiny } }, messages, 'zh-CN'),
    messages,
    'zh-CN'
  );
  assert.match(tinyMarkup, /区域 2（实测） · 最多 4 遍 × 2 区域 = 8 次请求\/端 · 并发 4 → 每遍 1 批/);
});

test('the lap draft seeds legacy rows, keeps stored laps, and defaults fresh rows', () => {
  // Production-shaped row: 1000 rounds x 8 areas converts to 258 laps at the
  // reference count 31, and to 267 at the measured 30.
  const legacy = { leiting: { mode: 'credential', official_site: 'https://x.example', max_iterations: 1000, plateau_limit: 50 } };
  const seeded = buildSourceIterationDraft(legacy);
  assert.equal(seeded.sources.leiting.max_laps, 258);
  assert.equal(seeded.sources.leiting.dry_laps, 13);
  const measured = buildSourceIterationDraft(legacy, { leiting: { area_count: 30 } });
  assert.equal(measured.sources.leiting.max_laps, 267);
  // A row that never stored a legacy budget gets the shipped lap defaults.
  const fresh = buildSourceIterationDraft({});
  assert.equal(fresh.sources.leiting.max_laps, 50);
  assert.equal(fresh.sources.leiting.dry_laps, 13);
  // Stored lap values are kept verbatim; the legacy numbers stay beside them.
  const stored = buildSourceIterationDraft({ leiting: { mode: 'credential', official_site: 'https://x.example', max_laps: 7, dry_laps: 3, max_iterations: 1000 } });
  assert.equal(stored.sources.leiting.max_laps, 7);
  assert.equal(stored.sources.leiting.dry_laps, 3);
  assert.equal(stored.sources.leiting.max_iterations, 1000);
  // Saving the seeded draft opts the row in and keeps the legacy keys on disk.
  const saved = applySourceIterationDraft(legacy, seeded);
  assert.equal(saved.leiting.max_laps, 258);
  assert.equal(saved.leiting.dry_laps, 13);
  assert.equal(saved.leiting.max_iterations, 1000);
  assert.equal(saved.leiting.plateau_limit, 50);
  assert.equal(saved.leiting.areas_per_round, 8);
  // Opening and cancelling writes nothing: the input profile is untouched.
  assert.equal(legacy.leiting.max_laps, undefined);
  assert.equal(legacy.leiting.dry_laps, undefined);
});

test('the source drawer refuses dry laps above the total laps', () => {
  const draft = buildSourceIterationDraft({});
  assert.equal(validateSourceDraft(draft), '');
  draft.sources.leiting.dry_laps = 51;
  assert.match(validateSourceDraft(draft), /空转早停（遍）不能大于抓取遍数/);
  draft.sources.leiting.dry_laps = 50;
  assert.equal(validateSourceDraft(draft), '');
  draft.sources.leiting.max_laps = 0;
  assert.match(validateSourceDraft(draft), /抓取遍数至少为 1/);
  draft.sources.leiting.max_laps = 50;
  draft.sources.leiting.dry_laps = 1.5;
  assert.match(validateSourceDraft(draft), /空转早停（遍）至少为 1/);
});

test('a stored dry-lap count above the total is clamped so the row stays savable', () => {
  // A profile written by an older build (or hand-edited) can already hold
  // dry > max. The validator refuses that pair, so opening the drawer and
  // pressing 保存 on an untouched row would fail for a value nobody typed.
  const stored = buildSourceIterationDraft({
    leiting: { mode: 'credential', official_site: 'https://x.example', max_laps: 10, dry_laps: 20 }
  });
  assert.equal(stored.sources.leiting.max_laps, 10);
  assert.equal(stored.sources.leiting.dry_laps, 10);
  assert.equal(validateSourceDraft(stored), '');
  // A valid stored pair is still kept verbatim.
  const valid = buildSourceIterationDraft({
    leiting: { mode: 'credential', official_site: 'https://x.example', max_laps: 10, dry_laps: 4 }
  });
  assert.equal(valid.sources.leiting.dry_laps, 4);
});

test('renderer network defaults round-trip through the drawer and save path', () => {
  const messages = getMessages('zh-CN');
  const state = {
    profile: { sources: {}, availability_targets: {}, speed_test: {}, deploy: {} },
    settingsDrawer: { section: 'network', draft: buildNetworkDraft({}) }
  };
  const markup = buildPageMarkup('settings', buildViewModel(state, messages, 'zh-CN'), messages, 'zh-CN');
  assert.match(markup, /data-settings-card="network"/);
  assert.match(markup, /网络出口/);
  assert.match(markup, /data-drawer-path="network.proxy_mode"/);
  assert.match(markup, /data-drawer-path="network.proxy_url"/);
  assert.match(markup, /value="proxy" selected/);
  assert.match(markup, /value="http:\/\/127\.0\.0\.1:7897"/);

  assert.deepEqual(buildNetworkDraft(undefined), { proxy_mode: 'proxy', proxy_url: 'http://127.0.0.1:7897' });
  assert.deepEqual(buildNetworkDraft({ proxy_mode: 'direct', proxy_url: '' }), { proxy_mode: 'direct', proxy_url: 'http://127.0.0.1:7897' });
  assert.deepEqual(buildNetworkDraft({ proxy_mode: 'bogus' }).proxy_mode, 'proxy');
  assert.deepEqual(applyNetworkDraft({ proxy_mode: 'auto', proxy_url: 'http://10.0.0.2:8080' }), { proxy_mode: 'auto', proxy_url: 'http://10.0.0.2:8080' });
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

test('deploy help is contextual and results retain deployment details', () => {
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

  // The overview identifies the editor; address rules belong inside its help.
  assert.doesNotMatch(settingsMarkup, /项目名变化会自动联动默认 Pages 地址/);
  const drawerMarkup = buildPageMarkup('settings', { ...vm, settingsDrawer: { section: 'deploy', draft: state.profile.deploy } }, messages, 'zh-CN');
  assert.match(drawerMarkup, /<details class="context-help">[\s\S]*?手动修改 URL 后/);
  assert.match(resultsMarkup, /部署详情/);
  assert.match(resultsMarkup, /\/tmp\/artifacts\/pages_bundle\/_worker\.js/);
  assert.match(resultsMarkup, /manifest\.json/);
});

test('subscription QR states render actionable errors and accessible format selection', () => {
  const messages = getMessages('zh-CN');
  const base = {
    profile: { sources: {}, deploy: { subscription_url: 'https://vpn.example/secret' } },
  };

  const errorMarkup = buildPageMarkup('results', buildViewModel({
    ...base,
    qr: { status: 'error', dataUrl: '', message: '生成失败' }
  }, messages, 'zh-CN'), messages, 'zh-CN');
  assert.match(errorMarkup, /生成失败/);
  assert.match(errorMarkup, /data-action="retry-qr"/);
  assert.doesNotMatch(errorMarkup, /data-subscription-format|[?&]format=/);

  const unavailableMarkup = buildPageMarkup('results', buildViewModel({
    ...base,
    qr: { status: 'unavailable', dataUrl: '', message: '' }
  }, messages, 'zh-CN'), messages, 'zh-CN');
  assert.match(unavailableMarkup, /当前环境不支持二维码生成/);
  assert.match(unavailableMarkup, /复制链接/);
});

test('result node rows expose one mobile label for each value', () => {
  const messages = getMessages('zh-CN');
  const vm = buildViewModel({
    nodeRows: [{ name: '东京超长节点', address: '1.2.3.4', protocol: 'vmess', path: '/edge' }]
  }, messages, 'zh-CN');
  const markup = buildPageMarkup('results', vm, messages, 'zh-CN');

  assert.equal((markup.match(/class="node-card-field"/g) ?? []).length, 5);
  assert.equal((markup.match(/东京超长节点/g) ?? []).length, 1);
  assert.match(markup, /node-card-field">节点名称/);
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

test('dashboard metrics render missing legacy per-source dedupe counts as unknown instead of zero', () => {
  const messages = getMessages('zh-CN');
  const vm = buildViewModel({
    profile: {
      sources: { leiting: { url: 'https://a.example', key: 'a', enabled: true } },
      availability_targets: {},
      speed_test: {},
      deploy: {}
    },
    counts: { raw_links: 7, deduped_links: 5 },
    sourceCounts: { leiting: { raw_links: 7 } }
  }, messages, 'zh-CN');

  assert.match(buildDashboardMetricsMarkup(vm), /雷霆 —/);
});

test('the account pool filters and sorts without exposing a password', () => {
  const pool = {
    status: 'ready',
    accounts: [
      { id: 1, brand: 'leiting', account_masked: 'y1***56', status: 'active', expires_at: '', use_count: 2, success_count: 2, fail_count: 0, status_reason: '', note: '' },
      { id: 2, brand: 'xuanfeng', account_masked: 'ab**cd', status: 'invalid', expires_at: '2026-01-01', use_count: 9, success_count: 0, fail_count: 1, status_reason: 'login rejected', note: '' },
      { id: 3, brand: 'leiting', account_masked: 'zz**99', status: 'active', expires_at: '2027-05-01', use_count: 1, success_count: 1, fail_count: 0, status_reason: '', note: '备用' }
    ],
    statusFilter: 'all',
    brandFilter: 'all',
    query: '',
    sortBy: 'brand'
  };
  assert.deepEqual(filterAccountPoolAccounts(pool).map((row) => row.id), [1, 3, 2]);
  assert.deepEqual(filterAccountPoolAccounts({ ...pool, statusFilter: 'active' }).map((row) => row.id), [1, 3]);
  assert.deepEqual(filterAccountPoolAccounts({ ...pool, brandFilter: 'xuanfeng' }).map((row) => row.id), [2]);
  assert.deepEqual(filterAccountPoolAccounts({ ...pool, query: '备用' }).map((row) => row.id), [3]);
  assert.deepEqual(filterAccountPoolAccounts({ ...pool, sortBy: 'uses' }).map((row) => row.id), [2, 1, 3]);

  const markup = buildAccountPoolRecords(pool);
  assert.match(markup, /y1\*\*\*56/);
  assert.match(markup, /login rejected/);
  assert.doesNotMatch(markup, /password|passwd/i);
});

test('the account pool panel shows the four vendors and a masked total', () => {
  const messages = getMessages('zh-CN');
  const vm = buildViewModel({
    profile: { sources: {}, speed_test: {}, availability_targets: {}, deploy: {} },
    accountPool: {
      status: 'ready',
      stats: {
        total: 6, active: 4, disabled: 1, expired: 1, invalid: 0, expiring_soon: 1, expiry_unknown: 3,
        by_brand: [{ brand: 'leiting', total: 6, active: 4, disabled: 1, expired: 1, invalid: 0, expiry_unknown: 3 }]
      },
      accounts: []
    }
  }, messages, 'zh-CN');
  const markup = buildPageMarkup('settings', vm, messages, 'zh-CN', {});
  assert.match(markup, /账号池/);
  assert.match(markup, /4<\/strong>[\s\S]*?可用账号 \/ 共 6 个/);
  assert.match(markup, /7 天内到期 1 个/);
  assert.match(markup, /到期时间未知 3/);
  for (const label of ['雷霆', '黑洞', '蜜蜂', '旋风']) {
    assert.match(markup, new RegExp(label));
  }
  assert.match(markup, /上传 CSV/);
});

test('the account pool renders an unknown expiry as 未知 and hides NaN for an older backend', () => {
  const messages = getMessages('zh-CN');
  const pool = {
    status: 'ready',
    stats: { total: 2, active: 2, expiring_soon: 0, by_brand: [] },
    accounts: [
      { id: 1, brand: 'leiting', account_masked: 'y1***56', status: 'active', expires_at: '', use_count: 0, success_count: 0, fail_count: 0 }
    ],
    statusFilter: 'all', brandFilter: 'all', query: '', sortBy: 'brand'
  };
  const records = buildAccountPoolRecords(pool);
  assert.match(records, /未知/);
  assert.doesNotMatch(records, /—/);
  // An older backend omits expiry_unknown; the banner must not print NaN.
  const vm = buildViewModel({ profile: { sources: {}, speed_test: {}, availability_targets: {}, deploy: {} }, accountPool: pool }, messages, 'zh-CN');
  const markup = buildPageMarkup('settings', vm, messages, 'zh-CN');
  assert.doesNotMatch(markup, /到期时间未知/);
  assert.doesNotMatch(markup, /NaN|undefined/);
  // Without the preload bridge there is no set-expiry control at all.
  assert.equal(pool.canSetExpiry, undefined);
  assert.doesNotMatch(records, /data-account-action="expiry-edit"/);
});

test('the account expiry affordance appears only when the bridge exists', () => {
  const profile = { sources: {}, speed_test: {}, availability_targets: {}, deploy: {} };
  const messages = getMessages('zh-CN');
  const baseAccount = { id: 7, brand: 'leiting', account_masked: 'zz**99', status: 'active', expires_at: '2027-05-01', use_count: 0, success_count: 0, fail_count: 0 };
  const pool = { status: 'ready', stats: { total: 1, active: 1, by_brand: [] }, accounts: [baseAccount], statusFilter: 'all', brandFilter: 'all', query: '', sortBy: 'brand' };
  const hidden = buildPageMarkup('settings', buildViewModel({ profile, accountPool: pool }, messages, 'zh-CN'), messages, 'zh-CN');
  assert.doesNotMatch(hidden, /data-account-action="expiry-edit"/);
  const shown = buildPageMarkup('settings', buildViewModel({
    profile,
    accountPool: { ...pool, canSetExpiry: true, expiryEditorId: 7 }
  }, messages, 'zh-CN'), messages, 'zh-CN');
  assert.match(shown, /data-account-action="expiry-save" data-account-id="7"/);
  assert.match(shown, /data-account-expiry-input="7"/);
  assert.match(shown, /value="2027-05-01"/);
});


test('the membership check appears only when the bridge exists and reports its busy state', () => {
  const profile = { sources: {}, speed_test: {}, availability_targets: {}, deploy: {} };
  const messages = getMessages('zh-CN');
  const pool = { status: 'ready', stats: { total: 3, active: 3, by_brand: [] }, accounts: [], statusFilter: 'all', brandFilter: 'all', query: '', sortBy: 'brand' };
  const render = (extra) => buildPageMarkup('settings', buildViewModel({ profile, accountPool: { ...pool, ...extra } }, messages, 'zh-CN'), messages, 'zh-CN');
  assert.doesNotMatch(render({}), /data-account-action="refresh-expiry"/);
  assert.match(render({ canRefreshExpiry: true }), /data-account-action="refresh-expiry"/);
  assert.match(render({ canRefreshExpiry: true }), /核对会员到期/);
  const busy = render({ canRefreshExpiry: true, refreshingExpiry: true, busy: true });
  assert.match(busy, /核对中…/);
  assert.match(busy, /data-account-action="refresh-expiry" type="button" disabled/);
});

test('dashboard live and full rendering agree after failure and stop with retained artifacts', () => {
  const messages = getMessages('zh-CN');
  const failed = buildViewModel({ runState: 'failed', artifactDir: '/tmp/retained' }, messages, 'zh-CN');
  assert.deepEqual(resolveDashboardRunSummary(failed), { isRunning: false, failed: true });
  assert.match(buildPageMarkup('dashboard', failed, messages, 'zh-CN'), /查看日志/);
  const idle = buildViewModel({ runState: 'idle' }, messages, 'zh-CN');
  assert.deepEqual(resolveDashboardRunSummary(idle), { isRunning: false, failed: false });
});
