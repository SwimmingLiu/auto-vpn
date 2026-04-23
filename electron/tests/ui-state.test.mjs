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

test('buildStageModel marks stages in configured order', () => {
  const rows = buildStageModel({ doctor: 'success', availability: 'running', deploy: 'running' });
  assert.equal(rows[0].name, 'doctor');
  assert.equal(rows[0].status, 'success');
  assert.equal(rows[4].name, 'availability');
  assert.equal(rows[4].status, 'running');
  assert.equal(rows.at(-1).name, 'verify');
});

test('toMetricItems converts summary counts into cards', () => {
  const cards = toMetricItems({ raw_links: 12, postprocess_links: 5 });
  assert.deepEqual(cards[0], { label: 'RAW LINKS', value: '12' });
});

test('resolveVerifyMetricValue preserves running and failed verify states', () => {
  const zh = getMessages('zh-CN');

  assert.equal(resolveVerifyMetricValue('pending', zh), '待运行');
  assert.equal(resolveVerifyMetricValue('running', zh), '运行中');
  assert.equal(resolveVerifyMetricValue('failed', zh), '失败');
  assert.equal(resolveVerifyMetricValue('success', zh), '已验证');
});

test('runtime-aligned copy still exposes failed stage wording for sidebar summaries', () => {
  const zh = getMessages('zh-CN');
  assert.equal(zh.statusLabels.failed, '失败');
  assert.equal(zh.stageLabels.speedtest, '节点测速');
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

test('resolveLanguage prefers saved language over system locale', () => {
  assert.equal(resolveLanguage('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLanguage('', 'zh-TW'), 'zh-CN');
  assert.equal(resolveLanguage('', 'en-US'), 'en-US');
});

test('getMessages returns translated copy', () => {
  assert.equal(getMessages('zh-CN').runButton, '立即运行');
  assert.equal(getMessages('en-US').runButton, 'Run now');
});

test('PAGE_ORDER exposes only the runtime-aligned pages', () => {
  assert.equal(PAGE_ORDER.length, 6);
  assert.deepEqual(PAGE_ORDER.slice(0, 4), ['dashboard', 'config', 'run', 'artifacts']);
  assert.equal(PAGE_ORDER.at(-1), 'about');
});

test('getMessages exposes runtime-aligned copy instead of mockup-only pages', () => {
  const zh = getMessages('zh-CN');
  const en = getMessages('en-US');

  assert.equal(
    zh.brandSubtitle,
    '自动抓取节点、测速筛选、节点处理、加密打包、Cloudflare Pages 部署，全流程自动化'
  );
  assert.equal(zh.pageTitles.dashboard, '仪表盘总览');
  assert.equal(zh.pageTitles.config, '配置管理');
  assert.equal(zh.pageTitles.artifacts, '产物与订阅');
  assert.equal(zh.stopButton, '停止运行');
  assert.equal(zh.emptyStates.noRunData, '暂无运行数据');
  assert.equal(
    zh.pageSubtitles.dashboard,
    '围绕真实能力展示配置、运行、日志与产物状态'
  );
  assert.equal(
    en.brandSubtitle,
    'Capture nodes, filter by speed, process payloads, package outputs, and deploy to Cloudflare Pages from one desktop tool.'
  );
  assert.equal(en.pageTitles.dashboard, 'Dashboard');
  assert.equal(en.pageTitles.artifacts, 'Artifacts');
  assert.equal(en.runButton, 'Run now');
  assert.equal(en.stopButton, 'Stop run');
  assert.equal(en.emptyStates.noRunData, 'No run data yet');
  assert.equal(
    en.pageSubtitles.dashboard,
    'Show configuration, run state, logs, and artifacts around the real backend capabilities'
  );
  assert.equal(zh.nav.history, undefined);
  assert.equal(en.nav.monitor, undefined);
});
