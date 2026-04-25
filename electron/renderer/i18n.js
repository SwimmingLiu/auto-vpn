export const SUPPORTED_LANGUAGES = ['zh-CN'];
export const LANGUAGE_STORAGE_KEY = 'vpn-automation-language';

const ZH_MESSAGES = {
  locale: 'zh-CN',
  appTitle: 'VPN 订阅自动化部署工具',
  sidebarTitle: 'VPN Auto',
  sidebarVersion: 'v2.1.0',
  brandSubtitle: '概览、运行、结果、订阅、日志、设置统一管理',
  languageLabel: '',
  saveButton: '保存配置',
  runButton: '立即运行',
  runButtonRunning: '运行中',
  runButtonStopping: '停止中',
  stopButton: '停止运行',
  projectButton: '项目地址',
  settingsButton: '设置',
  shortcutActions: {
    run: '开始运行',
    settings: '设置统一管理',
    results: '查看结果',
    logs: '打开日志'
  },
  pageTitles: {
    dashboard: '概览',
    runs: '运行',
    results: '结果',
    subscriptions: '订阅',
    logs: '日志',
    settings: '设置'
  },
  pageSubtitles: {
    dashboard: '只展示运行状态、系统状态摘要、核心指标和最近结果',
    runs: '执行流水线、查看阶段进度和当前阶段详情',
    results: '查看 pipeline 后最终留下的节点和区域统计',
    subscriptions: '生成和分发 Clash、Clash Meta、Sing-box、Surge 订阅',
    logs: '查看实时日志流、错误高亮和日志操作',
    settings: '以分组卡片和右侧抽屉统一管理数据源和测速配置'
  },
  nav: {
    dashboard: '概览',
    runs: '运行',
    results: '结果',
    subscriptions: '订阅',
    logs: '日志',
    settings: '设置'
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
  copiedMessage: '[界面] 已复制：{value}',
  openFailed: '[界面] 打开失败：{error}'
};

export function resolveLanguage() {
  return 'zh-CN';
}

export function getMessages() {
  return ZH_MESSAGES;
}

export function formatMessage(template, params = {}) {
  return Object.entries(params).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template
  );
}
