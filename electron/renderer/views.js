import { buildStageModel, PAGE_INDEX, PAGE_ORDER } from './state.js';

const FALLBACK_PROFILE = {
  sources: {
    leiting: {
      url: 'https://capture-1.vpn.example/api/v1/client/subscribe',
      key: 'lt-demo-key',
      enabled: true
    },
    heidong: {
      url: 'https://capture-2.vpn.example/api/v1/client/nodes',
      key: 'hd-demo-key',
      enabled: true
    },
    mifeng: {
      url: 'https://capture-3.vpn.example/api/v1/client/subscribe',
      key: 'mf-demo-key',
      enabled: true
    },
    xuanfeng1: {
      url: 'https://capture-4.vpn.example/api/v1/client/subscribe',
      key: 'xf1-demo-key',
      enabled: true
    },
    xuanfeng2: {
      url: 'https://capture-5.vpn.example/api/v1/client/subscribe',
      key: 'xf2-demo-key',
      enabled: false
    }
  },
  speed_test: {
    min_download_mb_s: 1.0,
    timeout_seconds: 20,
    concurrency: 3,
    urls: [
      'https://speed-1.vpn.example/1mb.dat',
      'https://speed-2.vpn.example/1mb.dat',
      'https://speed-3.vpn.example/1mb.dat'
    ]
  },
  deploy: {
    project_name: 'vpn-auto',
    pages_project_url: 'https://vpn-auto.pages.dev',
    subscription_url: 'https://vpn.example.top/179ba8dd-3854-4747-b853-fc1868ef3937'
  }
};

const NAV_ICONS = {
  dashboard: 'DB',
  config: 'CF',
  runs: 'RN',
  history: 'HS',
  nodes: 'ND',
  subscriptions: 'SB',
  logs: 'LG',
  deploy: 'DP',
  monitor: 'MT',
  settings: 'ST',
  about: 'AB'
};

const CONFIG_TABS = [
  ['sources', '抓包 API 配置', 'Capture APIs'],
  ['speed', '测速配置', 'Speed settings'],
  ['rules', '节点处理规则', 'Node rules'],
  ['package', '加密策略', 'Packaging'],
  ['paths', '本地路径设置', 'Local paths'],
  ['pages', 'Cloudflare Pages 配置', 'Pages config']
];

const LOG_TABS = [
  ['runtime', '运行日志', 'Runtime'],
  ['deploy', '部署日志', 'Deploy'],
  ['system', '系统日志', 'System'],
  ['error', '错误日志', 'Errors']
];

const DEPLOY_TABS = [
  ['platform', '部署平台', 'Platform'],
  ['actions', 'GitHub Actions', 'GitHub Actions'],
  ['advanced', '高级选项', 'Advanced']
];

const SETTINGS_TABS = [
  ['general', '通用设置', 'General'],
  ['appearance', '界面设置', 'Appearance'],
  ['mail', '邮件配置', 'Mail'],
  ['logs', '日志设置', 'Logs'],
  ['notifications', '通知设置', 'Notifications'],
  ['about', '关于设置', 'About']
];

export function buildViewModel(state, messages, language) {
  const profile = state.profile ?? FALLBACK_PROFILE;
  const counts = {
    raw_links: state.counts.raw_links ?? 1268,
    postprocess_links: state.counts.postprocess_links ?? 862,
    speedtest_links: state.counts.speedtest_links ?? 256,
    availability_links: state.counts.availability_links ?? 256
  };
  const subscriptionUrl = profile.deploy.subscription_url || FALLBACK_PROFILE.deploy.subscription_url;
  const displayLogs = state.logEntries.length ? state.logEntries : demoLogs(language);
  const historyRows = buildHistoryRows(subscriptionUrl, counts, language);
  const nodeRows = buildNodeRows(language);
  const logRows = buildLogRows(displayLogs, language);
  const stageRows = normalizeStageRows(state.stageStatus, state.runState);
  const overviewSteps = buildOverviewSteps(stageRows, language);
  const subscriptionCards = buildSubscriptionCards(subscriptionUrl, language);

  return {
    profile,
    counts,
    displayLogs,
    historyRows,
    nodeRows,
    logRows,
    stageRows,
    overviewSteps,
    subscriptionCards,
    lastUpdated: formatDate(state.lastUpdateAt, language) || pick(language, '2024-05-30 15:30:45', '2024-05-30 15:30:45'),
    runDuration: state.runState === 'running' ? '00:12:34' : '00:10:20',
    runProgress: state.runState === 'running' ? 62 : 100,
    outputFiles: buildOutputFiles(language),
    systemStats: buildSystemStats(language),
    alerts: buildAlerts(language),
    processRows: buildProcessRows(language),
    updateLog: buildUpdateLog(language),
    architectureBlocks: buildArchitectureBlocks(language),
    statusItems: buildStatusItems(state, messages, language),
    taskStateItems: buildTaskStateItems(state, counts, language),
    metrics: buildDashboardMetrics(counts, language),
    distribution: buildDistribution(language),
    deployRecords: buildDeployRecords(language),
    shortcuts: buildShortcutDescriptors(messages),
    filterOptions: {
      region: ['全部', '美国', '新加坡', '日本', '中国香港', '德国'],
      protocol: ['全部', 'VLESS', 'VMESS', 'Trojan'],
      availability: ['全部', '在线', '降级'],
      mode: ['全部', pick(language, '本地优先', 'Local first'), pick(language, 'GitHub Actions 备用', 'GitHub backup')]
    }
  };
}

export function buildSidebarNav(messages, activePage) {
  return PAGE_ORDER.map((page) => `
    <button
      id="${navId(page)}"
      class="nav-item ${activePage === page ? 'active' : ''}"
      data-page-target="${page}"
      type="button"
    >
      <span class="nav-icon">${NAV_ICONS[page]}</span>
      <span class="nav-copy">${escapeHtml(messages.nav[page])}</span>
    </button>
  `).join('');
}

export function buildShortcutStrip(messages) {
  const actions = buildShortcutDescriptors(messages);
  return actions.map((action) => `
    <button
      id="${action.id}"
      class="shortcut-action"
      data-shortcut-target="${action.page}"
      data-shortcut-tab="${action.tab ?? ''}"
      type="button"
    >
      <span class="shortcut-accent ${action.tone}"></span>
      <span>${escapeHtml(action.label)}</span>
    </button>
  `).join('');
}

export function buildSidebarStatus(viewModel, messages, state, language) {
  return `
    ${viewModel.statusItems.map((item) => `
      <div class="status-row">
        <span class="status-row-label">${escapeHtml(item.label)}</span>
        <strong class="status-row-value">${escapeHtml(item.value)}</strong>
      </div>
    `).join('')}
    <div class="status-divider"></div>
    <div class="status-footnote">
      <span>${escapeHtml(messages.currentTaskLabel)}</span>
      <strong>${escapeHtml(resolveCurrentTaskLabel(state, messages))}</strong>
    </div>
  `;
}

export function buildPageMarkup(activePage, viewModel, messages, language, subtabs = {}) {
  const title = messages.pageTitles[activePage];
  const subtitle = messages.pageSubtitles[activePage];

  return `
    <section class="page-shell" data-page-shell="${activePage}">
      <header class="page-header-card">
        <span class="page-index-badge">${PAGE_INDEX[activePage]}</span>
        <div class="page-header-copy">
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(subtitle)}</p>
        </div>
      </header>
      ${buildPageInner(activePage, viewModel, messages, language, subtabs)}
    </section>
  `;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildPageInner(activePage, viewModel, messages, language, subtabs) {
  switch (activePage) {
    case 'dashboard':
      return buildDashboardPage(viewModel, messages, language);
    case 'config':
      return buildConfigPage(viewModel, messages, language, subtabs.config ?? 'sources');
    case 'runs':
      return buildRunsPage(viewModel, messages, language);
    case 'history':
      return buildHistoryPage(viewModel, messages, language);
    case 'nodes':
      return buildNodesPage(viewModel, messages, language);
    case 'subscriptions':
      return buildSubscriptionsPage(viewModel, messages, language);
    case 'logs':
      return buildLogsPage(viewModel, messages, language, subtabs.logs ?? 'runtime');
    case 'deploy':
      return buildDeployPage(viewModel, messages, language, subtabs.deploy ?? 'platform');
    case 'monitor':
      return buildMonitorPage(viewModel, messages, language);
    case 'settings':
      return buildSettingsPage(viewModel, messages, language, subtabs.settings ?? 'general');
    default:
      return buildAboutPage(viewModel, messages, language);
  }
}

function buildDashboardPage(vm, messages, language) {
  return `
    <div id="dashboardOverview" class="page-grid dashboard-grid">
      <article class="panel flow-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '流程总览', 'Pipeline overview'))}</h3>
          ${renderBadge(messages.runStateLabels.idle, 'success')}
        </div>
        <div class="flow-steps">
          ${vm.overviewSteps.map((step, index) => `
            <div class="flow-step">
              <div class="flow-icon ${step.status}">${index + 1}</div>
              <div class="flow-name">${escapeHtml(step.title)}</div>
              <div class="flow-detail">${escapeHtml(step.detail)}</div>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '任务状态', 'Task state'))}</h3>
          ${renderBadge(messages.runStateLabels.idle, 'success')}
        </div>
        <div class="key-value-list">
          ${vm.taskStateItems.map((item) => `
            <div class="key-value-row">
              <span>${escapeHtml(item.label)}</span>
              <strong>${escapeHtml(item.value)}</strong>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '核心配置', 'Core configuration'))}</h3>
          <span class="panel-subcopy">${escapeHtml(pick(language, '抓包、测速与部署输入', 'Capture, speed, and deploy inputs'))}</span>
        </div>
        <div class="compact-form-grid">
          ${Object.entries(vm.profile.sources).slice(0, 5).map(([name, source]) => `
            <label class="field compact">
              <span>${escapeHtml(name.toUpperCase())}</span>
              <input value="${escapeHtml(source.url)}" readonly />
            </label>
          `).join('')}
          <div class="inline-metrics">
            <div class="mini-stat">
              <span>${escapeHtml(pick(language, '测速阈值', 'Speed threshold'))}</span>
              <strong>${escapeHtml(`${vm.profile.speed_test.min_download_mb_s} MB/s`)}</strong>
            </div>
            <div class="mini-stat">
              <span>${escapeHtml(pick(language, '并发线程数', 'Workers'))}</span>
              <strong>${escapeHtml(String(vm.profile.speed_test.concurrency))}</strong>
            </div>
          </div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '运行统计', 'Run metrics'))}</h3>
          <span class="panel-subcopy">${escapeHtml(pick(language, '原始节点、筛选结果与订阅概览', 'Raw nodes, filtered nodes, and subscription summary'))}</span>
        </div>
        <div class="metric-grid">
          ${vm.metrics.map((metric) => `
            <div class="metric-card ${metric.tone}">
              <span>${escapeHtml(metric.label)}</span>
              <strong>${escapeHtml(metric.value)}</strong>
              <small>${escapeHtml(metric.detail)}</small>
            </div>
          `).join('')}
        </div>
        <div class="subscription-inline">
          <div>
            <span class="panel-subcopy">${escapeHtml(pick(language, '主订阅地址', 'Primary subscription'))}</span>
            <strong class="mono">${escapeHtml(vm.subscriptionCards[0].url)}</strong>
          </div>
          <button class="btn btn-primary small" data-copy-text="${escapeHtml(vm.subscriptionCards[0].url)}" type="button">
            ${escapeHtml(pick(language, '复制全部', 'Copy all'))}
          </button>
        </div>
      </article>

      <article class="panel terminal-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '实时日志', 'Live logs'))}</h3>
          <button class="btn btn-secondary small" type="button" data-page-target="logs">${escapeHtml(pick(language, '查看更多', 'View more'))}</button>
        </div>
        <div class="log-stack">
          ${vm.displayLogs.slice(-10).map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
        </div>
      </article>

      <article class="panel action-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '快捷操作', 'Quick actions'))}</h3>
        </div>
        <div class="action-grid">
          <button class="btn btn-primary ghost-fill" data-page-target="runs" type="button">${escapeHtml(pick(language, '立即运行一次', 'Run once'))}</button>
          <button class="btn btn-secondary" data-page-target="history" type="button">${escapeHtml(pick(language, '查看历史任务', 'Open history'))}</button>
          <button class="btn btn-danger" type="button">${escapeHtml(pick(language, '停止任务', 'Stop task'))}</button>
          <button class="btn btn-secondary" data-page-target="deploy" type="button">${escapeHtml(pick(language, '打开输出目录', 'Open output'))}</button>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '节点分布（TOP 10 国家/地区）', 'Node distribution (top 10 regions)'))}</h3>
        </div>
        <div class="country-grid">
          ${vm.distribution.map((item) => `
            <div class="country-card">
              <strong>${escapeHtml(item.code)}</strong>
              <span>${escapeHtml(item.value)}</span>
              <small>${escapeHtml(item.share)}</small>
            </div>
          `).join('')}
        </div>
      </article>
    </div>
  `;
}

function buildConfigPage(vm, messages, language, activeTab) {
  const sources = Object.entries(vm.profile.sources);
  const primary = sources[0][1];

  return `
    <div class="page-grid config-grid">
      <article class="panel wide-panel">
        ${renderSubtabs('config', CONFIG_TABS, activeTab, language)}
        <div class="form-grid two-columns">
          <div class="form-column">
            <h3>${escapeHtml(pick(language, '抓包 API 配置', 'Capture API configuration'))}</h3>
            ${sources.map(([name, source], index) => `
              <label class="field">
                <span>${escapeHtml(index === 0 ? pick(language, '主抓包 API URL（必填）', 'Primary capture API URL') : `${pick(language, '备用 API URL', 'Backup API URL')} ${index}`)}</span>
                <input
                  ${index === 0 ? 'id="configPrimarySource"' : ''}
                  data-source="${escapeHtml(name)}"
                  data-key="url"
                  value="${escapeHtml(source.url)}"
                />
              </label>
            `).join('')}

            <div class="notice-card">
              <strong>${escapeHtml(pick(language, '配置说明', 'Configuration note'))}</strong>
              <p>${escapeHtml(pick(language, '以上 API 地址用于自动获取订阅链接与节点列表，系统按顺序尝试这些地址，失败时自动切换到下一个可用地址。', 'These API endpoints are used to fetch subscriptions and nodes automatically. The system retries them in order and falls back when one fails.'))}</p>
            </div>

            <div class="page-actions">
              <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '恢复默认', 'Reset'))}</button>
              <button class="btn btn-primary" type="button">${escapeHtml(pick(language, '保存并应用', 'Save and apply'))}</button>
            </div>
          </div>

          <div class="form-column">
            <div class="panel inset-panel">
              <h3>${escapeHtml(pick(language, '请求设置', 'Request settings'))}</h3>
              <div class="field-grid">
                ${renderBoundField(pick(language, '请求超时时间', 'Request timeout'), 'number', vm.profile.speed_test.timeout_seconds + 10, 'request-timeout')}
                ${renderBoundField(pick(language, '重试次数', 'Retry count'), 'number', 3, 'request-retry')}
                ${renderBoundField(pick(language, '请求间隔', 'Retry interval'), 'number', 2, 'request-interval')}
              </div>
              ${renderStaticToggle(pick(language, '启用 SSL 验证', 'Enable SSL verification'), true)}
              ${renderStaticToggle(pick(language, '自动重试失败请求', 'Retry failed requests'), true)}
            </div>

            <div class="panel inset-panel">
              <h3>${escapeHtml(pick(language, '测试结果', 'Connection result'))}</h3>
              <div class="result-summary">
                <div>
                  <strong>${escapeHtml(primary.enabled ? pick(language, '连接成功', 'Connected') : pick(language, '已禁用', 'Disabled'))}</strong>
                  <span>${escapeHtml(pick(language, '返回节点：1,268', 'Returned nodes: 1,268'))}</span>
                </div>
                <div class="sparkline-wrap">${renderSparkline([20, 18, 19, 21, 20, 24, 22, 26, 23, 25, 21, 24], '#57c87a')}</div>
              </div>
            </div>

            <div class="panel inset-panel">
              <h3>${escapeHtml(pick(language, '配置说明', 'Why this page matters'))}</h3>
              <ul class="bullet-list">
                <li>${escapeHtml(pick(language, '主抓包 API 用于自动获取订阅链接，是抓取数据的主要数据源。', 'The primary capture API is the main source for generated subscriptions.'))}</li>
                <li>${escapeHtml(pick(language, '系统按顺序尝试这些 API 地址，主地址失败后自动切换到备用地址。', 'The app retries endpoints in order and falls back automatically.'))}</li>
                <li>${escapeHtml(pick(language, '所有配置仅保存在本地，不会上传任何服务器。', 'All configuration stays local and is never uploaded externally.'))}</li>
              </ul>
            </div>
          </div>
        </div>
      </article>
    </div>
  `;
}

function buildRunsPage(vm, messages, language) {
  return `
    <div class="page-grid runs-grid">
      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '当前运行任务', 'Current run'))}</h3>
          ${renderBadge(pick(language, '执行中', 'Running'), 'accent')}
        </div>
        <div class="run-hero">
          <div class="run-icon">RN</div>
          <div>
            <strong>${escapeHtml(pick(language, '全流程自动化部署', 'Full pipeline deployment'))}</strong>
            <div class="run-meta">${escapeHtml(`#20240520-151811 · ${pick(language, '本地优先 / GitHub Actions 备用', 'Local first / GitHub backup')}`)}</div>
          </div>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${vm.runProgress}%"></div></div>
        <div class="timeline">
          ${vm.overviewSteps.map((step, index) => `
            <div class="timeline-row">
              <span class="timeline-index ${step.status}">${index + 1}</span>
              <span class="timeline-copy">${escapeHtml(step.title)}</span>
              ${renderBadge(step.status === 'success' ? pick(language, '已完成', 'Done') : step.status === 'running' ? pick(language, '进行中', 'Running') : pick(language, '等待中', 'Queued'), step.status === 'success' ? 'success' : step.status === 'running' ? 'warning' : 'neutral')}
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel terminal-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '实时执行日志', 'Realtime execution log'))}</h3>
        </div>
        <pre id="runsLogOutput" class="terminal-output">${escapeHtml(vm.displayLogs.join('\n'))}</pre>
        <div class="action-grid four">
          <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '暂停', 'Pause'))}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '继续', 'Resume'))}</button>
          <button class="btn btn-danger" type="button">${escapeHtml(pick(language, '终止', 'Terminate'))}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '打开完整日志', 'Open full log'))}</button>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '执行控制', 'Execution control'))}</h3>
        </div>
        <div class="radio-stack">
          <label class="radio-row"><input type="radio" checked />${escapeHtml(pick(language, '本地优先（推荐）', 'Local first (recommended)'))}</label>
          <label class="radio-row"><input type="radio" />${escapeHtml(pick(language, 'GitHub Actions 备用', 'GitHub Actions backup'))}</label>
        </div>
        ${renderStaticToggle(pick(language, '完成后自动部署', 'Deploy when finished'), true)}
        ${renderStaticToggle(pick(language, '部署成功后通知', 'Notify on success'), true)}
        ${renderStaticToggle(pick(language, '失败时自动重试', 'Retry on failure'), true)}
        ${renderStaticToggle(pick(language, '仅在节点变更时部署', 'Deploy only on changes'), false)}
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '任务统计', 'Task statistics'))}</h3>
        </div>
        <div class="metric-grid compact">
          ${vm.metrics.slice(0, 4).map((metric) => `
            <div class="metric-card ${metric.tone}">
              <span>${escapeHtml(metric.label)}</span>
              <strong>${escapeHtml(metric.value)}</strong>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel wide-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '输出文件', 'Output files'))}</h3>
        </div>
        <div class="file-list">
          ${vm.outputFiles.map((file) => `
            <div class="file-row">
              <span class="file-name">${escapeHtml(file.name)}</span>
              <span class="file-state ${file.stateClass}">${escapeHtml(file.state)}</span>
              <small>${escapeHtml(file.time)}</small>
            </div>
          `).join('')}
        </div>
      </article>
    </div>
  `;
}

function buildHistoryPage(vm, messages, language) {
  return `
    <div class="page-grid history-grid">
      <article class="panel wide-panel">
        <div class="toolbar-row">
          <input class="toolbar-input" value="${escapeHtml(pick(language, '2024-05-13 → 2024-05-20', '2024-05-13 → 2024-05-20'))}" readonly />
          <select><option>${escapeHtml(pick(language, '全部', 'All'))}</option></select>
          <select><option>${escapeHtml(pick(language, '全部', 'All'))}</option></select>
          <input class="toolbar-input" value="${escapeHtml(pick(language, '搜索任务编号、订阅地址或备注', 'Search task id, URL, or notes'))}" readonly />
          <button class="btn btn-secondary small" type="button">${escapeHtml(pick(language, '导出', 'Export'))}</button>
        </div>
        <div class="metric-grid">
          <div class="metric-card accent"><span>${escapeHtml(pick(language, '总任务数', 'Total runs'))}</span><strong>32</strong><small>${escapeHtml(pick(language, '个任务', 'runs'))}</small></div>
          <div class="metric-card success"><span>${escapeHtml(pick(language, '成功率', 'Success rate'))}</span><strong>87.5%</strong><small>${escapeHtml(pick(language, '28 成功 / 4 失败', '28 success / 4 failed'))}</small></div>
          <div class="metric-card warning"><span>${escapeHtml(pick(language, '平均耗时', 'Average duration'))}</span><strong>10m 24s</strong><small>${escapeHtml(pick(language, '平均执行时间', 'Average execution time'))}</small></div>
          <div class="metric-card accent"><span>${escapeHtml(pick(language, '平均下载速度', 'Average download'))}</span><strong>7.68 MB/s</strong><small>${escapeHtml(pick(language, '全局平均速度', 'Global average'))}</small></div>
        </div>
      </article>

      <article class="panel wide-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '任务列表', 'Task list'))}</h3>
        </div>
        <div id="historyTable" class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>${escapeHtml(pick(language, '任务编号', 'Task ID'))}</th>
                <th>${escapeHtml(pick(language, '开始时间', 'Started'))}</th>
                <th>${escapeHtml(pick(language, '执行模式', 'Mode'))}</th>
                <th>${escapeHtml(pick(language, '状态', 'Status'))}</th>
                <th>${escapeHtml(pick(language, '节点数', 'Nodes'))}</th>
                <th>${escapeHtml(pick(language, '平均速度', 'Avg speed'))}</th>
                <th>${escapeHtml(pick(language, '部署结果', 'Deployment'))}</th>
              </tr>
            </thead>
            <tbody>
              ${vm.historyRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.id)}</td>
                  <td>${escapeHtml(row.started)}</td>
                  <td>${escapeHtml(row.mode)}</td>
                  <td><span class="inline-state ${row.statusClass}">${escapeHtml(row.status)}</span></td>
                  <td>${escapeHtml(row.nodes)}</td>
                  <td>${escapeHtml(row.speed)}</td>
                  <td>${escapeHtml(row.deploy)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '任务详情', 'Task details'))}</h3>
          ${renderBadge(pick(language, '成功', 'Success'), 'success')}
        </div>
        <div class="key-value-list">
          ${[
            [pick(language, '状态', 'Status'), pick(language, '成功', 'Success')],
            [pick(language, '执行模式', 'Mode'), pick(language, '本地优先', 'Local first')],
            [pick(language, '开始时间', 'Started'), '2024-05-20 15:18:11'],
            [pick(language, '结束时间', 'Finished'), '2024-05-20 15:28:31'],
            [pick(language, '节点总数', 'Nodes'), '1,268'],
            [pick(language, '可用节点', 'Available'), '256'],
            [pick(language, '平均速度', 'Avg speed'), '8.72 MB/s']
          ].map(([label, value]) => `
            <div class="key-value-row">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '最近 7 次任务节点数', 'Recent node counts'))}</h3>
        </div>
        <div class="chart-bars">
          ${[1268, 1104, 1268, 856, 1052, 980, 1231].map((value) => `
            <div class="bar-card">
              <div class="bar-fill" style="height:${Math.round(value / 14)}px"></div>
              <strong>${escapeHtml(String(value))}</strong>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '最近任务平均速度趋势', 'Recent speed trend'))}</h3>
        </div>
        <div class="sparkline-large">${renderSparkline([8.72, 7.25, 6.8, 5.13, 7.01, 6.35, 7.88], '#5b5ce2')}</div>
      </article>
    </div>
  `;
}

function buildNodesPage(vm, messages, language) {
  const selected = vm.nodeRows[1];

  return `
    <div class="page-grid nodes-grid">
      <article class="panel wide-panel">
        <div class="toolbar-row">
          <input class="toolbar-input" value="${escapeHtml(pick(language, '搜索节点名称、地址或备注...', 'Search node name, address, or notes...'))}" readonly />
          <select><option>${escapeHtml(pick(language, '全部', 'All'))}</option></select>
          <select><option>${escapeHtml(pick(language, '全部', 'All'))}</option></select>
          <select><option>${escapeHtml(pick(language, '全部', 'All'))}</option></select>
          <button class="btn btn-secondary small" type="button">${escapeHtml(pick(language, '刷新', 'Refresh'))}</button>
        </div>
        <div id="nodeTable" class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>${escapeHtml(pick(language, '节点名称', 'Node'))}</th>
                <th>${escapeHtml(pick(language, '延迟', 'Latency'))}</th>
                <th>${escapeHtml(pick(language, '协议', 'Protocol'))}</th>
                <th>${escapeHtml(pick(language, '地区', 'Region'))}</th>
                <th>${escapeHtml(pick(language, '可用性', 'Availability'))}</th>
                <th>${escapeHtml(pick(language, '下载速度', 'Download'))}</th>
                <th>${escapeHtml(pick(language, '线路', 'Route'))}</th>
              </tr>
            </thead>
            <tbody>
              ${vm.nodeRows.map((row) => `
                <tr class="${row.selected ? 'selected-row' : ''}">
                  <td>${escapeHtml(row.name)}</td>
                  <td>${escapeHtml(row.latency)}</td>
                  <td>${escapeHtml(row.protocol)}</td>
                  <td>${escapeHtml(row.region)}</td>
                  <td>${escapeHtml(row.availability)}</td>
                  <td>${escapeHtml(row.speed)}</td>
                  <td>${escapeHtml(row.route)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '节点详情', 'Node details'))}</h3>
        </div>
        <div class="key-value-list">
          ${[
            [pick(language, '节点地址', 'Host'), selected.name],
            [pick(language, '协议', 'Protocol'), selected.protocol],
            [pick(language, '地区', 'Region'), selected.region],
            [pick(language, '状态', 'Status'), pick(language, '在线', 'Online')],
            [pick(language, '延迟', 'Latency'), selected.latency],
            [pick(language, '下载速度', 'Download'), selected.speed],
            [pick(language, '运营商', 'Provider'), 'StarHub'],
            [pick(language, 'IP 地址', 'IP address'), '203.116.50.23']
          ].map(([label, value]) => `
            <div class="key-value-row">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>
        <div class="page-actions stacked">
          <button class="btn btn-primary" type="button">${escapeHtml(pick(language, '应用到订阅', 'Apply to subscription'))}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '保存配置', 'Save selection'))}</button>
        </div>
      </article>
    </div>
  `;
}

function buildSubscriptionsPage(vm, messages, language) {
  return `
    <div class="page-grid subscriptions-grid">
      <article class="panel wide-panel">
        <div id="subscriptionCards" class="subscription-card-list">
          ${vm.subscriptionCards.map((card) => `
            <div class="subscription-card">
              <div>
                <strong>${escapeHtml(card.title)}</strong>
                <div class="mono">${escapeHtml(card.url)}</div>
              </div>
              <div class="subscription-actions">
                ${renderBadge(card.state, card.stateClass)}
                <button class="icon-btn" data-copy-text="${escapeHtml(card.url)}" type="button">CP</button>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" type="button">${escapeHtml(pick(language, '刷新订阅地址', 'Refresh subscriptions'))}</button>
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="qr-block">${renderQrPlaceholder()}</div>
        <div class="key-value-list">
          ${[
            [pick(language, '创建时间', 'Created'), '2024-05-30 15:10:11'],
            [pick(language, '最后更新时间', 'Updated'), vm.lastUpdated],
            [pick(language, '节点总数', 'Nodes'), String(vm.counts.postprocess_links)],
            [pick(language, '平均延迟', 'Avg latency'), '32 ms'],
            [pick(language, '平均下载速度', 'Avg speed'), '87.2 Mbps'],
            [pick(language, '平均可用率', 'Availability'), '99.6%']
          ].map(([label, value]) => `
            <div class="key-value-row">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '使用说明', 'Usage'))}</h3>
        </div>
        <ol class="number-list">
          <li>${escapeHtml(pick(language, '复制任意订阅链接并导入对应客户端。', 'Copy any subscription link into your target client.'))}</li>
          <li>${escapeHtml(pick(language, '定期刷新订阅以获取最新节点和测速结果。', 'Refresh the subscription regularly to pull the latest nodes and speed results.'))}</li>
          <li>${escapeHtml(pick(language, '若客户端不兼容，可切换其他格式地址。', 'Switch to another format when a client needs a different profile type.'))}</li>
        </ol>
        <div class="action-grid">
          <button class="btn btn-secondary" data-copy-text="${escapeHtml(vm.subscriptionCards[0].url)}" type="button">${escapeHtml(pick(language, '复制链接', 'Copy link'))}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '二维码分享', 'QR share'))}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '打开订阅', 'Open URL'))}</button>
        </div>
      </article>
    </div>
  `;
}

function buildLogsPage(vm, messages, language, activeTab) {
  return `
    <div class="page-grid logs-grid">
      <article class="panel wide-panel">
        ${renderSubtabs('logs', LOG_TABS, activeTab, language)}
        <div class="toolbar-row">
          <input class="toolbar-input" value="${escapeHtml(pick(language, '2024-06-30 → 2024-06-30', '2024-06-30 → 2024-06-30'))}" readonly />
          <select><option>${escapeHtml(pick(language, '全部', 'All'))}</option></select>
          <select><option>${escapeHtml(pick(language, '全部', 'All'))}</option></select>
          <input class="toolbar-input" value="${escapeHtml(pick(language, '搜索日志内容、任务或来源', 'Search log content, task, or source'))}" readonly />
          <button class="btn btn-primary small" type="button">${escapeHtml(pick(language, '查询', 'Query'))}</button>
        </div>
        <div class="metric-grid">
          <div class="metric-card accent"><span>${escapeHtml(pick(language, '今日新增日志', 'New logs today'))}</span><strong>1,248</strong><small>${escapeHtml(pick(language, '较昨日 18.6% ↑', '+18.6% vs yesterday'))}</small></div>
          <div class="metric-card danger"><span>${escapeHtml(pick(language, '错误日志', 'Errors'))}</span><strong>13</strong><small>${escapeHtml(pick(language, '较昨日 -7.1% ↓', '-7.1% vs yesterday'))}</small></div>
          <div class="metric-card warning"><span>${escapeHtml(pick(language, '警告日志', 'Warnings'))}</span><strong>28</strong><small>${escapeHtml(pick(language, '较昨日 +27.3% ↑', '+27.3% vs yesterday'))}</small></div>
          <div class="metric-card success"><span>${escapeHtml(pick(language, '成功任务', 'Successful tasks'))}</span><strong>1,206</strong><small>${escapeHtml(pick(language, '较昨日 +22.8% ↑', '+22.8% vs yesterday'))}</small></div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '最近告警', 'Recent alerts'))}</h3>
        </div>
        <div class="alert-list">
          ${vm.alerts.map((alert) => `
            <div class="alert-row ${alert.tone}">
              <strong>${escapeHtml(alert.level)}</strong>
              <span>${escapeHtml(alert.title)}</span>
              <small>${escapeHtml(alert.time)}</small>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel wide-panel">
        <div id="logCenterTable" class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>${escapeHtml(pick(language, '时间', 'Time'))}</th>
                <th>${escapeHtml(pick(language, '级别', 'Level'))}</th>
                <th>${escapeHtml(pick(language, '模块', 'Module'))}</th>
                <th>${escapeHtml(pick(language, '任务', 'Task'))}</th>
                <th>${escapeHtml(pick(language, '详情摘要', 'Summary'))}</th>
                <th>${escapeHtml(pick(language, '状态', 'State'))}</th>
                <th>${escapeHtml(pick(language, '来源', 'Source'))}</th>
              </tr>
            </thead>
            <tbody>
              ${vm.logRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.time)}</td>
                  <td><span class="inline-state ${row.levelClass}">${escapeHtml(row.level)}</span></td>
                  <td>${escapeHtml(row.module)}</td>
                  <td>${escapeHtml(row.task)}</td>
                  <td>${escapeHtml(row.summary)}</td>
                  <td>${escapeHtml(row.state)}</td>
                  <td>${escapeHtml(row.source)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '日志详情', 'Log details'))}</h3>
        </div>
        <div class="key-value-list">
          ${[
            [pick(language, '时间', 'Time'), '2024-06-30 15:30:45'],
            [pick(language, '级别', 'Level'), 'INFO'],
            [pick(language, '模块', 'Module'), pick(language, '部署', 'Deploy')],
            [pick(language, '任务', 'Task'), 'Cloudflare Pages'],
            [pick(language, '状态', 'Status'), pick(language, '成功', 'Success')],
            [pick(language, '来源', 'Source'), 'pages-api']
          ].map(([label, value]) => `
            <div class="key-value-row">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>
        <pre class="json-block">{
  "event": "deployment.completed",
  "environment": "production",
  "duration": 18.2,
  "status": "success"
}</pre>
      </article>
    </div>
  `;
}

function buildDeployPage(vm, messages, language, activeTab) {
  return `
    <div class="page-grid deploy-grid">
      <article class="panel wide-panel" id="deployPlatformCard">
        ${renderSubtabs('deploy', DEPLOY_TABS, activeTab, language)}
        <div class="form-grid two-columns">
          <div class="form-column">
            <h3>${escapeHtml(pick(language, '部署平台', 'Deployment platform'))}</h3>
            ${renderBoundField(pick(language, '选择平台', 'Platform'), 'text', 'Cloudflare Pages', 'deploy-platform')}
            ${renderBoundField(pick(language, 'Cloudflare 账户', 'Cloudflare account'), 'text', 'swimmingliu@example.com', 'deploy-account')}
            ${renderBoundField(pick(language, '项目名称', 'Project name'), 'text', vm.profile.deploy.project_name, 'deploy-project')}
            ${renderBoundField(pick(language, '构建命令', 'Build command'), 'text', 'npm run build', 'deploy-build')}
            ${renderBoundField(pick(language, '构建输出目录', 'Output directory'), 'text', 'dist', 'deploy-output')}
            ${renderStaticToggle(pick(language, '自动部署', 'Auto deploy'), true)}
          </div>
          <div class="form-column">
            <h3>${escapeHtml(pick(language, '部署配置', 'Deployment configuration'))}</h3>
            ${renderBoundField(pick(language, '部署分支', 'Branch'), 'text', 'main', 'deploy-branch')}
            ${renderBoundField(pick(language, '构建环境', 'Environment'), 'text', pick(language, '生产环境', 'Production'), 'deploy-env')}
            ${renderBoundField(pick(language, '部署区域', 'Region'), 'text', pick(language, '自动（最近区域）', 'Auto (closest region)'), 'deploy-region')}
            ${renderBoundField(pick(language, '部署超时', 'Timeout'), 'number', 10, 'deploy-timeout')}
            <div class="action-grid">
              <button class="btn btn-primary" type="button">${escapeHtml(pick(language, '立即部署', 'Deploy now'))}</button>
              <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '清除缓存', 'Clear cache'))}</button>
              <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '上传部署', 'Upload build'))}</button>
            </div>
            <div class="table-wrap compact-table">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>${escapeHtml(pick(language, '状态', 'Status'))}</th>
                    <th>${escapeHtml(pick(language, '时间', 'Time'))}</th>
                    <th>${escapeHtml(pick(language, '版本', 'Version'))}</th>
                    <th>${escapeHtml(pick(language, '部署信息', 'Details'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${vm.deployRecords.map((row) => `
                    <tr>
                      <td>${escapeHtml(row.status)}</td>
                      <td>${escapeHtml(row.time)}</td>
                      <td>${escapeHtml(row.version)}</td>
                      <td>${escapeHtml(row.detail)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </article>
    </div>
  `;
}

function buildMonitorPage(vm, messages, language) {
  return `
    <div class="page-grid monitor-grid">
      ${vm.systemStats.map((stat, index) => `
        <article id="${index === 0 ? 'monitorCpuCard' : ''}" class="panel stat-panel">
          <div class="panel-headline">
            <h3>${escapeHtml(stat.title)}</h3>
          </div>
          <strong class="stat-value">${escapeHtml(stat.value)}</strong>
          <span class="panel-subcopy">${escapeHtml(stat.detail)}</span>
          <div class="sparkline-wrap">${renderSparkline(stat.points, stat.color)}</div>
        </article>
      `).join('')}

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '告警统计', 'Alert statistics'))}</h3>
        </div>
        <div class="metric-grid compact">
          <div class="metric-card danger"><span>${escapeHtml(pick(language, '紧急告警', 'Critical'))}</span><strong>0</strong></div>
          <div class="metric-card warning"><span>${escapeHtml(pick(language, '重要告警', 'Important'))}</span><strong>0</strong></div>
          <div class="metric-card accent"><span>${escapeHtml(pick(language, '一般告警', 'General'))}</span><strong>5</strong></div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '资源排行（TOP 5）', 'Top resources'))}</h3>
        </div>
        <div class="table-wrap compact-table">
          <table class="data-table">
            <thead>
              <tr>
                <th>${escapeHtml(pick(language, '进程名称', 'Process'))}</th>
                <th>CPU</th>
                <th>${escapeHtml(pick(language, '内存', 'Memory'))}</th>
                <th>${escapeHtml(pick(language, '网络', 'Network'))}</th>
              </tr>
            </thead>
            <tbody>
              ${vm.processRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.name)}</td>
                  <td>${escapeHtml(row.cpu)}</td>
                  <td>${escapeHtml(row.memory)}</td>
                  <td>${escapeHtml(row.network)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '系统信息', 'System info'))}</h3>
        </div>
        <div class="key-value-list">
          ${[
            ['OS', 'Ubuntu 22.04.4 LTS'],
            ['Kernel', '5.15.0-101-generic'],
            ['CPU', '4 vCPU'],
            [pick(language, '内存', 'Memory'), '16 GB'],
            [pick(language, '磁盘', 'Disk'), '192 GB'],
            [pick(language, '负载平均', 'Load avg'), '0.45, 0.32, 0.28']
          ].map(([label, value]) => `
            <div class="key-value-row">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>
      </article>
    </div>
  `;
}

function buildSettingsPage(vm, messages, language, activeTab) {
  return `
    <div class="page-grid settings-grid">
      <article class="panel wide-panel">
        ${renderSubtabs('settings', SETTINGS_TABS, activeTab, language)}
        <div class="form-grid two-columns">
          <div class="form-column">
            <label class="field">
              <span>${escapeHtml(pick(language, '语言', 'Language'))}</span>
              <select id="settingsLanguage">
                <option value="zh-CN"${language === 'zh-CN' ? ' selected' : ''}>${escapeHtml(pick(language, '简体中文', 'Simplified Chinese'))}</option>
                <option value="en-US"${language === 'en-US' ? ' selected' : ''}>English</option>
              </select>
            </label>
            ${renderBoundField(pick(language, '主题', 'Theme'), 'text', pick(language, '浅色（跟随系统）', 'Light (system)'), 'settings-theme')}
            ${renderBoundField(pick(language, '时区', 'Timezone'), 'text', 'Asia/Shanghai', 'settings-timezone')}
            ${renderBoundField(pick(language, '默认首页', 'Default page'), 'text', messages.pageTitles.dashboard, 'settings-home')}
            ${renderBoundField(pick(language, '日志保留天数', 'Log retention'), 'text', pick(language, '30 天', '30 days'), 'settings-retention')}
            ${renderStaticToggle(pick(language, '自动保存配置', 'Auto-save configuration'), true)}
            ${renderStaticToggle(pick(language, '启用启动自检', 'Run startup checks'), true)}
            ${renderStaticToggle(pick(language, '启用异常告警', 'Enable anomaly alerts'), true)}
          </div>
          <div class="form-column">
            ${renderBoundField(pick(language, 'API 请求超时', 'API timeout'), 'number', 30, 'settings-api-timeout')}
            ${renderBoundField(pick(language, '最大并发任务', 'Max concurrent tasks'), 'number', 5, 'settings-max-task')}
            ${renderBoundField(pick(language, '自动刷新间隔', 'Refresh interval'), 'text', pick(language, '10 秒', '10 seconds'), 'settings-refresh')}
            ${renderBoundField(pick(language, '节点测速线程数', 'Speed-test threads'), 'number', 8, 'settings-threads')}
            ${renderBoundField(pick(language, '订阅同步策略', 'Sync strategy'), 'text', pick(language, '智能模式', 'Smart mode'), 'settings-sync')}
            ${renderStaticToggle(pick(language, '启用调试模式', 'Enable debug mode'), false)}
            ${renderStaticToggle(pick(language, '允许匿名统计', 'Allow anonymous analytics'), false)}
            ${renderStaticToggle(pick(language, '配置变更审计', 'Audit configuration changes'), true)}
          </div>
        </div>
        <div class="page-actions">
          <button class="btn btn-secondary" type="button">${escapeHtml(pick(language, '恢复默认', 'Reset'))}</button>
          <button class="btn btn-primary" type="button">${escapeHtml(pick(language, '保存设置', 'Save settings'))}</button>
        </div>
      </article>
    </div>
  `;
}

function buildAboutPage(vm, messages, language) {
  return `
    <div class="page-grid about-grid">
      <article class="panel">
        <div class="about-logo">VA</div>
        <h3>${escapeHtml(messages.sidebarTitle)}</h3>
        <p class="panel-subcopy">${escapeHtml(pick(language, 'Cloudflare VPN 订阅自动化部署工具', 'Cloudflare VPN subscription automation desktop tool'))}</p>
        <div class="key-value-list">
          ${[
            [pick(language, '项目官网', 'Project'), 'https://github.com/example/vpn-auto'],
            [pick(language, '使用文档', 'Docs'), 'https://docs.example.com/vpn-auto'],
            [pick(language, '问题反馈', 'Issues'), 'https://github.com/example/vpn-auto/issues'],
            [pick(language, '联系邮箱', 'Support'), 'support@example.com']
          ].map(([label, value]) => `
            <div class="key-value-row">
              <span>${escapeHtml(label)}</span>
              <strong class="mono">${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel wide-panel" id="aboutArchitecture">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '系统架构', 'Architecture'))}</h3>
        </div>
        <div class="architecture-diagram">
          ${vm.architectureBlocks.map((row) => `
            <div class="architecture-row">
              ${row.map((block) => `
                <div class="architecture-block">
                  <strong>${escapeHtml(block.title)}</strong>
                  <span>${escapeHtml(block.detail)}</span>
                </div>
              `).join('')}
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '更新日志', 'Release notes'))}</h3>
        </div>
        <div class="release-list">
          ${vm.updateLog.map((release) => `
            <div class="release-card">
              <strong>${escapeHtml(release.version)}</strong>
              <span>${escapeHtml(release.date)}</span>
              <ul class="bullet-list">
                ${release.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
              </ul>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '致谢', 'Thanks'))}</h3>
        </div>
        <ul class="bullet-list">
          ${[
            'Cloudflare Pages',
            'Cloudflare Workers',
            'Electron',
            'Node.js',
            'Playwright'
          ].map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </article>
    </div>
  `;
}

function renderSubtabs(group, tabs, activeTab, language) {
  return `
    <div class="subtab-row">
      ${tabs.map(([value, zhLabel, enLabel]) => `
        <button
          class="subtab ${activeTab === value ? 'active' : ''}"
          data-subtab-page="${group}"
          data-subtab="${value}"
          type="button"
        >
          ${escapeHtml(pick(language, zhLabel, enLabel))}
        </button>
      `).join('')}
    </div>
  `;
}

function renderBoundField(label, type, value, id) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input id="${id}" type="${type}" value="${escapeHtml(value)}" readonly />
    </label>
  `;
}

function renderStaticToggle(label, checked) {
  return `
    <label class="toggle-row">
      <span>${escapeHtml(label)}</span>
      <span class="toggle-pill ${checked ? 'checked' : ''}">
        <span class="toggle-knob"></span>
      </span>
    </label>
  `;
}

function renderBadge(text, tone) {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function renderSparkline(points, color) {
  const width = 220;
  const height = 72;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = width / Math.max(points.length - 1, 1);
  const coordinates = points.map((point, index) => {
    const x = index * step;
    const y = height - ((point - min) / range) * (height - 10) - 5;
    return `${x},${y.toFixed(2)}`;
  }).join(' ');
  const area = `0,${height} ${coordinates} ${width},${height}`;

  return `
    <svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <polygon points="${area}" fill="${color}18"></polygon>
      <polyline points="${coordinates}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"></polyline>
    </svg>
  `;
}

function renderQrPlaceholder() {
  const cells = Array.from({ length: 81 }, (_, index) => ((index * 7 + 3) % 5 === 0 ? 1 : 0));
  return `
    <div class="qr-grid">
      ${cells.map((cell) => `<span class="qr-cell ${cell ? 'filled' : ''}"></span>`).join('')}
    </div>
  `;
}

function buildShortcutDescriptors(messages) {
  return [
    { id: 'shortcutCapture', page: 'config', tab: 'sources', label: messages.shortcutActions.capture, tone: 'accent' },
    { id: 'shortcutSpeed', page: 'config', tab: 'speed', label: messages.shortcutActions.speed, tone: 'warning' },
    { id: 'shortcutPackage', page: 'runs', label: messages.shortcutActions.package, tone: 'accent' },
    { id: 'shortcutDeploy', page: 'deploy', label: messages.shortcutActions.deploy, tone: 'success' }
  ];
}

function normalizeStageRows(stageStatus, runState) {
  const actual = Object.keys(stageStatus ?? {}).length ? stageStatus : sampleStageStatus(runState);
  return buildStageModel(actual);
}

function buildOverviewSteps(stageRows, language) {
  const mapping = [
    ['doctor', pick(language, '抓包配置', 'Setup'), pick(language, '获取 API 配置', 'Capture API settings')],
    ['extract', pick(language, '提取节点', 'Extract'), pick(language, '运行提取脚本', 'Fetch nodes')],
    ['speedtest', pick(language, '节点测速', 'Speed test'), pick(language, '去重 & 速度测试', 'Dedupe and speed tests')],
    ['postprocess', pick(language, '节点处理', 'Post-process'), pick(language, 'IP 归属地 & Emoji', 'GeoIP and metadata')],
    ['obfuscate', pick(language, '加密处理', 'Encrypt'), pick(language, '本地 / Actions 加密', 'Encrypt outputs')],
    ['deploy', pick(language, '打包部署', 'Deploy'), pick(language, 'Cloudflare Pages', 'Cloudflare Pages')],
    ['verify', pick(language, '验证完成', 'Verify'), pick(language, '订阅可用', 'Subscription verified')]
  ];

  return mapping.map(([stage, title, detail]) => ({
    title,
    detail,
    status: stageRows.find((row) => row.name === stage)?.status ?? 'pending'
  }));
}

function buildStatusItems(state, messages, language) {
  return [
    { label: pick(language, '状态', 'State'), value: messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle },
    { label: pick(language, '模式', 'Mode'), value: state.isDemo ? messages.demoRunMode : messages.manualRunMode },
    { label: pick(language, 'Cloudflare API', 'Cloudflare API'), value: pick(language, '已连接', 'Connected') },
    { label: pick(language, '最后更新', 'Last update'), value: formatDate(state.lastUpdateAt, language) || pick(language, '2024-05-30 15:30:45', '2024-05-30 15:30:45') }
  ];
}

function buildTaskStateItems(state, counts, language) {
  return [
    [pick(language, '当前任务', 'Task'), pick(language, '全流程自动化运行', 'Full pipeline automation')],
    [pick(language, '开始时间', 'Started'), '2024-05-20 15:18:11'],
    [pick(language, '已运行时间', 'Elapsed'), '00:12:34'],
    [pick(language, '下一次运行', 'Next run'), '2024-05-20 16:00:00'],
    [pick(language, '运行模式', 'Mode'), pick(language, '定时任务（每小时）', 'Scheduled (hourly)')],
    [pick(language, '部署目标', 'Deployment'), 'Cloudflare Pages'],
    [pick(language, '节点统计', 'Nodes'), `${counts.raw_links} / ${counts.postprocess_links}`]
  ].map(([label, value]) => ({ label, value }));
}

function buildDashboardMetrics(counts, language) {
  return [
    { label: pick(language, '抓取节点总数', 'Captured nodes'), value: String(counts.raw_links), detail: pick(language, '较上次 +12.5%', '+12.5% vs last run'), tone: 'accent' },
    { label: pick(language, '去重后节点数', 'After dedupe'), value: String(counts.postprocess_links), detail: pick(language, '较上次 +8.2%', '+8.2% vs last run'), tone: 'success' },
    { label: pick(language, '测速通过节点', 'Speed passed'), value: String(counts.speedtest_links), detail: pick(language, '较上次 +15.3%', '+15.3% vs last run'), tone: 'accent' },
    { label: pick(language, '当前可用节点', 'Available now'), value: String(counts.availability_links), detail: pick(language, '三站验证通过', 'Passed availability checks'), tone: 'success' },
    { label: pick(language, '平均下载速度', 'Average download'), value: '8.72 MB/s', detail: pick(language, 'Cloudflare Speedtest', 'Cloudflare Speedtest'), tone: 'warning' },
    { label: pick(language, '最后成功部署', 'Last successful deploy'), value: '2024-05-20 15:28:31', detail: pick(language, 'Cloudflare Pages', 'Cloudflare Pages'), tone: 'accent' }
  ];
}

function buildDistribution(language) {
  return [
    ['US', '68', '26.6%'],
    ['JP', '42', '16.4%'],
    ['SG', '28', '10.9%'],
    ['GB', '22', '8.6%'],
    ['DE', '18', '7.0%'],
    ['FR', '16', '6.3%'],
    ['CA', '14', '5.5%'],
    ['AU', '12', '4.7%'],
    ['NL', '8', '3.1%'],
    ['KR', '8', '3.1%']
  ].map(([code, value, share]) => ({ code, value, share }));
}

function buildHistoryRows(subscriptionUrl, counts, language) {
  const shortUrl = subscriptionUrl.replace(/^https?:\/\//, '').slice(-10);
  return [
    ['#20240520151811', '05-20 15:18', pick(language, '本地优先', 'Local first'), pick(language, '成功', 'Success'), 'success', String(counts.raw_links), '8.72 MB/s', `Cloudflare Pages / …${shortUrl}`],
    ['#20240520140005', '05-20 14:00', pick(language, '本地优先', 'Local first'), pick(language, '成功', 'Success'), 'success', '1,104', '7.25 MB/s', 'Cloudflare Pages'],
    ['#20240520100002', '05-20 10:00', pick(language, 'GitHub Actions 备用', 'GitHub backup'), pick(language, '成功', 'Success'), 'success', '1,268', '6.80 MB/s', 'Cloudflare Pages'],
    ['#20240520060003', '05-20 06:00', pick(language, '本地优先', 'Local first'), pick(language, '失败', 'Failed'), 'danger', '856', '5.13 MB/s', pick(language, '部署失败', 'Deploy failed')],
    ['#20240519220004', '05-19 22:00', pick(language, '本地优先', 'Local first'), pick(language, '成功', 'Success'), 'success', '1,052', '7.01 MB/s', 'Cloudflare Pages'],
    ['#20240519180005', '05-19 18:00', pick(language, 'GitHub Actions 备用', 'GitHub backup'), pick(language, '成功', 'Success'), 'success', '980', '6.35 MB/s', 'Cloudflare Pages'],
    ['#20240519140006', '05-19 14:00', pick(language, '本地优先', 'Local first'), pick(language, '成功', 'Success'), 'success', '1,231', '7.88 MB/s', 'Cloudflare Pages']
  ].map(([id, started, mode, status, statusClass, nodes, speed, deploy]) => ({
    id,
    started,
    mode,
    status,
    statusClass,
    nodes,
    speed,
    deploy
  }));
}

function buildNodeRows(language) {
  return [
    ['us.example.com', '18 ms', 'VLESS', pick(language, '美国', 'US'), '100%', '158.4 Mbps', pick(language, '线路 A', 'Route A'), false],
    ['sg.example.com', '32 ms', 'VLESS', pick(language, '新加坡', 'Singapore'), '100%', '92.1 Mbps', pick(language, '线路 A', 'Route A'), true],
    ['jp.example.com', '45 ms', 'VLESS', pick(language, '日本', 'Japan'), '100%', '76.8 Mbps', pick(language, '线路 B', 'Route B'), false],
    ['hk.example.com', '28 ms', 'VLESS', pick(language, '中国香港', 'Hong Kong'), '100%', '134.7 Mbps', pick(language, '线路 A', 'Route A'), false],
    ['de.example.com', '86 ms', 'VLESS', pick(language, '德国', 'Germany'), '99%', '64.3 Mbps', pick(language, '线路 C', 'Route C'), false],
    ['uk.example.com', '72 ms', 'VLESS', pick(language, '英国', 'UK'), '100%', '58.9 Mbps', pick(language, '线路 C', 'Route C'), false],
    ['fr.example.com', '94 ms', 'VLESS', pick(language, '法国', 'France'), '98%', '42.6 Mbps', pick(language, '线路 D', 'Route D'), false],
    ['au.example.com', '61 ms', 'VLESS', pick(language, '澳大利亚', 'Australia'), '100%', '68.2 Mbps', pick(language, '线路 B', 'Route B'), false]
  ].map(([name, latency, protocol, region, availability, speed, route, selected]) => ({
    name,
    latency,
    protocol,
    region,
    availability,
    speed,
    route,
    selected
  }));
}

function buildSubscriptionCards(baseUrl, language) {
  return [
    ['Clash', baseUrl, pick(language, '正常', 'Healthy'), 'success'],
    ['Clash Meta', `${baseUrl}?type=meta`, pick(language, '已启用', 'Enabled'), 'success'],
    ['Sing-box', `${baseUrl}?type=singbox`, pick(language, '正常', 'Healthy'), 'success'],
    ['Surge', `${baseUrl}?type=surge`, pick(language, '已启用', 'Enabled'), 'success']
  ].map(([title, url, state, stateClass]) => ({ title, url, state, stateClass }));
}

function buildLogRows(displayLogs, language) {
  return displayLogs.slice(-10).map((line, index) => ({
    time: `15:${String(30 - index).padStart(2, '0')}:45`,
    level: index === 2 ? 'WARN' : index === 4 ? 'ERROR' : 'INFO',
    levelClass: index === 2 ? 'warning' : index === 4 ? 'danger' : 'success',
    module: pick(language, '部署', 'Deploy'),
    task: pick(language, 'Cloudflare Pages 部署', 'Cloudflare Pages deploy'),
    summary: line,
    state: index === 4 ? pick(language, '失败', 'Failed') : pick(language, '成功', 'Success'),
    source: index === 4 ? 'github-actions' : 'pages-api'
  }));
}

function buildOutputFiles(language) {
  return [
    ['vpn_node.txt', pick(language, '已生成', 'Generated'), 'success', '15:18:20'],
    ['vpn_node_speedtest.txt', pick(language, '等待中', 'Queued'), 'neutral', '--:--:--'],
    ['vpn_node_emoji.txt', pick(language, '等待中', 'Queued'), 'neutral', '--:--:--'],
    ['vmess_node.js', pick(language, '等待中', 'Queued'), 'neutral', '--:--:--'],
    ['vmess_node_worker.js', pick(language, '等待中', 'Queued'), 'neutral', '--:--:--'],
    ['_workers.zip', pick(language, '等待中', 'Queued'), 'neutral', '--:--:--']
  ].map(([name, state, stateClass, time]) => ({ name, state, stateClass, time }));
}

function buildSystemStats(language) {
  return [
    {
      title: pick(language, 'CPU 使用率', 'CPU usage'),
      value: '26%',
      detail: '4 vCPU',
      color: '#2f7cff',
      points: [12, 10, 9, 8, 7, 8, 9, 12, 28, 24, 26, 25, 26]
    },
    {
      title: pick(language, '内存使用率', 'Memory usage'),
      value: '54%',
      detail: '8.62 GB / 16 GB',
      color: '#5b5ce2',
      points: [18, 17, 16, 15, 14, 14, 15, 16, 34, 28, 30, 29, 31]
    },
    {
      title: pick(language, '磁盘使用率', 'Disk usage'),
      value: '41%',
      detail: '80 GB / 192 GB',
      color: '#6e59ff',
      points: [22, 22, 21, 21, 22, 22, 23, 24, 32, 27, 29, 28, 30]
    },
    {
      title: pick(language, '网络流量', 'Network throughput'),
      value: '67 KB/s',
      detail: '1.23 MB/s ↓',
      color: '#26b84d',
      points: [2, 3, 3, 2, 3, 4, 5, 7, 9, 8, 10, 9, 11]
    }
  ];
}

function buildAlerts(language) {
  return [
    { level: 'ERROR', title: pick(language, 'Cloudflare Pages 部署失败', 'Cloudflare Pages deployment failed'), time: '10:30:45', tone: 'danger' },
    { level: 'WARN', title: pick(language, '节点 162.12.14.15 延迟超阈值', 'Node 162.12.14.15 latency crossed the threshold'), time: '10:30:12', tone: 'warning' },
    { level: 'WARN', title: pick(language, '订阅生成耗时过长（>30s）', 'Subscription generation took too long (>30s)'), time: '10:29:56', tone: 'warning' },
    { level: 'ERROR', title: pick(language, 'GitHub Actions 执行超时', 'GitHub Actions run timed out'), time: '10:29:30', tone: 'danger' }
  ];
}

function buildProcessRows(language) {
  return [
    { name: 'VPN Auto', cpu: '10.2%', memory: '512 MB', network: '5.21 MB' },
    { name: 'node', cpu: '5.8%', memory: '256 MB', network: '1.32 MB' },
    { name: 'dns_proxy', cpu: '3.2%', memory: '128 MB', network: '256 KB' },
    { name: 'github_action', cpu: '1.8%', memory: '96 MB', network: '128 KB' },
    { name: 'cloudflared', cpu: '0.9%', memory: '76 MB', network: '74 KB' }
  ];
}

function buildDeployRecords(language) {
  return [
    { status: pick(language, '成功', 'Success'), time: '2024-05-30 10:18:30', version: 'v1.2.0', detail: pick(language, '构建 32s / 部署 89s', 'Build 32s / deploy 89s') },
    { status: pick(language, '成功', 'Success'), time: '2024-05-30 09:45:12', version: 'v1.1.9', detail: pick(language, '构建 28s / 部署 76s', 'Build 28s / deploy 76s') },
    { status: pick(language, '失败', 'Failed'), time: '2024-05-30 09:20:05', version: 'v1.1.8', detail: pick(language, '构建失败：缺少环境变量', 'Build failed: missing environment variables') }
  ];
}

function buildUpdateLog(language) {
  return [
    {
      version: 'v1.2.0',
      date: '2024-05-30',
      items: [
        pick(language, '新增自动抓取节点功能', 'Added automatic capture workflow'),
        pick(language, '优化节点去重算法', 'Improved node dedupe logic'),
        pick(language, '支持自定义构建环境', 'Added custom build environment support'),
        pick(language, '新增部署超时设置', 'Added deployment timeout settings')
      ]
    },
    {
      version: 'v1.1.9',
      date: '2024-05-20',
      items: [
        pick(language, '优化测速性能', 'Optimised speed-test performance'),
        pick(language, '新增节点延迟显示', 'Added node latency display'),
        pick(language, '修复部分配置保存问题', 'Fixed configuration persistence issues')
      ]
    }
  ];
}

function buildArchitectureBlocks(language) {
  return [
    [
      { title: pick(language, '用户界面', 'User interface'), detail: pick(language, '桌面 GUI / 配置管理', 'Desktop GUI / config pages') }
    ],
    [
      { title: pick(language, '核心处理引擎', 'Core processing engine'), detail: pick(language, '订阅解析 / 节点去重 / 延迟测速 / 配置生成 / 部署管理', 'Parse / dedupe / speed-test / render / deploy') }
    ],
    [
      { title: pick(language, '存储层', 'Storage layer'), detail: pick(language, '本地存储 / 缓存管理', 'Local storage / cache') },
      { title: pick(language, '部署层', 'Deployment layer'), detail: pick(language, 'Cloudflare API / Workers 部署', 'Cloudflare API / Workers deploy') }
    ],
    [
      { title: pick(language, '客户端', 'Client'), detail: pick(language, 'VPN 连接 / 订阅消费', 'VPN clients / subscription consumers') }
    ]
  ];
}

function sampleStageStatus(runState) {
  if (runState === 'running' || runState === 'stopping') {
    return {
      doctor: 'success',
      extract: 'success',
      dedupe: 'success',
      speedtest: 'running',
      availability: 'pending',
      postprocess: 'pending',
      render: 'pending',
      obfuscate: 'pending',
      deploy: 'pending',
      verify: 'pending'
    };
  }

  return {
    doctor: 'success',
    extract: 'success',
    dedupe: 'success',
    speedtest: 'success',
    availability: 'success',
    postprocess: 'success',
    render: 'success',
    obfuscate: 'success',
    deploy: 'success',
    verify: 'success'
  };
}

function demoLogs(language) {
  return [
    pick(language, '15:23:12 [INFO] 抓包配置验证成功', '15:23:12 [INFO] capture configuration verified'),
    pick(language, '15:24:18 [INFO] 提取节点完成，共 1,268 个节点', '15:24:18 [INFO] extracted 1,268 nodes'),
    pick(language, '15:25:32 [INFO] 节点测速完成，通过 256 个', '15:25:32 [INFO] speed-test passed for 256 nodes'),
    pick(language, '15:27:15 [INFO] 加密文件生成完成', '15:27:15 [INFO] encrypted artifacts generated'),
    pick(language, '15:28:25 [INFO] Cloudflare Pages 部署成功', '15:28:25 [INFO] Cloudflare Pages deployment succeeded')
  ];
}

function formatDate(value, language) {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleString(language, {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function resolveCurrentTaskLabel(state, messages) {
  const rows = buildStageModel(Object.keys(state.stageStatus).length ? state.stageStatus : sampleStageStatus(state.runState));
  const running = rows.find((row) => row.status === 'running');
  if (running) {
    return messages.stageLabels[running.name] ?? running.name;
  }

  const failed = rows.find((row) => row.status === 'failed');
  if (failed) {
    return `${messages.stageLabels[failed.name] ?? failed.name} / ${messages.statusLabels.failed}`;
  }

  const completed = rows.filter((row) => row.status === 'success');
  if (completed.length) {
    return messages.stageLabels[completed.at(-1).name] ?? completed.at(-1).name;
  }

  return messages.taskWaiting;
}

function pick(language, zh, en) {
  return language === 'zh-CN' ? zh : en;
}

function navId(page) {
  const suffix = page.slice(1);
  return `nav${page[0].toUpperCase()}${suffix}`;
}
