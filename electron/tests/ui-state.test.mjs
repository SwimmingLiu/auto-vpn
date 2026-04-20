import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStageModel, toMetricItems } from '../renderer/state.js';
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

test('resolveLanguage prefers saved language over system locale', () => {
  assert.equal(resolveLanguage('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLanguage('', 'zh-TW'), 'zh-CN');
  assert.equal(resolveLanguage('', 'en-US'), 'en-US');
});

test('getMessages returns translated copy', () => {
  assert.equal(getMessages('zh-CN').runButton, '运行全流程');
  assert.equal(getMessages('en-US').runButton, 'Run full pipeline');
});

test('getMessages exposes compact dashboard copy without developer-facing hints', () => {
  const zh = getMessages('zh-CN');
  const en = getMessages('en-US');

  assert.equal(zh.brandSubtitle, '紧凑桌面控制台');
  assert.equal(zh.heroTitle, '紧凑查看节点抓取、测速、部署与运行状态');
  assert.equal(zh.speedCardSubtitle, '阈值 / 并发 / 多站点平均');
  assert.equal(zh.stageLabels.availability, '站点验证');
  assert.equal(
    zh.heroBody,
    '在一个控制台里维护抓包源、测速阈值和发布配置，并持续查看阶段进度与日志摘要。'
  );
  assert.equal(en.brandSubtitle, 'Compact desktop console');
  assert.equal(en.heroTitle, 'Track capture, speed tests, deployment and runtime health in one compact view');
  assert.equal(en.speedCardSubtitle, 'Threshold / concurrency / multi-source average');
  assert.equal(en.stageLabels.availability, 'Availability');
  assert.equal(
    en.heroBody,
    'Maintain sources, thresholds and publish settings in one console while keeping stage progress and log summaries visible.'
  );
  assert.doesNotMatch(zh.heroBody, /全屏|抽屉/);
  assert.doesNotMatch(en.heroBody, /fullscreen|drawer/i);
});
