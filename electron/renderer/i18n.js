export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'];
export const LANGUAGE_STORAGE_KEY = 'vpn-automation-language';

const MESSAGES = {
  'zh-CN': {
    locale: 'zh-CN',
    appTitle: 'VPN 订阅自动化部署工具',
    sidebarTitle: 'VPN Auto',
    sidebarVersion: 'v2.0.0',
    brandSubtitle: '自动抓取节点、测速筛选、节点处理、加密打包、Cloudflare Pages 部署，全流程自动化',
    languageLabel: '界面语言',
    saveButton: '保存配置',
    runButton: '立即运行',
    runButtonRunning: '运行中',
    runButtonStopping: '停止中',
    stopButton: '停止运行',
    projectButton: '项目地址',
    settingsButton: '设置',
    shortcutActions: {
      capture: '自动抓取节点',
      speed: '去重测速',
      package: '加密打包',
      deploy: '一键部署'
    },
    pageTitles: {
      dashboard: '仪表盘总览',
      config: '配置管理',
      runs: '运行任务',
      history: '任务历史',
      nodes: '节点管理',
      subscriptions: '订阅地址',
      logs: '日志中心',
      deploy: '部署设置',
      monitor: '系统监控',
      settings: '设置',
      about: '关于'
    },
    pageSubtitles: {
      dashboard: '统一查看节点抓取、测速、部署与实时日志的桌面工作台',
      config: '集中维护抓包 API、测速策略、节点处理规则、加密打包与 Cloudflare Pages 配置',
      runs: '执行 VPN 节点抓取、测速筛选、节点处理、加密打包与自动部署任务',
      history: '查看自动化部署任务的历史记录、执行结果、节点统计与部署详情',
      nodes: '管理和维护 VPN 节点列表，支持筛选、状态监控和批量操作',
      subscriptions: '管理和分发多个订阅链接，支持二维码、导入、复制和统计',
      logs: '统一检索运行日志、部署日志、系统日志和错误日志',
      deploy: '维护 Cloudflare Pages / GitHub Actions 的部署平台、分支、环境与发布记录',
      monitor: '跟踪 CPU、内存、磁盘、网络流量与资源告警',
      settings: '管理语言、主题、通知、日志与性能相关偏好',
      about: '查看产品说明、系统架构、更新日志与致谢信息'
    },
    nav: {
      dashboard: '仪表盘',
      config: '配置管理',
      runs: '运行任务',
      history: '任务历史',
      nodes: '节点管理',
      subscriptions: '订阅地址',
      logs: '日志中心',
      deploy: '部署设置',
      monitor: '系统监控',
      settings: '设置',
      about: '关于'
    },
    currentTaskLabel: '当前任务',
    runModeLabel: '运行模式',
    logLinesLabel: '日志行数',
    lastResultLabel: '最新结果',
    lastUpdateLabel: '最后更新',
    manualRunMode: '本地优先',
    demoRunMode: '演示模式',
    taskWaiting: '等待开始',
    notAvailableValue: '—',
    sidebarStatusTitle: '系统状态',
    runStateLabels: {
      idle: '待运行',
      running: '运行中',
      stopping: '停止中'
    },
    runResultLabels: {
      idle: '未开始',
      running: '执行中',
      success: '已完成',
      failed: '失败',
      stopped: '已停止',
      demo: '演示完成'
    },
    stageLabels: {
      doctor: '环境检查',
      extract: '提取节点',
      dedupe: '节点去重',
      speedtest: '节点测速',
      availability: '站点验证',
      postprocess: '节点处理',
      render: '模板渲染',
      obfuscate: '加密处理',
      deploy: '打包部署',
      verify: '结果校验'
    },
    statusLabels: {
      pending: '待执行',
      running: '运行中',
      success: '成功',
      failed: '失败'
    },
    readyValue: '待运行',
    verifiedValue: '已验证',
    idleValue: '空闲',
    demoMode: '[演示] 当前以浏览器演示模式运行',
    profileSaved: '[界面] 配置已保存',
    pipelineStarted: '[界面] 流水线已启动',
    pipelineStopping: '[界面] 已请求停止当前流水线',
    pipelineStopped: '[界面] 流水线已停止',
    pipelineFinished: '[界面] 流水线结束，退出码：{code}',
    pipelineFailed: '[界面] 流水线失败：{error}',
    stopUnavailable: '[界面] 当前没有可停止的运行任务',
    copiedMessage: '[界面] 已复制：{value}'
  },
  'en-US': {
    locale: 'en-US',
    appTitle: 'VPN Subscription Automation',
    sidebarTitle: 'VPN Auto',
    sidebarVersion: 'v2.0.0',
    brandSubtitle: 'Capture nodes, filter by speed, process payloads, package outputs, and deploy to Cloudflare Pages from one desktop tool.',
    languageLabel: 'Language',
    saveButton: 'Save profile',
    runButton: 'Run now',
    runButtonRunning: 'Running',
    runButtonStopping: 'Stopping',
    stopButton: 'Stop run',
    projectButton: 'Project URL',
    settingsButton: 'Settings',
    shortcutActions: {
      capture: 'Auto capture',
      speed: 'Dedupe & speed',
      package: 'Encrypt package',
      deploy: 'One-click deploy'
    },
    pageTitles: {
      dashboard: 'Dashboard',
      config: 'Configuration Center',
      runs: 'Run Tasks',
      history: 'Task History',
      nodes: 'Node Manager',
      subscriptions: 'Subscriptions',
      logs: 'Log Center',
      deploy: 'Deployment Settings',
      monitor: 'System Monitor',
      settings: 'Settings',
      about: 'About'
    },
    pageSubtitles: {
      dashboard: 'A unified workspace for capture, filtering, deployment, and live runtime logs',
      config: 'Manage capture APIs, speed policies, node rules, packaging, and Cloudflare Pages settings',
      runs: 'Execute node capture, speed filtering, packaging, and deployment tasks from one operator screen',
      history: 'Inspect historical runs, execution results, node metrics, and deployment details',
      nodes: 'Browse VPN nodes with filters, health status, and bulk actions',
      subscriptions: 'Manage subscription links, QR sharing, copy actions, and health metrics',
      logs: 'Search runtime, deployment, system, and error logs in one place',
      deploy: 'Manage deployment platform, branch, environment, and release history',
      monitor: 'Track CPU, memory, disk, network, and alert summaries',
      settings: 'Manage language, theme, notifications, logs, and performance preferences',
      about: 'Product overview, architecture, changelog, and acknowledgements'
    },
    nav: {
      dashboard: 'Dashboard',
      config: 'Config',
      runs: 'Runs',
      history: 'History',
      nodes: 'Nodes',
      subscriptions: 'Subscriptions',
      logs: 'Logs',
      deploy: 'Deploy',
      monitor: 'Monitor',
      settings: 'Settings',
      about: 'About'
    },
    currentTaskLabel: 'Current task',
    runModeLabel: 'Run mode',
    logLinesLabel: 'Log lines',
    lastResultLabel: 'Latest result',
    lastUpdateLabel: 'Last update',
    manualRunMode: 'Local first',
    demoRunMode: 'Demo mode',
    taskWaiting: 'Waiting to start',
    notAvailableValue: '—',
    sidebarStatusTitle: 'System Status',
    runStateLabels: {
      idle: 'Idle',
      running: 'Running',
      stopping: 'Stopping'
    },
    runResultLabels: {
      idle: 'Not started',
      running: 'In progress',
      success: 'Completed',
      failed: 'Failed',
      stopped: 'Stopped',
      demo: 'Demo complete'
    },
    stageLabels: {
      doctor: 'Doctor',
      extract: 'Extract',
      dedupe: 'Dedupe',
      speedtest: 'Speed Test',
      availability: 'Availability',
      postprocess: 'Post-process',
      render: 'Render',
      obfuscate: 'Encrypt',
      deploy: 'Deploy',
      verify: 'Verify'
    },
    statusLabels: {
      pending: 'Pending',
      running: 'Running',
      success: 'Success',
      failed: 'Failed'
    },
    readyValue: 'Ready',
    verifiedValue: 'Verified',
    idleValue: 'Idle',
    demoMode: '[demo] running without Electron bridge',
    profileSaved: '[ui] profile saved',
    pipelineStarted: '[ui] pipeline started',
    pipelineStopping: '[ui] stop requested for the current pipeline',
    pipelineStopped: '[ui] pipeline stopped',
    pipelineFinished: '[ui] pipeline finished with code {code}',
    pipelineFailed: '[ui] pipeline failed: {error}',
    stopUnavailable: '[ui] there is no active run to stop',
    copiedMessage: '[ui] copied: {value}'
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
