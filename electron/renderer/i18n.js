export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'];
export const LANGUAGE_STORAGE_KEY = 'vpn-automation-language';

const MESSAGES = {
  'zh-CN': {
    appTitle: 'VPN 订阅自动化',
    brandSubtitle: 'Electron 本地控制台',
    navOverview: '总览',
    navSources: '抓包源',
    navSpeedTest: '测速',
    navDeploy: '部署',
    navHistory: '历史',
    sidebarPillPages: 'Cloudflare Pages',
    sidebarPillPipeline: 'Xray 流水线',
    eyebrow: 'VPN SUBSCRIPTION AUTOMATION',
    heroTitle: '本地桌面化控制你的节点抓取、测速与 Cloudflare 发布',
    heroBody: '以更柔和的浅色暖调界面统一管理抓包 URL、测速阈值、阶段状态、Cloudflare 部署和最终订阅校验。',
    saveButton: '保存配置',
    runButton: '运行全流程',
    languageLabel: '界面语言',
    sourceMatrixTitle: '抓包源矩阵',
    sourceMatrixSubtitle: '抓包 URL 与密钥',
    pipelineTitle: '流水线设置',
    pipelineSubtitle: '测速、部署、校验',
    metricsTitle: '运行指标',
    metricsSubtitle: '实时摘要',
    stagesTitle: '阶段时间线',
    stagesSubtitle: '执行状态',
    logsTitle: '运行日志',
    logsSubtitle: 'stdout / stderr / 事件',
    sourceUrl: '抓包 URL',
    sourceKey: '密钥',
    minSpeed: '最低下载速度 MB/s',
    timeoutSeconds: '超时时间（秒）',
    concurrency: '并发数',
    projectName: 'Cloudflare Pages 项目名',
    pagesProjectUrl: 'Pages secret 端点',
    subscriptionUrl: '最终订阅地址',
    speedUrls: '测速地址列表',
    statusIdle: '空闲',
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
    metricFallbackLabel: '状态',
    metricFallbackValue: '空闲',
    sourceEnabled: '启用',
    profileSaved: '[界面] 配置已保存',
    pipelineStarted: '[界面] 流水线已启动',
    pipelineFinished: '[界面] 流水线结束，退出码：{code}',
    demoMode: '[演示] 当前以浏览器演示模式运行'
  },
  'en-US': {
    appTitle: 'VPN Subscription Automation',
    brandSubtitle: 'Electron Local Console',
    navOverview: 'Overview',
    navSources: 'Sources',
    navSpeedTest: 'Speed Test',
    navDeploy: 'Deploy',
    navHistory: 'History',
    sidebarPillPages: 'Cloudflare Pages',
    sidebarPillPipeline: 'Xray Pipeline',
    eyebrow: 'VPN SUBSCRIPTION AUTOMATION',
    heroTitle: 'Control extraction, speed testing and Cloudflare publishing from a local desktop console',
    heroBody: 'A softer light interface for capture URLs, thresholds, stage progress, Cloudflare deployment and final subscription verification.',
    saveButton: 'Save profile',
    runButton: 'Run full pipeline',
    languageLabel: 'Language',
    sourceMatrixTitle: 'Source Matrix',
    sourceMatrixSubtitle: 'Capture URLs and keys',
    pipelineTitle: 'Pipeline Settings',
    pipelineSubtitle: 'Speed test, deploy and verification',
    metricsTitle: 'Live Metrics',
    metricsSubtitle: 'Runtime summary',
    stagesTitle: 'Stage Timeline',
    stagesSubtitle: 'Execution status',
    logsTitle: 'Runtime Log',
    logsSubtitle: 'stdout / stderr / events',
    sourceUrl: 'Capture URL',
    sourceKey: 'Key',
    minSpeed: 'Min download MB/s',
    timeoutSeconds: 'Timeout seconds',
    concurrency: 'Concurrency',
    projectName: 'Cloudflare Pages project',
    pagesProjectUrl: 'Pages secret endpoint',
    subscriptionUrl: 'Final subscription URL',
    speedUrls: 'Speed test URLs',
    statusIdle: 'Idle',
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
    metricFallbackLabel: 'STATUS',
    metricFallbackValue: 'Idle',
    sourceEnabled: 'Enabled',
    profileSaved: '[ui] profile saved',
    pipelineStarted: '[ui] pipeline started',
    pipelineFinished: '[ui] pipeline finished with code {code}',
    demoMode: '[demo] running without Electron bridge'
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
