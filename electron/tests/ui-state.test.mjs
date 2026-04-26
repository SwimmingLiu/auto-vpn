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
  buildPageMarkup,
  buildViewModel,
  buildRegionStats,
  buildSourceIterationDraft,
  classifyLogEntry,
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
  assert.deepEqual(cards[1], { label: '去重后', value: '5' });
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

test('source iteration draft applies one max_iterations and area range to all sources', () => {
  const sources = {
    leiting: { url: 'https://a.example', key: 'a', enabled: true, max_iterations: 12, area_min: 10, area_max: 90 },
    heidong: { url: 'https://b.example', key: 'b', enabled: true, max_iterations: 40, area_min: 0, area_max: 100 }
  };
  const draft = buildSourceIterationDraft(sources);

  assert.equal(draft.maxIterations, 12);
  assert.equal(draft.areaMin, 10);
  assert.equal(draft.areaMax, 90);
  draft.maxIterations = 25;
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
});

test('availability target draft supports add edit and delete', () => {
  const draft = buildAvailabilityTargetDraft({
    gemini: {
      url: 'https://gemini.google.com/',
      enabled: true,
      allowed_hosts: ['gemini.google.com'],
      negative_phrases: ['not available']
    }
  });

  addAvailabilityTargetDraft(draft, 'tmailor');
  draft.targets[1].url = 'https://tmailor.example/';
  draft.targets[1].allowed_hosts = 'tmailor.example, mail.tmailor.example';
  draft.targets[1].negative_phrases = 'blocked\nunsupported';
  removeAvailabilityTargetDraft(draft, 0);

  assert.deepEqual(applyAvailabilityTargetDraft(draft), {
    tmailor: {
      url: 'https://tmailor.example/',
      enabled: true,
      allowed_hosts: ['tmailor.example', 'mail.tmailor.example'],
      negative_phrases: ['blocked', 'unsupported']
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
          url: 'https://gemini.google.com/',
          enabled: true,
          allowed_hosts: ['gemini.google.com'],
          negative_phrases: ['not available']
        }
      },
      speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
      deploy: { subscription_url: 'https://vpn.example/sub' }
    },
    settingsDrawer: {
      section: 'availability_targets',
      draft: buildAvailabilityTargetDraft({
        gemini: {
          url: 'https://gemini.google.com/',
          enabled: true,
          allowed_hosts: ['gemini.google.com'],
          negative_phrases: ['not available']
        }
      })
    }
  };
  const vm = buildViewModel(state, messages, 'zh-CN');
  const markup = buildPageMarkup('settings', vm, messages, 'zh-CN');

  assert.match(markup, /AI可达性检测/);
  assert.match(markup, /data-settings-card="availability_targets"/);
  assert.match(markup, /data-availability-action="add"/);
  assert.match(markup, /data-availability-key="allowed_hosts"/);
  assert.match(markup, /gemini\.google\.com/);
});
