export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'];
export const LANGUAGE_STORAGE_KEY = 'vpn-automation-language';

const MESSAGES = {
  'zh-CN': {
    locale: 'zh-CN',
    appTitle: 'VPN 订阅自动化部署工具',
    sidebarTitle: 'VPN Auto',
    sidebarVersion: 'v2.1.0',
    brandSubtitle: '自动抓取节点、测速筛选、节点处理、加密打包、Cloudflare Pages 部署，全流程自动化',
    languageLabel: '界面语言',
    saveButton: '保存配置',
    runButton: '立即运行',
    runButtonRunning: '运行中',
    runButtonStopping: '停止中',
    stopButton: '停止运行',
    projectButton: '项目目录',
    settingsButton: '配置页',
    shortcutActions: {
      config: '编辑配置',
      run: '运行流程',
      artifacts: '查看产物',
      logs: '查看日志'
    },
    pageTitles: {
      dashboard: '仪表盘总览',
      config: '配置管理',
      run: '运行任务',
      artifacts: '产物与订阅',
      logs: '日志中心',
      about: '关于'
    },
    pageSubtitles: {
      dashboard: '围绕真实能力展示配置、运行、日志与产物状态',
      config: '编辑抓包源、测速参数和部署参数，保存到实际 profile',
      run: '启动或停止流水线，查看阶段进度与实时日志',
      artifacts: '查看当前订阅地址与输出目录，不再展示伪造样本数据',
      logs: '浏览当前会话日志并导出日志文件',
      about: '查看版本、工作目录、打包说明与运行时路径'
    },
    nav: {
      dashboard: '仪表盘',
      config: '配置管理',
      run: '运行任务',
      artifacts: '产物与订阅',
      logs: '日志中心',
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
    emptyStates: {
      noRunData: '暂无运行数据',
      noArtifacts: '尚未生成订阅地址或产物文件',
      noLogs: '尚未采集日志',
      noSubscription: '尚未生成订阅地址'
    },
    readyValue: '待运行',
    verifiedValue: '已验证',
    idleValue: '空闲',
    demoMode: '[演示] 当前以浏览器演示模式运行',
    profileSaved: '[界面] 配置已保存',
    profileReset: '[界面] 已恢复到上次保存的配置',
    pipelineStarted: '[界面] 流水线已启动',
    pipelineStopping: '[界面] 已请求停止当前流水线',
    pipelineStopped: '[界面] 流水线已停止',
    pipelineFinished: '[界面] 流水线结束，退出码：{code}',
    pipelineFailed: '[界面] 流水线失败：{error}',
    stopUnavailable: '[界面] 当前没有可停止的运行任务',
    copiedMessage: '[界面] 已复制：{value}',
    openedPathMessage: '[界面] 已打开目录：{value}',
    exportedLogsMessage: '[界面] 日志已导出：{value}',
    exportLogsButton: '导出日志',
    openArtifactsButton: '打开输出目录',
    openLogsButton: '查看日志页',
    resetButton: '恢复到已保存配置',
    dashboardPrimaryEmptyHint: '还没有运行过流水线。先在配置页填写抓包源和部署参数，再从运行页启动。',
    dashboardMetricsTitle: '当前状态',
    configSourcesTitle: '抓包源配置',
    configSpeedTitle: '测速参数',
    configDeployTitle: '部署参数',
    aboutRuntimeTitle: '运行时路径',
    aboutRuntimeHint: '打包态会把 profile 保存到用户目录，开发态继续使用仓库 state。'
  },
  'en-US': {
    locale: 'en-US',
    appTitle: 'VPN Subscription Automation',
    sidebarTitle: 'VPN Auto',
    sidebarVersion: 'v2.1.0',
    brandSubtitle: 'Capture nodes, filter by speed, process payloads, package outputs, and deploy to Cloudflare Pages from one desktop tool.',
    languageLabel: 'Language',
    saveButton: 'Save profile',
    runButton: 'Run now',
    runButtonRunning: 'Running',
    runButtonStopping: 'Stopping',
    stopButton: 'Stop run',
    projectButton: 'Project folder',
    settingsButton: 'Config page',
    shortcutActions: {
      config: 'Edit config',
      run: 'Run pipeline',
      artifacts: 'View artifacts',
      logs: 'View logs'
    },
    pageTitles: {
      dashboard: 'Dashboard',
      config: 'Configuration',
      run: 'Run',
      artifacts: 'Artifacts',
      logs: 'Logs',
      about: 'About'
    },
    pageSubtitles: {
      dashboard: 'Show configuration, run state, logs, and artifacts around the real backend capabilities',
      config: 'Edit capture sources, speed settings, and deploy settings stored in the real profile',
      run: 'Start or stop the pipeline and inspect stage progress plus live logs',
      artifacts: 'Show the current subscription URL and output directory without fake sample data',
      logs: 'Browse the current session logs and export them to a file',
      about: 'Show version, workspace paths, packaging notes, and runtime paths'
    },
    nav: {
      dashboard: 'Dashboard',
      config: 'Config',
      run: 'Run',
      artifacts: 'Artifacts',
      logs: 'Logs',
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
    emptyStates: {
      noRunData: 'No run data yet',
      noArtifacts: 'No subscription URL or generated artifacts yet',
      noLogs: 'No logs collected yet',
      noSubscription: 'No subscription URL generated yet'
    },
    readyValue: 'Ready',
    verifiedValue: 'Verified',
    idleValue: 'Idle',
    demoMode: '[demo] running without Electron bridge',
    profileSaved: '[ui] profile saved',
    profileReset: '[ui] restored the last saved profile',
    pipelineStarted: '[ui] pipeline started',
    pipelineStopping: '[ui] stop requested for the current pipeline',
    pipelineStopped: '[ui] pipeline stopped',
    pipelineFinished: '[ui] pipeline finished with code {code}',
    pipelineFailed: '[ui] pipeline failed: {error}',
    stopUnavailable: '[ui] there is no active run to stop',
    copiedMessage: '[ui] copied: {value}',
    openedPathMessage: '[ui] opened folder: {value}',
    exportedLogsMessage: '[ui] exported logs: {value}',
    exportLogsButton: 'Export logs',
    openArtifactsButton: 'Open output folder',
    openLogsButton: 'Open logs page',
    resetButton: 'Restore saved profile',
    dashboardPrimaryEmptyHint: 'The pipeline has not been run yet. Fill the capture sources and deploy settings on the config page first.',
    dashboardMetricsTitle: 'Current status',
    configSourcesTitle: 'Capture sources',
    configSpeedTitle: 'Speed settings',
    configDeployTitle: 'Deploy settings',
    aboutRuntimeTitle: 'Runtime paths',
    aboutRuntimeHint: 'Packaged builds save the profile under the user directory while dev mode keeps using the repository state.'
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
