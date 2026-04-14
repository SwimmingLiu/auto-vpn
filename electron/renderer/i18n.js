export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'];
export const LANGUAGE_STORAGE_KEY = 'vpn-automation-language';

const MESSAGES = {
  'zh-CN': {
    appTitle: 'VPN 订阅自动化',
    brandSubtitle: '单页桌面控制台',
    eyebrow: 'LOCAL DASHBOARD',
    heroTitle: '不必全屏，也能看全核心功能',
    heroBody: '首页聚焦抓包源、测速、部署、阶段状态和日志摘要；详细参数通过展开式抽屉查看。',
    languageLabel: '界面语言',
    saveButton: '保存配置',
    runButton: '运行全流程',
    metricsTitle: '运行总览',
    metricsSubtitle: '核心指标',
    stagesTitle: '阶段状态',
    stagesSubtitle: '即时反馈',
    logsTitle: '日志摘要',
    logsSubtitle: '最近运行输出',
    sourcesCardTitle: '抓包源',
    sourcesCardSubtitle: '5 组 URL / key',
    speedCardTitle: '测速配置',
    speedCardSubtitle: '阈值 / 并发 / 测速地址',
    deployCardTitle: '部署配置',
    deployCardSubtitle: 'Pages / 验证 / 订阅',
    expandButton: '展开配置',
    collapseButton: '收起',
    drawerClose: '关闭',
    drawerSave: '保存并关闭',
    drawerSourcesTitle: '抓包源详情',
    drawerSpeedTitle: '测速设置',
    drawerDeployTitle: '部署设置',
    enabledLabel: '启用',
    sourceUrlLabel: '抓包 URL',
    sourceKeyLabel: '密钥',
    minSpeedLabel: '最低下载速度 MB/s',
    timeoutLabel: '超时时间（秒）',
    concurrencyLabel: '并发数',
    speedUrlsLabel: '测速地址列表',
    projectNameLabel: 'Cloudflare Pages 项目名',
    pagesSecretLabel: 'Pages secret 端点',
    subscriptionUrlLabel: '最终订阅地址',
    logPlaceholder: '等待运行日志...',
    demoMode: '[演示] 当前以浏览器演示模式运行',
    profileSaved: '[界面] 配置已保存',
    pipelineStarted: '[界面] 流水线已启动',
    pipelineFinished: '[界面] 流水线结束，退出码：{code}',
    stageLabels: {
      doctor: '环境检查',
      extract: '节点抓取',
      dedupe: '节点去重',
      speedtest: '速度测试',
      postprocess: '节点后处理',
      render: '模板渲染',
      obfuscate: '混淆生成',
      deploy: 'Cloudflare 部署',
      verify: '结果校验'
    },
    statusLabels: {
      pending: '待执行',
      running: '进行中',
      success: '成功',
      failed: '失败'
    },
    summaryEnabledSources: '已启用 {count} / {total}',
    summarySpeed: '阈值 {speed} MB/s · 并发 {concurrency}',
    summaryDeploy: '项目 {project}',
    metricRawLinks: '原始节点',
    metricDedupedLinks: '去重后',
    metricSpeedLinks: '测速通过',
    metricVerifyStatus: '校验状态',
    idleValue: '空闲',
    readyValue: '待运行',
    verifiedValue: '已验证'
  },
  'en-US': {
    appTitle: 'VPN Subscription Automation',
    brandSubtitle: 'Single-page desktop console',
    eyebrow: 'LOCAL DASHBOARD',
    heroTitle: 'See every core function without going fullscreen',
    heroBody: 'The home dashboard focuses on sources, speed testing, deployment, stage state and compact logs. Full settings open in expandable drawers.',
    languageLabel: 'Language',
    saveButton: 'Save profile',
    runButton: 'Run full pipeline',
    metricsTitle: 'Run Overview',
    metricsSubtitle: 'Core metrics',
    stagesTitle: 'Stage Status',
    stagesSubtitle: 'Live progress',
    logsTitle: 'Log Summary',
    logsSubtitle: 'Recent output',
    sourcesCardTitle: 'Sources',
    sourcesCardSubtitle: '5 capture URLs / keys',
    speedCardTitle: 'Speed Test',
    speedCardSubtitle: 'Threshold / concurrency / URLs',
    deployCardTitle: 'Deploy',
    deployCardSubtitle: 'Pages / verify / subscription',
    expandButton: 'Expand settings',
    collapseButton: 'Collapse',
    drawerClose: 'Close',
    drawerSave: 'Save and close',
    drawerSourcesTitle: 'Source details',
    drawerSpeedTitle: 'Speed-test settings',
    drawerDeployTitle: 'Deploy settings',
    enabledLabel: 'Enabled',
    sourceUrlLabel: 'Capture URL',
    sourceKeyLabel: 'Key',
    minSpeedLabel: 'Min download MB/s',
    timeoutLabel: 'Timeout seconds',
    concurrencyLabel: 'Concurrency',
    speedUrlsLabel: 'Speed test URLs',
    projectNameLabel: 'Cloudflare Pages project',
    pagesSecretLabel: 'Pages secret endpoint',
    subscriptionUrlLabel: 'Final subscription URL',
    logPlaceholder: 'Waiting for runtime logs...',
    demoMode: '[demo] running without Electron bridge',
    profileSaved: '[ui] profile saved',
    pipelineStarted: '[ui] pipeline started',
    pipelineFinished: '[ui] pipeline finished with code {code}',
    stageLabels: {
      doctor: 'Doctor',
      extract: 'Extract',
      dedupe: 'Dedupe',
      speedtest: 'Speed Test',
      postprocess: 'Post-process',
      render: 'Render',
      obfuscate: 'Obfuscate',
      deploy: 'Deploy',
      verify: 'Verify'
    },
    statusLabels: {
      pending: 'Pending',
      running: 'Running',
      success: 'Success',
      failed: 'Failed'
    },
    summaryEnabledSources: '{count} / {total} enabled',
    summarySpeed: '{speed} MB/s threshold · {concurrency} workers',
    summaryDeploy: 'Project {project}',
    metricRawLinks: 'Raw nodes',
    metricDedupedLinks: 'Deduped',
    metricSpeedLinks: 'Speed passed',
    metricVerifyStatus: 'Verify status',
    idleValue: 'Idle',
    readyValue: 'Ready',
    verifiedValue: 'Verified'
  }
};

export function resolveLanguage(savedLanguage = '', systemLanguage = 'en-US') {
  if (SUPPORTED_LANGUAGES.includes(savedLanguage)) {
    return savedLanguage;
  }
  if (String(systemLanguage).toLowerCase().startsWith('zh')) {
    return 'zh-CN';
  }
  return 'en-US';
}

export function getMessages(language) {
  return MESSAGES[SUPPORTED_LANGUAGES.includes(language) ? language : 'en-US'];
}

export function formatMessage(template, params = {}) {
  return Object.entries(params).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template
  );
}
