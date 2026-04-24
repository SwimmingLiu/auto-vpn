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
    'xuanfeng-area': {
      url: 'https://capture-4.vpn.example/api/v1/client/subscribe',
      key: 'xf1-demo-key',
      enabled: true
    },
    'xuanfeng-all-area': {
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
  ['sources', '抓包 API 配置'],
  ['speed', '测速配置'],
  ['rules', '节点处理规则'],
  ['package', '加密策略'],
  ['paths', '本地路径设置'],
  ['pages', 'Cloudflare Pages 配置']
];

const LOG_TABS = [
  ['runtime', '运行日志'],
  ['deploy', '部署日志'],
  ['system', '系统日志'],
  ['error', '错误日志']
];

const DEPLOY_TABS = [
  ['platform', '部署平台'],
  ['actions', 'GitHub Actions'],
  ['advanced', '高级选项']
];

const SETTINGS_TABS = [
  ['general', '通用设置'],
  ['appearance', '界面设置'],
  ['mail', '邮件配置'],
  ['logs', '日志设置'],
  ['notifications', '通知设置'],
  ['about', '关于设置']
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
    lastUpdated: formatDate(state.lastUpdateAt) || '2024-05-30 15:30:45',
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
      mode: ['全部', '本地优先', 'GitHub Actions 备用']
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
          <h3>${escapeHtml( '流程总览')}</h3>
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
          <h3>${escapeHtml( '任务状态')}</h3>
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
          <h3>${escapeHtml( '核心配置')}</h3>
          <span class="panel-subcopy">${escapeHtml( '抓包、测速与部署输入')}</span>
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
              <span>${escapeHtml( '测速阈值')}</span>
              <strong>${escapeHtml(`${vm.profile.speed_test.min_download_mb_s} MB/s`)}</strong>
            </div>
            <div class="mini-stat">
              <span>${escapeHtml( '并发线程数')}</span>
              <strong>${escapeHtml(String(vm.profile.speed_test.concurrency))}</strong>
            </div>
          </div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '运行统计')}</h3>
          <span class="panel-subcopy">${escapeHtml( '原始节点、筛选结果与订阅概览')}</span>
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
            <span class="panel-subcopy">${escapeHtml( '主订阅地址')}</span>
            <strong class="mono">${escapeHtml(vm.subscriptionCards[0].url)}</strong>
          </div>
          <button class="btn btn-primary small" data-copy-text="${escapeHtml(vm.subscriptionCards[0].url)}" type="button">
            ${escapeHtml( '复制全部')}
          </button>
        </div>
      </article>

      <article class="panel terminal-panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '实时日志')}</h3>
          <button class="btn btn-secondary small" type="button" data-page-target="logs">${escapeHtml( '查看更多')}</button>
        </div>
        <div class="log-stack">
          ${vm.displayLogs.slice(-10).map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
        </div>
      </article>

      <article class="panel action-panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '快捷操作')}</h3>
        </div>
        <div class="action-grid">
          <button class="btn btn-primary ghost-fill" data-page-target="runs" type="button">${escapeHtml( '立即运行一次')}</button>
          <button class="btn btn-secondary" data-page-target="history" type="button">${escapeHtml( '查看历史任务')}</button>
          <button class="btn btn-danger" type="button">${escapeHtml( '停止任务')}</button>
          <button class="btn btn-secondary" data-page-target="deploy" type="button">${escapeHtml( '打开输出目录')}</button>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '节点分布（TOP 10 国家/地区）')}</h3>
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
            <h3>${escapeHtml( '抓包 API 配置')}</h3>
            ${sources.map(([name, source], index) => `
              <label class="field">
                <span>${escapeHtml(index === 0 ?  '主抓包 API URL（必填）' : `${ '备用 API URL'} ${index}`)}</span>
                <input
                  ${index === 0 ? 'id="configPrimarySource"' : ''}
                  data-source="${escapeHtml(name)}"
                  data-key="url"
                  value="${escapeHtml(source.url)}"
                />
              </label>
            `).join('')}

            <div class="notice-card">
              <strong>${escapeHtml( '配置说明')}</strong>
              <p>${escapeHtml( '以上 API 地址用于自动获取订阅链接与节点列表，系统按顺序尝试这些地址，失败时自动切换到下一个可用地址。')}</p>
            </div>

            <div class="page-actions">
              <button class="btn btn-secondary" type="button">${escapeHtml( '恢复默认')}</button>
              <button class="btn btn-primary" type="button">${escapeHtml( '保存并应用')}</button>
            </div>
          </div>

          <div class="form-column">
            <div class="panel inset-panel">
              <h3>${escapeHtml( '请求设置')}</h3>
              <div class="field-grid">
                ${renderBoundField( '抓取超时时间', 'number', primary.max_runtime_seconds ?? 60, 'request-timeout', { source: sources[0][0], key: 'max_runtime_seconds' })}
                ${renderBoundField( '失败上限', 'number', primary.failure_limit ?? 3, 'request-retry', { source: sources[0][0], key: 'failure_limit' })}
                ${renderBoundField( '平台稳定阈值', 'number', primary.plateau_limit ?? 8, 'request-interval', { source: sources[0][0], key: 'plateau_limit' })}
              </div>
              ${renderBoundToggle( '启用主抓包源', primary.enabled, { source: sources[0][0], key: 'enabled' })}
              ${renderBoundToggle( '随机区域抓取', primary.use_random_area, { source: sources[0][0], key: 'use_random_area' })}
            </div>

            <div class="panel inset-panel">
              <h3>${escapeHtml( '测试结果')}</h3>
              <div class="result-summary">
                <div>
                  <strong>${escapeHtml(primary.enabled ?  '连接成功' :  '已禁用')}</strong>
                  <span>${escapeHtml( '返回节点：1,268')}</span>
                </div>
                <div class="sparkline-wrap">${renderSparkline([20, 18, 19, 21, 20, 24, 22, 26, 23, 25, 21, 24], '#57c87a')}</div>
              </div>
            </div>

            <div class="panel inset-panel">
              <h3>${escapeHtml( '配置说明')}</h3>
              <ul class="bullet-list">
                <li>${escapeHtml( '主抓包 API 用于自动获取订阅链接，是抓取数据的主要数据源。')}</li>
                <li>${escapeHtml( '系统按顺序尝试这些 API 地址，主地址失败后自动切换到备用地址。')}</li>
                <li>${escapeHtml( '所有配置仅保存在本地，不会上传任何服务器。')}</li>
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
          <h3>${escapeHtml( '当前运行任务')}</h3>
          ${renderBadge( '执行中', 'accent')}
        </div>
        <div class="run-hero">
          <div class="run-icon">RN</div>
          <div>
            <strong>${escapeHtml( '全流程自动化部署')}</strong>
            <div class="run-meta">${escapeHtml(`#20240520-151811 · ${ '本地优先 / GitHub Actions 备用'}`)}</div>
          </div>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${vm.runProgress}%"></div></div>
        <div class="timeline">
          ${vm.overviewSteps.map((step, index) => `
            <div class="timeline-row">
              <span class="timeline-index ${step.status}">${index + 1}</span>
              <span class="timeline-copy">${escapeHtml(step.title)}</span>
              ${renderBadge(step.status === 'success' ?  '已完成' : step.status === 'running' ?  '进行中' :  '等待中', step.status === 'success' ? 'success' : step.status === 'running' ? 'warning' : 'neutral')}
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel terminal-panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '实时执行日志')}</h3>
        </div>
        <pre id="runsLogOutput" class="terminal-output">${escapeHtml(vm.displayLogs.join('\n'))}</pre>
        <div class="action-grid four">
          <button class="btn btn-secondary" type="button">${escapeHtml( '暂停')}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml( '继续')}</button>
          <button class="btn btn-danger" type="button">${escapeHtml( '终止')}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml( '打开完整日志')}</button>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '执行控制')}</h3>
        </div>
        <div class="radio-stack">
          <label class="radio-row"><input type="radio" checked />${escapeHtml( '本地优先（推荐）')}</label>
          <label class="radio-row"><input type="radio" />${escapeHtml( 'GitHub Actions 备用')}</label>
        </div>
        ${renderStaticToggle( '完成后自动部署', true)}
        ${renderStaticToggle( '部署成功后通知', true)}
        ${renderStaticToggle( '失败时自动重试', true)}
        ${renderStaticToggle( '仅在节点变更时部署', false)}
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '任务统计')}</h3>
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
          <h3>${escapeHtml( '输出文件')}</h3>
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
          <input class="toolbar-input" value="${escapeHtml( '2024-05-13 → 2024-05-20')}" readonly />
          <select><option>${escapeHtml( '全部')}</option></select>
          <select><option>${escapeHtml( '全部')}</option></select>
          <input class="toolbar-input" value="${escapeHtml( '搜索任务编号、订阅地址或备注')}" readonly />
          <button class="btn btn-secondary small" type="button">${escapeHtml( '导出')}</button>
        </div>
        <div class="metric-grid">
          <div class="metric-card accent"><span>${escapeHtml( '总任务数')}</span><strong>32</strong><small>${escapeHtml( '个任务')}</small></div>
          <div class="metric-card success"><span>${escapeHtml( '成功率')}</span><strong>87.5%</strong><small>${escapeHtml( '28 成功 / 4 失败')}</small></div>
          <div class="metric-card warning"><span>${escapeHtml( '平均耗时')}</span><strong>10m 24s</strong><small>${escapeHtml( '平均执行时间')}</small></div>
          <div class="metric-card accent"><span>${escapeHtml( '平均下载速度')}</span><strong>7.68 MB/s</strong><small>${escapeHtml( '全局平均速度')}</small></div>
        </div>
      </article>

      <article class="panel wide-panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '任务列表')}</h3>
        </div>
        <div id="historyTable" class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>${escapeHtml( '任务编号')}</th>
                <th>${escapeHtml( '开始时间')}</th>
                <th>${escapeHtml( '执行模式')}</th>
                <th>${escapeHtml( '状态')}</th>
                <th>${escapeHtml( '节点数')}</th>
                <th>${escapeHtml( '平均速度')}</th>
                <th>${escapeHtml( '部署结果')}</th>
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
          <h3>${escapeHtml( '任务详情')}</h3>
          ${renderBadge( '成功', 'success')}
        </div>
        <div class="key-value-list">
          ${[
            [ '状态',  '成功'],
            [ '执行模式',  '本地优先'],
            [ '开始时间', '2024-05-20 15:18:11'],
            [ '结束时间', '2024-05-20 15:28:31'],
            [ '节点总数', '1,268'],
            [ '可用节点', '256'],
            [ '平均速度', '8.72 MB/s']
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
          <h3>${escapeHtml( '最近 7 次任务节点数')}</h3>
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
          <h3>${escapeHtml( '最近任务平均速度趋势')}</h3>
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
          <input class="toolbar-input" value="${escapeHtml( '搜索节点名称、地址或备注...')}" readonly />
          <select><option>${escapeHtml( '全部')}</option></select>
          <select><option>${escapeHtml( '全部')}</option></select>
          <select><option>${escapeHtml( '全部')}</option></select>
          <button class="btn btn-secondary small" type="button">${escapeHtml( '刷新')}</button>
        </div>
        <div id="nodeTable" class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>${escapeHtml( '节点名称')}</th>
                <th>${escapeHtml( '延迟')}</th>
                <th>${escapeHtml( '协议')}</th>
                <th>${escapeHtml( '地区')}</th>
                <th>${escapeHtml( '可用性')}</th>
                <th>${escapeHtml( '下载速度')}</th>
                <th>${escapeHtml( '线路')}</th>
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
          <h3>${escapeHtml( '节点详情')}</h3>
        </div>
        <div class="key-value-list">
          ${[
            [ '节点地址', selected.name],
            [ '协议', selected.protocol],
            [ '地区', selected.region],
            [ '状态',  '在线'],
            [ '延迟', selected.latency],
            [ '下载速度', selected.speed],
            [ '运营商', 'StarHub'],
            [ 'IP 地址', '203.116.50.23']
          ].map(([label, value]) => `
            <div class="key-value-row">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>
        <div class="page-actions stacked">
          <button class="btn btn-primary" type="button">${escapeHtml( '应用到订阅')}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml( '保存配置')}</button>
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
          <button class="btn btn-primary" type="button">${escapeHtml( '刷新订阅地址')}</button>
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="qr-block">${renderQrPlaceholder()}</div>
        <div class="key-value-list">
          ${[
            [ '创建时间', '2024-05-30 15:10:11'],
            [ '最后更新时间', vm.lastUpdated],
            [ '节点总数', String(vm.counts.postprocess_links)],
            [ '平均延迟', '32 ms'],
            [ '平均下载速度', '87.2 Mbps'],
            [ '平均可用率', '99.6%']
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
          <h3>${escapeHtml( '使用说明')}</h3>
        </div>
        <ol class="number-list">
          <li>${escapeHtml( '复制任意订阅链接并导入对应客户端。')}</li>
          <li>${escapeHtml( '定期刷新订阅以获取最新节点和测速结果。')}</li>
          <li>${escapeHtml( '若客户端不兼容，可切换其他格式地址。')}</li>
        </ol>
        <div class="action-grid">
          <button class="btn btn-secondary" data-copy-text="${escapeHtml(vm.subscriptionCards[0].url)}" type="button">${escapeHtml( '复制链接')}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml( '二维码分享')}</button>
          <button class="btn btn-secondary" type="button">${escapeHtml( '打开订阅')}</button>
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
          <input class="toolbar-input" value="${escapeHtml( '2024-06-30 → 2024-06-30')}" readonly />
          <select><option>${escapeHtml( '全部')}</option></select>
          <select><option>${escapeHtml( '全部')}</option></select>
          <input class="toolbar-input" value="${escapeHtml( '搜索日志内容、任务或来源')}" readonly />
          <button class="btn btn-primary small" type="button">${escapeHtml( '查询')}</button>
        </div>
        <div class="metric-grid">
          <div class="metric-card accent"><span>${escapeHtml( '今日新增日志')}</span><strong>1,248</strong><small>${escapeHtml( '较昨日 18.6% ↑')}</small></div>
          <div class="metric-card danger"><span>${escapeHtml( '错误日志')}</span><strong>13</strong><small>${escapeHtml( '较昨日 -7.1% ↓')}</small></div>
          <div class="metric-card warning"><span>${escapeHtml( '警告日志')}</span><strong>28</strong><small>${escapeHtml( '较昨日 +27.3% ↑')}</small></div>
          <div class="metric-card success"><span>${escapeHtml( '成功任务')}</span><strong>1,206</strong><small>${escapeHtml( '较昨日 +22.8% ↑')}</small></div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '最近告警')}</h3>
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
                <th>${escapeHtml( '时间')}</th>
                <th>${escapeHtml( '级别')}</th>
                <th>${escapeHtml( '模块')}</th>
                <th>${escapeHtml( '任务')}</th>
                <th>${escapeHtml( '详情摘要')}</th>
                <th>${escapeHtml( '状态')}</th>
                <th>${escapeHtml( '来源')}</th>
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
          <h3>${escapeHtml( '日志详情')}</h3>
        </div>
        <div class="key-value-list">
          ${[
            [ '时间', '2024-06-30 15:30:45'],
            [ '级别', 'INFO'],
            [ '模块',  '部署'],
            [ '任务', 'Cloudflare Pages'],
            [ '状态',  '成功'],
            [ '来源', 'pages-api']
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
            <h3>${escapeHtml( '部署平台')}</h3>
            ${renderBoundField( '选择平台', 'text', 'Cloudflare Pages', 'deploy-platform')}
            ${renderBoundField( 'Cloudflare 账户', 'text', 'swimmingliu@example.com', 'deploy-account')}
            ${renderProfileField( '项目名称', 'text', vm.profile.deploy.project_name, 'deploy-project', 'deploy.project_name')}
            ${renderBoundField( '构建命令', 'text', 'npm run build', 'deploy-build')}
            ${renderBoundField( '构建输出目录', 'text', 'dist', 'deploy-output')}
            ${renderStaticToggle( '自动部署', true)}
          </div>
          <div class="form-column">
            <h3>${escapeHtml( '部署配置')}</h3>
            ${renderBoundField( '部署分支', 'text', 'main', 'deploy-branch')}
            ${renderBoundField( '构建环境', 'text',  '生产环境', 'deploy-env')}
            ${renderBoundField( '部署区域', 'text',  '自动（最近区域）', 'deploy-region')}
            ${renderProfileField( 'Pages 项目地址', 'text', vm.profile.deploy.pages_project_url, 'deploy-pages-url', 'deploy.pages_project_url')}
            ${renderProfileField( '订阅地址', 'text', vm.profile.deploy.subscription_url, 'deploy-subscription-url', 'deploy.subscription_url')}
            <div class="action-grid">
              <button class="btn btn-primary" type="button">${escapeHtml( '立即部署')}</button>
              <button class="btn btn-secondary" type="button">${escapeHtml( '清除缓存')}</button>
              <button class="btn btn-secondary" type="button">${escapeHtml( '上传部署')}</button>
            </div>
            <div class="table-wrap compact-table">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>${escapeHtml( '状态')}</th>
                    <th>${escapeHtml( '时间')}</th>
                    <th>${escapeHtml( '版本')}</th>
                    <th>${escapeHtml( '部署信息')}</th>
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
          <h3>${escapeHtml( '告警统计')}</h3>
        </div>
        <div class="metric-grid compact">
          <div class="metric-card danger"><span>${escapeHtml( '紧急告警')}</span><strong>0</strong></div>
          <div class="metric-card warning"><span>${escapeHtml( '重要告警')}</span><strong>0</strong></div>
          <div class="metric-card accent"><span>${escapeHtml( '一般告警')}</span><strong>5</strong></div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml( '资源排行（TOP 5）')}</h3>
        </div>
        <div class="table-wrap compact-table">
          <table class="data-table">
            <thead>
              <tr>
                <th>${escapeHtml( '进程名称')}</th>
                <th>CPU</th>
                <th>${escapeHtml( '内存')}</th>
                <th>${escapeHtml( '网络')}</th>
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
          <h3>${escapeHtml( '系统信息')}</h3>
        </div>
        <div class="key-value-list">
          ${[
            ['OS', 'Ubuntu 22.04.4 LTS'],
            ['Kernel', '5.15.0-101-generic'],
            ['CPU', '4 vCPU'],
            [ '内存', '16 GB'],
            [ '磁盘', '192 GB'],
            [ '负载平均', '0.45, 0.32, 0.28']
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
            ${renderBoundField( '主题', 'text',  '浅色（跟随系统）', 'settings-theme')}
            ${renderBoundField( '时区', 'text', 'Asia/Shanghai', 'settings-timezone')}
            ${renderBoundField( '默认首页', 'text', messages.pageTitles.dashboard, 'settings-home')}
            ${renderBoundField( '日志保留天数', 'text',  '30 天', 'settings-retention')}
            ${renderStaticToggle( '自动保存配置', true)}
            ${renderStaticToggle( '启用启动自检', true)}
            ${renderStaticToggle( '启用异常告警', true)}
          </div>
          <div class="form-column">
            ${renderProfileField( '测速超时时间', 'number', vm.profile.speed_test.timeout_seconds, 'settings-api-timeout', 'speed_test.timeout_seconds')}
            ${renderProfileField( '测速并发数', 'number', vm.profile.speed_test.concurrency, 'settings-max-task', 'speed_test.concurrency')}
            ${renderBoundField( '自动刷新间隔', 'text',  '10 秒', 'settings-refresh')}
            ${renderProfileField( '最低下载速度 MB/s', 'number', vm.profile.speed_test.min_download_mb_s, 'settings-threads', 'speed_test.min_download_mb_s')}
            ${renderBoundField( '订阅同步策略', 'text',  '智能模式', 'settings-sync')}
            ${renderStaticToggle( '启用调试模式', false)}
            ${renderStaticToggle( '允许匿名统计', false)}
            ${renderStaticToggle( '配置变更审计', true)}
          </div>
        </div>
        <div class="page-actions">
          <button class="btn btn-secondary" type="button">${escapeHtml( '恢复默认')}</button>
          <button class="btn btn-primary" type="button">${escapeHtml( '保存设置')}</button>
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
        <p class="panel-subcopy">${escapeHtml( 'Cloudflare VPN 订阅自动化部署工具')}</p>
        <div class="key-value-list">
          ${[
            [ '项目官网', 'https://github.com/example/vpn-auto'],
            [ '使用文档', 'https://docs.example.com/vpn-auto'],
            [ '问题反馈', 'https://github.com/example/vpn-auto/issues'],
            [ '联系邮箱', 'support@example.com']
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
          <h3>${escapeHtml( '系统架构')}</h3>
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
          <h3>${escapeHtml( '更新日志')}</h3>
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
          <h3>${escapeHtml( '致谢')}</h3>
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

function renderSubtabs(group, tabs, activeTab) {
  return `
    <div class="subtab-row">
      ${tabs.map(([value, label]) => `
        <button
          class="subtab ${activeTab === value ? 'active' : ''}"
          data-subtab-page="${group}"
          data-subtab="${value}"
          type="button"
        >
          ${escapeHtml(label)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderBoundField(label, type, value, id, binding = null) {
  const bindingAttrs = binding
    ? ` data-source="${escapeHtml(binding.source)}" data-key="${escapeHtml(binding.key)}"`
    : '';
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input id="${id}" type="${type}" value="${escapeHtml(value)}"${bindingAttrs}${binding ? '' : ' readonly'} />
    </label>
  `;
}

function renderProfileField(label, type, value, id, path) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input id="${id}" type="${type}" value="${escapeHtml(value)}" data-profile-path="${escapeHtml(path)}" />
    </label>
  `;
}

function renderBoundToggle(label, checked, binding) {
  return `
    <label class="toggle-row">
      <span>${escapeHtml(label)}</span>
      <input
        class="sr-only"
        type="checkbox"
        data-source="${escapeHtml(binding.source)}"
        data-key="${escapeHtml(binding.key)}"
        ${checked ? 'checked' : ''}
      />
      <span class="toggle-pill ${checked ? 'checked' : ''}">
        <span class="toggle-knob"></span>
      </span>
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
    ['doctor',  '抓包配置',  '获取 API 配置'],
    ['extract',  '提取节点',  '运行提取脚本'],
    ['speedtest',  '节点测速',  '去重 & 速度测试'],
    ['postprocess',  '节点处理',  'IP 归属地 & Emoji'],
    ['obfuscate',  '加密处理',  '本地 / Actions 加密'],
    ['deploy',  '打包部署',  'Cloudflare Pages'],
    ['verify',  '验证完成',  '订阅可用']
  ];

  return mapping.map(([stage, title, detail]) => ({
    title,
    detail,
    status: stageRows.find((row) => row.name === stage)?.status ?? 'pending'
  }));
}

function buildStatusItems(state, messages, language) {
  return [
    { label:  '状态', value: messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle },
    { label:  '模式', value: state.isDemo ? messages.demoRunMode : messages.manualRunMode },
    { label:  'Cloudflare API', value:  '已连接' },
    { label:  '最后更新', value: formatDate(state.lastUpdateAt, language) ||  '2024-05-30 15:30:45' }
  ];
}

function buildTaskStateItems(state, counts, language) {
  return [
    [ '当前任务',  '全流程自动化运行'],
    [ '开始时间', '2024-05-20 15:18:11'],
    [ '已运行时间', '00:12:34'],
    [ '下一次运行', '2024-05-20 16:00:00'],
    [ '运行模式',  '定时任务（每小时）'],
    [ '部署目标', 'Cloudflare Pages'],
    [ '节点统计', `${counts.raw_links} / ${counts.postprocess_links}`]
  ].map(([label, value]) => ({ label, value }));
}

function buildDashboardMetrics(counts, language) {
  return [
    { label:  '抓取节点总数', value: String(counts.raw_links), detail:  '较上次 +12.5%', tone: 'accent' },
    { label:  '去重后节点数', value: String(counts.postprocess_links), detail:  '较上次 +8.2%', tone: 'success' },
    { label:  '测速通过节点', value: String(counts.speedtest_links), detail:  '较上次 +15.3%', tone: 'accent' },
    { label:  '当前可用节点', value: String(counts.availability_links), detail:  '三站验证通过', tone: 'success' },
    { label:  '平均下载速度', value: '8.72 MB/s', detail:  'Cloudflare Speedtest', tone: 'warning' },
    { label:  '最后成功部署', value: '2024-05-20 15:28:31', detail:  'Cloudflare Pages', tone: 'accent' }
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
    ['#20240520151811', '05-20 15:18',  '本地优先',  '成功', 'success', String(counts.raw_links), '8.72 MB/s', `Cloudflare Pages / …${shortUrl}`],
    ['#20240520140005', '05-20 14:00',  '本地优先',  '成功', 'success', '1,104', '7.25 MB/s', 'Cloudflare Pages'],
    ['#20240520100002', '05-20 10:00',  'GitHub Actions 备用',  '成功', 'success', '1,268', '6.80 MB/s', 'Cloudflare Pages'],
    ['#20240520060003', '05-20 06:00',  '本地优先',  '失败', 'danger', '856', '5.13 MB/s',  '部署失败'],
    ['#20240519220004', '05-19 22:00',  '本地优先',  '成功', 'success', '1,052', '7.01 MB/s', 'Cloudflare Pages'],
    ['#20240519180005', '05-19 18:00',  'GitHub Actions 备用',  '成功', 'success', '980', '6.35 MB/s', 'Cloudflare Pages'],
    ['#20240519140006', '05-19 14:00',  '本地优先',  '成功', 'success', '1,231', '7.88 MB/s', 'Cloudflare Pages']
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
    ['us.example.com', '18 ms', 'VLESS',  '美国', '100%', '158.4 Mbps',  '线路 A', false],
    ['sg.example.com', '32 ms', 'VLESS',  '新加坡', '100%', '92.1 Mbps',  '线路 A', true],
    ['jp.example.com', '45 ms', 'VLESS',  '日本', '100%', '76.8 Mbps',  '线路 B', false],
    ['hk.example.com', '28 ms', 'VLESS',  '中国香港', '100%', '134.7 Mbps',  '线路 A', false],
    ['de.example.com', '86 ms', 'VLESS',  '德国', '99%', '64.3 Mbps',  '线路 C', false],
    ['uk.example.com', '72 ms', 'VLESS',  '英国', '100%', '58.9 Mbps',  '线路 C', false],
    ['fr.example.com', '94 ms', 'VLESS',  '法国', '98%', '42.6 Mbps',  '线路 D', false],
    ['au.example.com', '61 ms', 'VLESS',  '澳大利亚', '100%', '68.2 Mbps',  '线路 B', false]
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
    ['Clash', baseUrl,  '正常', 'success'],
    ['Clash Meta', `${baseUrl}?type=meta`,  '已启用', 'success'],
    ['Sing-box', `${baseUrl}?type=singbox`,  '正常', 'success'],
    ['Surge', `${baseUrl}?type=surge`,  '已启用', 'success']
  ].map(([title, url, state, stateClass]) => ({ title, url, state, stateClass }));
}

function buildLogRows(displayLogs, language) {
  return displayLogs.slice(-10).map((line, index) => ({
    time: `15:${String(30 - index).padStart(2, '0')}:45`,
    level: index === 2 ? 'WARN' : index === 4 ? 'ERROR' : 'INFO',
    levelClass: index === 2 ? 'warning' : index === 4 ? 'danger' : 'success',
    module:  '部署',
    task:  'Cloudflare Pages 部署',
    summary: line,
    state: index === 4 ?  '失败' :  '成功',
    source: index === 4 ? 'github-actions' : 'pages-api'
  }));
}

function buildOutputFiles(language) {
  return [
    ['vpn_node.txt',  '已生成', 'success', '15:18:20'],
    ['vpn_node_speedtest.txt',  '等待中', 'neutral', '--:--:--'],
    ['vpn_node_emoji.txt',  '等待中', 'neutral', '--:--:--'],
    ['vmess_node.js',  '等待中', 'neutral', '--:--:--'],
    ['vmess_node_worker.js',  '等待中', 'neutral', '--:--:--'],
    ['_workers.zip',  '等待中', 'neutral', '--:--:--']
  ].map(([name, state, stateClass, time]) => ({ name, state, stateClass, time }));
}

function buildSystemStats(language) {
  return [
    {
      title:  'CPU 使用率',
      value: '26%',
      detail: '4 vCPU',
      color: '#2f7cff',
      points: [12, 10, 9, 8, 7, 8, 9, 12, 28, 24, 26, 25, 26]
    },
    {
      title:  '内存使用率',
      value: '54%',
      detail: '8.62 GB / 16 GB',
      color: '#5b5ce2',
      points: [18, 17, 16, 15, 14, 14, 15, 16, 34, 28, 30, 29, 31]
    },
    {
      title:  '磁盘使用率',
      value: '41%',
      detail: '80 GB / 192 GB',
      color: '#6e59ff',
      points: [22, 22, 21, 21, 22, 22, 23, 24, 32, 27, 29, 28, 30]
    },
    {
      title:  '网络流量',
      value: '67 KB/s',
      detail: '1.23 MB/s ↓',
      color: '#26b84d',
      points: [2, 3, 3, 2, 3, 4, 5, 7, 9, 8, 10, 9, 11]
    }
  ];
}

function buildAlerts(language) {
  return [
    { level: 'ERROR', title:  'Cloudflare Pages 部署失败', time: '10:30:45', tone: 'danger' },
    { level: 'WARN', title:  '节点 162.12.14.15 延迟超阈值', time: '10:30:12', tone: 'warning' },
    { level: 'WARN', title:  '订阅生成耗时过长（>30s）', time: '10:29:56', tone: 'warning' },
    { level: 'ERROR', title:  'GitHub Actions 执行超时', time: '10:29:30', tone: 'danger' }
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
    { status:  '成功', time: '2024-05-30 10:18:30', version: 'v1.2.0', detail:  '构建 32s / 部署 89s' },
    { status:  '成功', time: '2024-05-30 09:45:12', version: 'v1.1.9', detail:  '构建 28s / 部署 76s' },
    { status:  '失败', time: '2024-05-30 09:20:05', version: 'v1.1.8', detail:  '构建失败：缺少环境变量' }
  ];
}

function buildUpdateLog(language) {
  return [
    {
      version: 'v1.2.0',
      date: '2024-05-30',
      items: [
         '新增自动抓取节点功能',
         '优化节点去重算法',
         '支持自定义构建环境',
         '新增部署超时设置'
      ]
    },
    {
      version: 'v1.1.9',
      date: '2024-05-20',
      items: [
         '优化测速性能',
         '新增节点延迟显示',
         '修复部分配置保存问题'
      ]
    }
  ];
}

function buildArchitectureBlocks(language) {
  return [
    [
      { title:  '用户界面', detail:  '桌面 GUI / 配置管理' }
    ],
    [
      { title:  '核心处理引擎', detail:  '订阅解析 / 节点去重 / 延迟测速 / 配置生成 / 部署管理' }
    ],
    [
      { title:  '存储层', detail:  '本地存储 / 缓存管理' },
      { title:  '部署层', detail:  'Cloudflare API / Workers 部署' }
    ],
    [
      { title:  '客户端', detail:  'VPN 连接 / 订阅消费' }
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
     '15:23:12 [INFO] 抓包配置验证成功',
     '15:24:18 [INFO] 提取节点完成，共 1,268 个节点',
     '15:25:32 [INFO] 节点测速完成，通过 256 个',
     '15:27:15 [INFO] 加密文件生成完成',
     '15:28:25 [INFO] Cloudflare Pages 部署成功'
  ];
}

function formatDate(value) {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleString('zh-CN', {
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

function navId(page) {
  const suffix = page.slice(1);
  return `nav${page[0].toUpperCase()}${suffix}`;
}
