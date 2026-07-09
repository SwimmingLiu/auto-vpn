import { buildStageModel, PAGE_INDEX, PAGE_ORDER, resolveRunControlState } from './state.js';

const FALLBACK_PROFILE = {
  sources: {
    leiting: {
      url: 'https://capture-1.vpn.example/api/v1/client/subscribe',
      key: 'lt-demo-key',
      enabled: true
    },
    heilong: {
      url: 'https://capture-2.vpn.example/api/v1/client/nodes',
      key: 'hl-demo-key',
      enabled: true
    },
    custom: {
      url: 'https://capture-3.vpn.example/custom.txt',
      key: '',
      enabled: false
    }
  },
  speed_test: {
    min_download_mb_s: 1,
    timeout_seconds: 20,
    concurrency: 3
  },
  deploy: {
    project_name: 'sub-nodes',
    pages_project_url: 'https://sub-nodes.pages.dev',
    subscription_url: 'https://vpn.example.top/179ba8dd-3854-4747-b853-fc1868ef3937',
    verify_subscription_url: 'https://www.swimmingliu.online/sub?token=8410fb43eb2176497f5beafc0c39f5bc',
    account_id: '',
    cloudflare_api_token: '',
    pages_secret_admin: 'swimmingliu'
  },
  paths: {
    project_root: '/Users/user/vpn-sub',
    artifacts_root: '/Users/user/vpn-sub/artifacts'
  }
};

const NAV_ICONS = {
  dashboard: '⌂',
  runs: '◉',
  results: '▣',
  subscriptions: '♢',
  logs: '▤',
  settings: '⚙'
};

const PAGE_STATUS = {
  dashboard: ['', 'neutral'],
  runs: ['', 'neutral'],
  results: ['', 'neutral'],
  subscriptions: ['', 'neutral'],
  logs: ['', 'neutral'],
  settings: ['', 'neutral']
};

const LOG_FILTERS = ['全部', '运行日志', '错误', '按阶段'];
const SUBSCRIPTION_FORMATS = ['Clash', 'Clash Meta', 'Sing-box', 'Surge'];
const EMPTY_COUNTS = {
  raw_links: 0,
  deduped_links: 0,
  speedtest_links: 0,
  availability_links: 0,
  postprocess_links: 0
};

const SOURCE_DISPLAY_ORDER = ['leiting', 'heidong', 'mifeng', 'xuanfeng-area', 'xuanfeng-all-area'];
const RETRY_STAGE_ORDER = ['speedtest', 'availability', 'postprocess', 'render', 'obfuscate', 'deploy', 'verify'];
const STAGE_DISPLAY_NAMES = {
  doctor: 'doctor',
  extract: 'extract',
  dedupe: 'dedupe',
  speedtest: 'speedtest',
  availability: 'availability',
  postprocess: 'postprocess',
  render: 'render',
  obfuscate: 'obfuscate',
  deploy: 'deploy',
  verify: 'verify'
};
const DEFAULT_AVAILABILITY_TARGETS = {
  gemini: {
    url: 'https://gemini.google.com',
    enabled: true
  },
  chatgpt_ios: {
    url: 'https://ios.chat.openai.com/',
    enabled: true
  },
  chatgpt_web: {
    url: 'https://api.openai.com/compliance/cookie_requirements',
    enabled: true
  },
  claude: {
    url: 'https://claude.ai/cdn-cgi/trace',
    enabled: true
  }
};

export function buildViewModel(state, messages, language) {
  const profile = mergeProfile(state.profile ?? FALLBACK_PROFILE);
  const sourceCounts = state.sourceCounts ?? {};
  const dedupedSourceCount = Object.values(sourceCounts).reduce(
    (total, counts) => total + Number(counts?.deduped_links ?? 0),
    0
  );
  const counts = {
    ...EMPTY_COUNTS,
    ...(state.counts ?? {})
  };
  if (!Number.isFinite(Number(counts.deduped_links)) || Number(counts.deduped_links) <= 0) {
    counts.deduped_links = dedupedSourceCount || counts.deduped_links || counts.postprocess_links || 0;
  }
  const subscriptionUrl = profile.deploy.subscription_url || FALLBACK_PROFILE.deploy.subscription_url;
  const subscriptionCards = buildSubscriptionCards(subscriptionUrl);
  const currentSubscription = subscriptionCards.find((card) => card.title === state.subscriptionFormat) ?? subscriptionCards[0];
  const displayLogs = (state.logEntries ?? []).map((entry) => classifyLogEntry(entry));
  const logFilter = state.logFilter ?? '全部';
  const stageRows = normalizeStageRows(state.stageStatus, state.runState);
  const currentStage = stageRows.find((row) => row.status === 'running') ?? stageRows.find((row) => row.status === 'success') ?? stageRows[0];
  const artifactDir = state.artifactDir ?? '';
  const hasResult = Boolean(artifactDir || Object.values(counts).some((value) => Number(value) > 0));
  const retryArtifacts = Array.isArray(state.retryArtifacts) ? state.retryArtifacts : [];
  const selectedRetryArtifact = retryArtifacts.find((item) => item.artifact_dir === state.selectedRetryArtifactDir) ?? retryArtifacts[0] ?? null;
  const retryStageOptions = deriveRetryStageOptions(selectedRetryArtifact);
  const selectedRetryStage = retryStageOptions.includes(state.selectedRetryStage)
    ? state.selectedRetryStage
    : retryStageOptions[0] ?? '';
  const deployment = {
    project_name: state.deployment?.project_name ?? profile.deploy.project_name ?? '',
    pages_project_url: state.deployment?.pages_project_url ?? profile.deploy.pages_project_url ?? '',
    worker_entry: state.deployment?.worker_entry ?? (artifactDir ? `${artifactDir}/pages_bundle/_worker.js` : ''),
    module_manifest_path: state.deployment?.module_manifest_path ?? (artifactDir ? `${artifactDir}/pages_bundle/manifest.json` : '')
  };

  return {
    profile,
    counts,
    subscriptionUrl,
    subscriptionFormat: state.subscriptionFormat ?? 'Clash',
    qrDataUrl: state.qrDataUrl ?? '',
    displayLogs,
    logFilter,
    logRows: buildLogRows(filterLogEntries(displayLogs, logFilter)),
    logGroups: groupLogEntriesByStage(filterLogEntries(displayLogs, logFilter)),
    stageRows,
    currentStage,
    artifactDir,
    hasResult,
    lastUpdated: formatDate(state.lastUpdateAt) || '—',
    runStartedAt: formatDate(state.runStartedAt) || '—',
    runElapsed: state.runState === 'running' ? formatElapsed(state.runStartedAt) : '—',
    outputFiles: state.outputFiles ?? [],
    nodeRows: state.nodeRows ?? [],
    regionStats: buildRegionStats(state.nodeRows ?? []),
    subscriptionCards,
    currentSubscription,
    sourceRows: buildSourceRows(profile),
    sourceCounts,
    rawSourceMetricRows: buildSourceMetricRows(profile, sourceCounts, 'raw_links'),
    dedupedSourceMetricRows: buildSourceMetricRows(profile, sourceCounts, 'deduped_links'),
    retryContext: state.retryContext ?? {},
    deployment,
    retryArtifacts,
    selectedRetryArtifact,
    selectedRetryArtifactDir: selectedRetryArtifact?.artifact_dir ?? '',
    retryStageOptions,
    selectedRetryStage,
    runControlState: resolveRunControlState(state.runState),
    statusItems: buildStatusItems(state, messages),
    currentStatusLabel: resolveCurrentStatusLabel(state, messages),
    currentTaskLabel: resolveCurrentTaskLabel(state, messages),
    runStateLabel: messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle,
    runStateTone: runStateTone(state.runState),
    settingsDrawer: state.settingsDrawer ?? null,
    modalTransform: state.modalTransform ?? ''
  };
}

function runStateTone(runState) {
  if (runState === 'running' || runState === 'success') return 'success';
  if (runState === 'stopping') return 'warning';
  if (runState === 'failed') return 'danger';
  return 'neutral';
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

export function buildTopbarActions(activePage, viewModel, messages, labels) {
  const actionSets = {
    dashboard: [
      `<button class="btn btn-secondary" data-action="open-settings" type="button">${escapeHtml(messages.settingsButton)}</button>`,
      `<button class="btn btn-danger" data-run-action="stop" type="button" ${labels.stopDisabled ? 'disabled' : ''}>${escapeHtml(labels.stopLabel)}</button>`,
      `<button class="btn btn-primary" data-run-action="start" type="button" ${labels.runDisabled ? 'disabled' : ''}>${escapeHtml(labels.runLabel)}</button>`
    ],
    runs: [
    ],
    results: [
    ],
    subscriptions: [
    ],
    logs: [],
    settings: []
  };
  return (actionSets[activePage] ?? []).join('');
}

export function buildShortcutStrip(messages) {
  return buildShortcutDescriptors(messages).map((action) => `
    <button
      id="${action.id}"
      class="shortcut-action"
      data-shortcut-target="${action.page}"
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
  return `
    <section class="page-shell" data-page-shell="${activePage}">
      ${buildPageInner(activePage, viewModel, messages, language, subtabs)}
    </section>
  `;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildPageInner(activePage, vm, messages) {
  switch (activePage) {
    case 'dashboard':
      return buildDashboardPage(vm, messages);
    case 'runs':
      return buildRunsPage(vm, messages);
    case 'results':
      return buildResultsPage(vm, messages);
    case 'subscriptions':
      return buildSubscriptionsPage(vm, messages);
    case 'logs':
      return buildLogsPage(vm, messages);
    default:
      return buildSettingsPage(vm, messages);
  }
}

function buildDashboardPage(vm, messages) {
  return `
    <div id="dashboardOverview" class="page-grid dashboard-grid">
      <article class="panel wide-panel status-hero-card">
        <div>
          <span class="panel-subcopy">当前运行状态</span>
          <h3>${escapeHtml(vm.currentStatusLabel)}</h3>
          <p>${vm.hasResult ? '最近一次运行已完成' : '系统就绪，等待运行'}</p>
        </div>
        <div class="status-orb">✓</div>
      </article>

      ${buildDashboardMetricsMarkup(vm)}

      <article class="panel">
        <div class="panel-headline">
          <h3>最近运行结果</h3>
          ${vm.hasResult ? renderBadge('成功', 'success') : renderBadge('未开始', 'neutral')}
        </div>
        <div class="key-value-list">
          <div class="key-value-row"><span>状态</span><strong>${vm.hasResult ? '成功' : '未开始'}</strong></div>
          <div class="key-value-row"><span>Artifact 目录</span><strong class="mono">${escapeHtml(vm.artifactDir || '—')}</strong></div>
          <div class="key-value-row"><span>更新时间</span><strong>${escapeHtml(vm.lastUpdated)}</strong></div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>系统状态</h3>
          ${renderBadge(vm.runStateLabel, vm.runStateTone)}
        </div>
        <div class="key-value-list">
          ${vm.statusItems.map((item) => `
            <div class="key-value-row">
              <span>${escapeHtml(item.label)}</span>
              <strong>${escapeHtml(item.value)}</strong>
            </div>
          `).join('')}
          <div class="key-value-row">
            <span>${escapeHtml(messages.currentTaskLabel)}</span>
            <strong>${escapeHtml(vm.currentTaskLabel)}</strong>
          </div>
        </div>
      </article>
    </div>
  `;
}

export function buildDashboardMetricsMarkup(vm) {
  return `
    <article id="dashboardMetricsPanel" class="panel wide-panel">
      <div class="metric-grid four">
        ${dashboardMetrics(vm.counts).map((metric) => `
          <div class="metric-card ${metric.tone}" data-metric-key="${escapeHtml(metric.key)}">
            <span>${escapeHtml(metric.label)}</span>
            <strong>${escapeHtml(metric.value)}</strong>
            <small>${escapeHtml(metric.detail)}</small>
            ${metric.key === 'raw_links'
              ? renderSourceMetricRows(vm.rawSourceMetricRows, '各数据源原始节点数')
              : metric.key === 'deduped_links'
                ? renderSourceMetricRows(vm.dedupedSourceMetricRows, '各数据源去重节点数')
                : ''}
          </div>
        `).join('')}
      </div>
    </article>
  `;
}

function buildRunsPage(vm, messages) {
  const artifactDisabled = vm.runControlState.isBusy || !vm.retryArtifacts.length ? 'disabled' : '';
  const runDisabled = vm.runControlState.runDisabled ? 'disabled' : '';
  const stageDisabled = vm.runControlState.isBusy || !vm.retryStageOptions.length ? 'disabled' : '';
  const retryDisabled = vm.runControlState.isBusy || !vm.selectedRetryArtifactDir || !vm.selectedRetryStage ? 'disabled' : '';
  return `
    <div id="runsWorkspace" class="page-grid runs-grid">
      <article class="panel wide-panel run-control-panel">
        <button class="btn btn-primary run-big" data-run-action="start" type="button" ${runDisabled}>▶ 开始运行</button>
        <button class="btn btn-secondary run-big" data-run-action="stop" type="button" ${vm.runControlState.stopDisabled ? 'disabled' : ''}>■ 停止运行</button>
        <div class="retry-control-card">
          <div class="field compact retry-field retry-artifact-field">
            <span>历史 run</span>
            <select data-run-retry-artifact ${artifactDisabled}>
              ${vm.retryArtifacts.length
                ? vm.retryArtifacts.map((item) => `
                  <option value="${escapeHtml(item.artifact_dir)}" ${vm.selectedRetryArtifactDir === item.artifact_dir ? 'selected' : ''}>
                    ${escapeHtml(formatRetryArtifactLabel(item))}
                  </option>
                `).join('')
                : '<option value="">暂无可重试 run</option>'}
            </select>
          </div>
          <label class="field compact retry-field">
            <span>阶段</span>
            <select data-run-retry-stage ${stageDisabled}>
              ${vm.retryStageOptions.length
                ? vm.retryStageOptions.map((stage) => `
                  <option value="${escapeHtml(stage)}" ${vm.selectedRetryStage === stage ? 'selected' : ''}>
                    ${escapeHtml(STAGE_DISPLAY_NAMES[stage] || stage)}
                  </option>
                `).join('')
                : '<option value="">暂无可重试阶段</option>'}
            </select>
          </label>
          <button class="btn btn-secondary retry-stage-button" data-action="retry-stage" type="button" ${retryDisabled}>从所选阶段重试</button>
          <div class="retry-summary-card">
            ${vm.selectedRetryArtifact
              ? `
                <div class="retry-summary-head">
                  <strong>${escapeHtml(vm.selectedRetryArtifact.artifact_name)}</strong>
                  ${renderBadge(runStatusLabel(vm.selectedRetryArtifact.run_status), stateClass(vm.selectedRetryArtifact.run_status))}
                </div>
                <div class="retry-summary-meta">
                  <span>可重试阶段：${escapeHtml((vm.selectedRetryArtifact.retryable_stages ?? []).join(', ') || '暂无')}</span>
                  ${vm.selectedRetryArtifact.retry_context?.source_artifact_name
                    ? `<span>来源：${escapeHtml(vm.selectedRetryArtifact.retry_context.source_artifact_name)} · ${escapeHtml(vm.selectedRetryArtifact.retry_context.start_stage || '—')}</span>`
                    : '<span>来源：原始 run</span>'}
                </div>
              `
              : '<div class="empty-state">暂无可重试 run</div>'}
          </div>
          <p class="retry-help">阶段重试会新建 artifact，并从所选阶段继续执行到 verify。</p>
        </div>
        <div class="run-options">
          ${[
            ['跳过部署', 'skipDeploy', false],
            ['跳过验证', 'skipVerify', false],
            ['保存配置后运行', 'saveBeforeRun', true]
          ].map(([label, key, checked]) => `
            <label class="checkbox-chip"><input data-run-option="${escapeHtml(key)}" type="checkbox" ${checked ? 'checked' : ''} />${escapeHtml(label)}</label>
          `).join('')}
        </div>
      </article>

      ${buildRunsStageProgressMarkup(vm)}
      ${buildRunsCurrentStageMarkup(vm)}
    </div>
  `;
}

export function buildRunsStageProgressMarkup(vm) {
  return `
    <article id="runsStageProgress" class="panel timeline-panel">
      <div class="panel-headline"><h3>阶段进度</h3><span class="panel-subcopy">全流程时间线</span></div>
      <div class="timeline">
        ${vm.stageRows.map((stage) => `
          <div class="timeline-row">
            <span class="timeline-index ${stage.status}"></span>
            <span class="timeline-copy">${escapeHtml(stage.name)}</span>
            <span class="inline-state ${stateClass(stage.status)}">${escapeHtml(stageLabel(stage.status))}</span>
          </div>
        `).join('')}
      </div>
    </article>
  `;
}

export function buildRunsCurrentStageMarkup(vm) {
  return `
    <article id="runsCurrentStage" class="panel">
      <div class="panel-headline"><h3>当前阶段详情</h3>${renderBadge(stageLabel(vm.currentStage.status), stateClass(vm.currentStage.status))}</div>
      <div class="key-value-list">
        <div class="key-value-row"><span>阶段</span><strong>${escapeHtml(vm.currentStage.name)}</strong></div>
        <div class="key-value-row"><span>状态</span><strong>${escapeHtml(stageLabel(vm.currentStage.status))}</strong></div>
        <div class="key-value-row"><span>开始时间</span><strong>${escapeHtml(vm.runStartedAt)}</strong></div>
        <div class="key-value-row"><span>已耗时</span><strong>${escapeHtml(vm.runElapsed)}</strong></div>
        <div class="key-value-row"><span>当前目标</span><strong>${escapeHtml(vm.currentStage.name === 'speedtest' ? '测速通过节点' : '流水线处理')}</strong></div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:35%"></div></div>
    </article>
  `;
}

function buildResultsPage(vm, messages) {
  const deployStage = vm.stageRows.find((row) => row.name === 'deploy');
  const verifyStage = vm.stageRows.find((row) => row.name === 'verify');
  return `
    <div id="resultsWorkspace" class="page-grid results-grid">
      <article class="panel wide-panel artifact-card">
        <div>
          <span class="panel-subcopy">最终节点来源</span>
          <strong class="mono">${escapeHtml(vm.artifactDir || '暂无')}</strong>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-secondary" data-action="copy-nodes" type="button">复制节点</button>
          <button class="btn btn-secondary" data-action="open-artifact-dir" type="button">打开目录</button>
        </div>
      </article>

      ${vm.retryContext?.source_artifact_name ? `
        <article class="panel wide-panel retry-origin-card">
          <div class="panel-headline">
            <h3>重试来源</h3>
            ${renderBadge('阶段重试生成', 'warning')}
          </div>
          <div class="key-value-list">
            <div class="key-value-row"><span>来源 run</span><strong class="mono">${escapeHtml(vm.retryContext.source_artifact_name)}</strong></div>
            <div class="key-value-row"><span>起始阶段</span><strong>${escapeHtml(vm.retryContext.start_stage || '—')}</strong></div>
            <div class="key-value-row"><span>来源目录</span><strong class="mono">${escapeHtml(vm.retryContext.source_artifact_dir || '—')}</strong></div>
          </div>
        </article>
      ` : ''}

      <article class="panel wide-panel">
        <div class="panel-headline"><h3>本次 deploy 目标</h3><span class="panel-subcopy">部署摘要</span></div>
        <div class="key-value-list">
          <div class="key-value-row"><span>项目名称</span><strong>${escapeHtml(vm.deployment.project_name || '—')}</strong></div>
          <div class="key-value-row"><span>Pages 地址</span><strong class="mono">${escapeHtml(vm.deployment.pages_project_url || '—')}</strong></div>
          <div class="key-value-row"><span>入口文件</span><strong class="mono">${escapeHtml(vm.deployment.worker_entry || '—')}</strong></div>
          <div class="key-value-row"><span>Manifest</span><strong class="mono">${escapeHtml(vm.deployment.module_manifest_path || '—')}</strong></div>
          <div class="key-value-row"><span>deploy 状态</span><strong>${escapeHtml(stageLabel(deployStage?.status || 'pending'))}</strong></div>
          <div class="key-value-row"><span>verify 状态</span><strong>${escapeHtml(stageLabel(verifyStage?.status || 'pending'))}</strong></div>
        </div>
      </article>

      <article class="panel wide-panel">
        <div class="panel-headline"><h3>区域统计</h3><span class="panel-subcopy">按最终节点名称中的区域码统计</span></div>
        <div class="region-stat-grid">
          ${vm.regionStats.length ? vm.regionStats.map((item) => `
            <div class="region-stat-card">
              <span>${escapeHtml(item.region)}</span>
              <strong>${escapeHtml(item.count)}</strong>
            </div>
          `).join('') : '<div class="empty-state">暂无区域统计，运行完成后显示。</div>'}
        </div>
      </article>

      <article class="panel wide-panel">
        <div class="panel-headline"><h3>最终节点列表</h3><span class="panel-subcopy">${escapeHtml(vm.nodeRows.length)} 条</span></div>
        <div id="resultNodePreview" class="table-wrap">
          <table class="data-table decoded-node-table">
            <thead><tr><th>#</th><th>节点名称</th><th>IP地址</th><th>协议</th><th>path</th></tr></thead>
            <tbody>
              ${vm.nodeRows.length ? vm.nodeRows.map((row, index) => `
                <tr>
                  <td>${index + 1}</td>
                  <td>${escapeHtml(row.name || '—')}</td>
                  <td>${escapeHtml(row.address || '—')}</td>
                  <td>${escapeHtml(row.protocol || '—')}</td>
                  <td class="mono">${escapeHtml(row.path || '—')}</td>
                </tr>
              `).join('') : '<tr><td colspan="5">暂无节点，运行完成后显示。</td></tr>'}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  `;
}

function buildSubscriptionsPage(vm, messages) {
  const primaryCard = vm.currentSubscription;
  return `
    <div id="subscriptionCards" class="page-grid subscriptions-grid">
      <article class="panel subscriptions-primary-panel">
        <div class="panel-headline"><h3>主订阅地址</h3>${renderBadge('自动生成', 'success')}</div>
        <div class="subscription-primary-stack">
          <div class="subscription-tab-scroller">
            ${SUBSCRIPTION_FORMATS.map((format) => `
              <button
                class="subtab ${vm.subscriptionFormat === format ? 'active' : ''}"
                data-subscription-format="${escapeHtml(format)}"
                type="button"
              >${escapeHtml(format)}</button>
            `).join('')}
          </div>
          <div class="subscription-primary mono">${escapeHtml(primaryCard.url)}</div>
          <div class="action-grid">
            <button class="btn btn-primary" data-copy-text="${escapeHtml(primaryCard.url)}" type="button">复制链接</button>
            <button class="btn btn-secondary" data-open-url="${escapeHtml(primaryCard.url)}" type="button">打开订阅</button>
          </div>
        </div>
      </article>

      <article class="panel slim-panel">
        <div class="panel-headline"><h3>订阅二维码</h3></div>
        <div class="qr-block">${renderQr(vm.qrDataUrl)}</div>
        <p class="panel-subcopy center-copy">扫码导入订阅</p>
      </article>

      <article class="panel wide-panel subscription-meta">
        <div class="mini-stat"><span>最后生成时间</span><strong>${escapeHtml(vm.lastUpdated)}</strong></div>
        <div class="mini-stat"><span>最终节点数量</span><strong>${escapeHtml(vm.counts.availability_links)} 个</strong></div>
      </article>
    </div>
  `;
}

function buildLogsPage(vm, messages) {
  return `
    <div id="logsWorkspace" class="page-grid logs-grid">
      <article class="panel wide-panel terminal-panel logs-panel">
        <div class="toolbar-row log-toolbar">
          <div class="toolbar-left">
            ${LOG_FILTERS.map((filter) => `
              <button
                class="subtab ${vm.logFilter === filter ? 'active' : ''}"
                data-log-filter="${escapeHtml(filter)}"
                type="button"
              >${escapeHtml(filter)}</button>
            `).join('')}
          </div>
          <div class="toolbar-right">
            <button class="btn btn-secondary small" data-action="copy-log" type="button">复制日志</button>
            <button class="btn btn-secondary small" data-action="clear-log" type="button">清空显示</button>
            <button class="btn btn-primary small" data-action="open-log-file" type="button">打开日志文件</button>
          </div>
        </div>
        <div id="logCenterTable" class="terminal-output log-stream">
          ${buildLogCenterMarkup(vm)}
        </div>
      </article>
    </div>
  `;
}

export function buildLogCenterMarkup(vm) {
  return vm.logFilter === '按阶段' ? renderLogGroups(vm.logGroups) : renderLogRows(vm.logRows);
}

function buildSettingsPage(vm, messages) {
  return `
    <div id="settingsWorkspace" class="page-grid settings-grid">
      <article class="panel wide-panel settings-overview-panel">
        <div class="panel-headline">
          <h3>设置总览</h3>
          <span class="panel-subcopy">点击卡片后在弹窗中编辑，并在弹窗内直接保存</span>
        </div>
        <div class="settings-overview-grid">
          ${buildSettingsCard('sources', '数据源配置', `已启用 ${vm.sourceRows.filter((row) => row.enabled).length} / ${vm.sourceRows.length} 个来源`, '管理抓取地址、密钥和启用状态')}
          ${buildSettingsCard('speed_test', '测速配置', `最低 ${vm.profile.speed_test.min_download_mb_s} MB/s · 并发 ${vm.profile.speed_test.concurrency}`, '控制测速阈值、超时和并发')}
          ${buildSettingsCard('availability_targets', 'AI可达性检测', `已启用 ${enabledAvailabilityTargetCount(vm.profile.availability_targets)} / ${Object.keys(vm.profile.availability_targets ?? {}).length} 个网站`, '配置 Gemini、ChatGPT、Claude 或自定义网站')}
          ${buildSettingsCard('deploy', '部署配置', `项目 ${vm.profile.deploy.project_name || '未设置'}`, '项目名变化会自动联动默认 Pages 地址；手动修改 URL 后，后续不再自动覆盖')}
        </div>
      </article>

      ${buildSettingsDrawer(vm)}
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

function buildSettingsCard(section, title, summary, detail) {
  return `
    <button
      class="settings-overview-card"
      data-settings-card="${section}"
      type="button"
    >
      <span class="settings-card-kicker">${escapeHtml(title)}</span>
      <strong class="settings-card-summary" id="settingsCardSummary-${section}">${escapeHtml(summary)}</strong>
      <span class="settings-card-detail">${escapeHtml(detail)}</span>
    </button>
  `;
}

function buildSettingsDrawer(vm) {
  const drawer = vm.settingsDrawer;
  const isOpen = Boolean(drawer);
  const section = drawer?.section ?? '';
  const title = {
    sources: '数据源配置',
    speed_test: '测速配置',
    availability_targets: 'AI可达性检测',
    deploy: '部署配置'
  }[section] ?? '设置';

  const style = vm.modalTransform ? `style="transform: ${escapeHtml(vm.modalTransform)};"` : '';

  return `
    <div id="settingsDrawer" class="settings-drawer-shell" data-open="${isOpen ? 'true' : 'false'}" data-section="${escapeHtml(section)}">
      <button class="settings-drawer-backdrop" data-drawer-dismiss="backdrop" type="button" aria-label="关闭设置弹窗"></button>
      <aside class="settings-drawer-panel" ${style}>
        <div class="settings-drawer-head">
          <div>
            <span class="settings-card-kicker">编辑配置</span>
            <h3 id="settingsDrawerTitle">${escapeHtml(title)}</h3>
          </div>
        </div>
        <div class="settings-drawer-body">
          ${isOpen ? buildSettingsDrawerBody(section, drawer.draft) : ''}
        </div>
        <div class="settings-drawer-actions">
          <button class="btn btn-secondary" data-drawer-close="cancel" type="button">取消</button>
          <button class="btn btn-primary" data-drawer-save="save" type="button">保存</button>
        </div>
      </aside>
    </div>
  `;
}

const SOURCE_NAMES = {
  'leiting': '雷霆',
  'heidong': '黑洞',
  'mifeng': '蜜蜂',
  'xuanfeng-area': '旋风部分区域',
  'xuanfeng-all-area': '旋风全区域',
  'heilong': '黑龙',
  'custom': '自定义'
};

function buildSettingsDrawerBody(section, draft) {
  if (section === 'sources') {
    const sourceDraft = draft?.sources ?? {};
    return `
      <div class="source-drawer-settings">
        ${renderDrawerField('最大迭代次数', 'number', draft?.maxIterations ?? 40, 'sources.maxIterations', true, 'data-source-max-iterations min="1"')}
        ${renderDrawerField('区域起始', 'number', draft?.areaMin ?? 0, 'sources.areaMin', true, 'data-source-area-min')}
        ${renderDrawerField('区域结束', 'number', draft?.areaMax ?? 100, 'sources.areaMax', true, 'data-source-area-max')}
      </div>
      <div class="table-wrap">
        <table class="data-table settings-source-table">
          <colgroup>
            <col class="settings-col-enabled" />
            <col class="settings-col-name" />
            <col class="settings-col-url" />
            <col class="settings-col-key" />
          </colgroup>
          <thead><tr><th>启用</th><th>名称</th><th>地址</th><th>密钥</th></tr></thead>
          <tbody>
            ${Object.entries(sourceDraft).map(([name, source]) => `
              <tr>
                <td><input type="checkbox" data-drawer-source="${escapeHtml(name)}" data-drawer-key="enabled" ${source.enabled ? 'checked' : ''} /></td>
                <td><strong class="settings-source-name">${escapeHtml(SOURCE_NAMES[name] || name)}</strong></td>
                <td>
                  <textarea
                    class="table-textarea mono"
                    rows="3"
                    data-drawer-source="${escapeHtml(name)}"
                    data-drawer-key="url"
                  >${escapeHtml(source.url ?? '')}</textarea>
                </td>
                <td><input data-drawer-source="${escapeHtml(name)}" data-drawer-key="key" value="${escapeHtml(source.key ?? '')}" /></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (section === 'speed_test') {
    return `
      <div class="form-grid compact-form-grid">
        ${renderDrawerField('最低下载速度（MB/s）', 'number', draft.min_download_mb_s, 'speed_test.min_download_mb_s', true)}
        ${renderDrawerField('超时时间（秒）', 'number', draft.timeout_seconds, 'speed_test.timeout_seconds', true)}
        ${renderDrawerField('并发数量', 'number', draft.concurrency, 'speed_test.concurrency', true)}
      </div>
    `;
  }

  if (section === 'availability_targets') {
    return `
      <div class="availability-toolbar">
        <button class="btn btn-secondary small" data-availability-action="add" type="button">新增网站</button>
      </div>
      <div class="table-wrap">
        <table class="data-table availability-target-table">
          <colgroup>
            <col class="availability-col-enabled" />
            <col class="availability-col-name" />
            <col class="availability-col-url" />
            <col class="availability-col-actions" />
          </colgroup>
          <thead><tr><th>启用</th><th>名称</th><th>URL</th><th>操作</th></tr></thead>
          <tbody>
            ${(draft?.targets ?? []).map((target, index) => `
              <tr>
                <td><input type="checkbox" data-availability-index="${index}" data-availability-key="enabled" ${target.enabled ? 'checked' : ''} /></td>
                <td><input data-availability-index="${index}" data-availability-key="name" value="${escapeHtml(target.name ?? '')}" /></td>
                <td>
                  <textarea class="table-textarea mono" rows="3" data-availability-index="${index}" data-availability-key="url">${escapeHtml(target.url ?? '')}</textarea>
                </td>
                <td><button class="btn btn-secondary small" data-availability-action="remove" data-availability-index="${index}" type="button">删除</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (section === 'deploy') {
    return `
      <div class="notice-card">
        <strong>部署配置说明</strong>
        <p>项目名变化会自动联动默认 Pages 地址；手动修改 URL 后，后续不再自动覆盖。verify 订阅地址用于 deploy 后的健康检查，不影响页面展示二维码。</p>
      </div>
      <div class="form-grid compact-form-grid">
        ${renderDrawerField('项目名称', 'text', draft.project_name, 'deploy.project_name')}
        ${renderDrawerField('Pages 地址', 'text', draft.pages_project_url, 'deploy.pages_project_url')}
        ${renderDrawerField('订阅地址', 'text', draft.subscription_url, 'deploy.subscription_url')}
        ${renderDrawerField('verify 订阅地址', 'text', draft.verify_subscription_url, 'deploy.verify_subscription_url')}
        ${renderDrawerField('Cloudflare Token', 'password', draft.cloudflare_api_token, 'deploy.cloudflare_api_token')}
        ${renderDrawerField('Pages Secret ADMIN', 'password', draft.pages_secret_admin, 'deploy.pages_secret_admin')}
      </div>
    `;
  }

  return `
    <div class="notice-card">
      <strong>无可用配置</strong>
      <p>该分组暂无可供编辑的内容。</p>
    </div>
  `;
}

function renderDrawerField(label, type, value, path, isCompact = false, extraAttrs = '') {
  return `
    <label class="field ${isCompact ? 'compact' : ''}">
      <span>${escapeHtml(label)}</span>
      <input type="${type}" value="${escapeHtml(value ?? '')}" data-drawer-path="${escapeHtml(path)}" ${extraAttrs} />
    </label>
  `;
}

function renderBadge(text, tone) {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function renderQr(dataUrl) {
  if (!dataUrl) {
    return '<div class="qr-loading">二维码生成中</div>';
  }
  return `<img class="qr-image" alt="订阅二维码" src="${escapeHtml(dataUrl)}" />`;
}

function buildShortcutDescriptors(messages) {
  return [
    { id: 'shortcutRun', page: 'runs', label: messages.shortcutActions.run, tone: 'accent' },
    { id: 'shortcutSettings', page: 'settings', label: messages.shortcutActions.settings, tone: 'warning' },
    { id: 'shortcutResults', page: 'results', label: messages.shortcutActions.results, tone: 'success' },
    { id: 'shortcutLogs', page: 'logs', label: messages.shortcutActions.logs, tone: 'accent' }
  ];
}

function normalizeStageRows(stageStatus, runState) {
  const actual = Object.keys(stageStatus ?? {}).length ? stageStatus : {};
  return buildStageModel(actual);
}

function buildStatusItems(state, messages) {
  return [
    { label: '状态', value: messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle },
    { label: '模式', value: state.isDemo ? messages.demoRunMode : messages.manualRunMode },
    { label: '最后结果', value: messages.runResultLabels[state.runResult] ?? messages.runResultLabels.idle },
    { label: '最后更新', value: formatDate(state.lastUpdateAt) || '—' }
  ];
}

function dashboardMetrics(counts) {
  return [
    { key: 'raw_links', label: '原始节点', value: String(counts.raw_links), detail: '抓取输入', tone: 'accent' },
    { key: 'deduped_links', label: '去重节点', value: String(counts.deduped_links ?? counts.postprocess_links), detail: '全局去重', tone: 'accent' },
    { key: 'speedtest_links', label: '测速通过', value: String(counts.speedtest_links), detail: '速度达标', tone: 'success' },
    { key: 'availability_links', label: '最终可用', value: String(counts.availability_links), detail: '验证通过', tone: 'success' }
  ];
}

function renderSourceMetricRows(rows, ariaLabel) {
  if (!rows.length) {
    return '';
  }
  return `
    <div class="metric-source-list" aria-label="${escapeHtml(ariaLabel)}">
      ${rows.map((row) => `
        <span class="metric-source-chip">${escapeHtml(row.label)} ${escapeHtml(row.count)}</span>
      `).join('')}
    </div>
  `;
}

function buildSubscriptionCards(baseUrl) {
  return SUBSCRIPTION_FORMATS.map((title) => ({
    title,
    url: title === 'Clash' ? baseUrl : `${baseUrl}?format=${encodeURIComponent(title.toLowerCase().replaceAll(' ', '-'))}`
  }));
}

function buildSourceRows(profile) {
  return Object.entries(profile.sources).map(([name, source], index) => ({
    name,
    primary: index === 0,
    enabled: Boolean(source.enabled),
    url: source.url ?? '',
    key: source.key ?? ''
  }));
}

function buildSourceMetricRows(profile, sourceCounts = {}, countKey = 'raw_links') {
  const sourceNames = new Set([
    ...Object.keys(profile.sources ?? {}),
    ...Object.keys(sourceCounts ?? {})
  ]);
  const hasRequestedValues = countKey === 'raw_links'
    || Object.values(sourceCounts ?? {}).some((counts) => counts && countKey in counts);
  if (!hasRequestedValues) {
    return [];
  }
  return Array.from(sourceNames)
    .sort((left, right) => {
      const leftIndex = SOURCE_DISPLAY_ORDER.indexOf(left);
      const rightIndex = SOURCE_DISPLAY_ORDER.indexOf(right);
      return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
    })
    .map((name) => ({
      name,
      label: SOURCE_NAMES[name] || name,
      count: Number(sourceCounts[name]?.[countKey] ?? 0)
    }));
}

export function extractSourceUrlFromCurl(value = '') {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }
  if (!/^curl(?:\s|$)/i.test(text)) {
    return text;
  }

  const quoted = text.match(/(['"])(https?:\/\/[\s\S]+?)\1/i);
  if (quoted?.[2]) {
    return quoted[2].trim();
  }

  const bare = text.match(/\bhttps?:\/\/[^\s'"]+/i);
  return bare?.[0]?.trim() ?? '';
}

export function buildRegionStats(nodeRows = []) {
  const counts = new Map();
  for (const row of nodeRows) {
    const region = inferNodeRegion(row?.name);
    counts.set(region, (counts.get(region) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([region, count]) => ({ region, count }));
}

export function buildSourceIterationDraft(sources = {}) {
  const firstSource = Object.values(sources)[0] ?? {};
  return {
    sources: structuredClone(sources),
    maxIterations: coercePositiveInteger(firstSource.max_iterations, 40),
    areaMin: coerceAreaValue(firstSource.area_min, 0),
    areaMax: coerceAreaValue(firstSource.area_max, 100)
  };
}

export function buildAvailabilityTargetDraft(targets = {}) {
  return {
    targets: Object.entries(targets).map(([name, target]) => ({
      name,
      url: target?.url ?? '',
      enabled: target?.enabled !== false
    }))
  };
}

export function addAvailabilityTargetDraft(draft, preferredName = 'custom') {
  if (!draft?.targets) {
    return;
  }
  const existing = new Set(draft.targets.map((target) => target.name));
  let name = sanitizeTargetName(preferredName) || 'custom';
  let index = 2;
  while (existing.has(name)) {
    name = `${sanitizeTargetName(preferredName) || 'custom'}-${index}`;
    index += 1;
  }
  draft.targets.push({
    name,
    url: '',
    enabled: true
  });
}

export function removeAvailabilityTargetDraft(draft, index) {
  if (!draft?.targets) {
    return;
  }
  draft.targets.splice(Number(index), 1);
}

export function applyAvailabilityTargetDraft(draft = {}) {
  const result = {};
  for (const target of draft.targets ?? []) {
    const name = sanitizeTargetName(target.name);
    const url = String(target.url ?? '').trim();
    if (!name || !url) {
      continue;
    }
    result[name] = {
      url,
      enabled: target.enabled !== false
    };
  }
  return result;
}

export function applySourceIterationDraft(sources = {}, draft = {}) {
  const maxIterations = coercePositiveInteger(draft.maxIterations, 40);
  const areaMin = coerceAreaValue(draft.areaMin, 0);
  const areaMax = coerceAreaValue(draft.areaMax, 100);
  return Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      {
        ...source,
        max_iterations: maxIterations,
        min_iterations: Math.min(coercePositiveInteger(source.min_iterations, 0), maxIterations),
        area_min: Math.min(areaMin, areaMax),
        area_max: Math.max(areaMin, areaMax)
      }
    ])
  );
}

function inferNodeRegion(name = '') {
  const normalized = String(name).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const match = normalized.match(/^([A-Z]{2})(?:\b|[\s_-])/);
  return match ? match[1] : '其他';
}

function coercePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function coerceAreaValue(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function buildLogRows(displayLogs) {
  return displayLogs.slice(-28).map((entry) => ({
    ...entry,
    levelClass: entry.level === 'error' ? 'danger' : entry.level === 'warning' ? 'warning' : 'success'
  }));
}

function renderLogRows(rows) {
  if (!rows.length) {
    return '<div class="empty-state log-empty-state">暂无可显示日志</div>';
  }
  return rows.map((row) => `<div class="log-line ${row.levelClass}">${escapeHtml(row.line)}</div>`).join('');
}

function renderLogGroups(groups) {
  if (!groups.length) {
    return '<div class="empty-state log-empty-state">暂无可显示日志</div>';
  }
  return groups.map((group) => `
    <section class="log-group">
      <div class="log-group-title">${escapeHtml(group.label)}</div>
      ${group.rows.map((row) => `<div class="log-line ${row.levelClass}">${escapeHtml(row.line)}</div>`).join('')}
    </section>
  `).join('');
}

export function classifyLogEntry(rawEntry, overrides = {}) {
  if (rawEntry && typeof rawEntry === 'object' && 'line' in rawEntry && 'level' in rawEntry) {
    return {
      ...rawEntry,
      level: rawEntry.level ?? inferLogLevel(rawEntry.line),
      stage: rawEntry.stage ?? inferLogStage(rawEntry.line),
      kind: rawEntry.kind ?? 'log'
    };
  }

  const line = String(rawEntry ?? '');
  return {
    line,
    level: overrides.level ?? inferLogLevel(line),
    stage: overrides.stage ?? inferLogStage(line),
    kind: overrides.kind ?? 'log'
  };
}

export function filterLogEntries(entries, filter = '全部') {
  if (filter === '错误') {
    return entries.filter((entry) => entry.level === 'error');
  }
  if (filter === '运行日志') {
    return entries.filter((entry) => entry.level !== 'error');
  }
  return entries;
}

export function groupLogEntriesByStage(entries) {
  const groups = new Map();
  for (const row of buildLogRows(entries)) {
    const label = row.stage || '其他';
    if (!groups.has(label)) {
      groups.set(label, { label, rows: [] });
    }
    groups.get(label).rows.push(row);
  }
  return Array.from(groups.values());
}

function inferLogLevel(line) {
  const lower = String(line).toLowerCase();
  if (/\[error\]|error|failed|exception|traceback|错误|失败/.test(lower)) {
    return 'error';
  }
  if (/\[warn\]|warning|警告/.test(lower)) {
    return 'warning';
  }
  return 'info';
}

function inferLogStage(line) {
  const lower = String(line).toLowerCase();
  const stages = ['doctor', 'extract', 'dedupe', 'speedtest', 'availability', 'postprocess', 'render', 'obfuscate', 'deploy', 'verify'];
  const matches = stages.filter((stage) => lower.includes(stage));
  return matches.at(-1) ?? '';
}

function mergeProfile(profile) {
  const workspace = profile?.workspace ?? {};
  const paths = profile?.paths ?? {};
  const mergedPaths = {
    ...FALLBACK_PROFILE.paths,
    ...workspace,
    ...paths
  };

  return {
    ...FALLBACK_PROFILE,
    ...profile,
    sources: profile?.sources ?? FALLBACK_PROFILE.sources,
    availability_targets: profile?.availability_targets ?? DEFAULT_AVAILABILITY_TARGETS,
    speed_test: { ...FALLBACK_PROFILE.speed_test, ...(profile?.speed_test ?? {}) },
    deploy: { ...FALLBACK_PROFILE.deploy, ...(profile?.deploy ?? {}) },
    paths: mergedPaths,
    workspace: mergedPaths
  };
}

function enabledAvailabilityTargetCount(targets = {}) {
  return Object.values(targets).filter((target) => target?.enabled !== false).length;
}

function normalizeEditableList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return splitEditableList(value);
}

function splitEditableList(value) {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeTargetName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stateClass(status) {
  if (status === 'success') return 'success';
  if (status === 'running') return 'warning';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function stageLabel(status) {
  return {
    success: '完成',
    running: '运行中',
    failed: '失败',
    pending: '等待中'
  }[status] ?? status;
}

function deriveRetryStageOptions(artifact) {
  if (!artifact?.retryable_stages) {
    return [];
  }
  return RETRY_STAGE_ORDER.filter((stage) => artifact.retryable_stages.includes(stage));
}

function formatRetryArtifactLabel(item) {
  const suffix = item.retry_context?.source_artifact_name ? ' · retry' : '';
  return `${item.artifact_name} · ${runStatusLabel(item.run_status)}${suffix}`;
}

function runStatusLabel(status) {
  return {
    success: '成功',
    failed: '失败',
    running: '运行中',
    pending: '待执行',
    unknown: '未知'
  }[status || 'unknown'] ?? status ?? '未知';
}

function resolveCurrentStatusLabel(state, messages) {
  if (state.runResult === 'success' || state.runResult === 'demo') return '成功';
  if (state.runResult === 'failed') return '失败';
  if (state.runState === 'running') return '运行中';
  return '空闲';
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value)).replaceAll('/', '-');
}

function formatElapsed(startedAt) {
  if (!startedAt) return '—';
  const total = Math.max(0, Math.floor((Date.now() - Number(startedAt)) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `00:${minutes}:${seconds}`;
}

function resolveCurrentTaskLabel(state, messages) {
  const stageRows = normalizeStageRows(state.stageStatus, state.runState);
  const running = stageRows.find((row) => row.status === 'running');
  if (running) return messages.stageLabels[running.name] ?? running.name;

  const failed = stageRows.find((row) => row.status === 'failed');
  if (failed) {
    return `${messages.stageLabels[failed.name] ?? failed.name} / ${messages.statusLabels.failed}`;
  }

  if (state.runState === 'stopping') return '停止中';

  const completed = stageRows.filter((row) => row.status === 'success');
  if (completed.length) {
    const lastStage = completed.at(-1);
    return messages.stageLabels[lastStage.name] ?? lastStage.name;
  }

  return messages.taskWaiting;
}

function navId(page) {
  return `nav${page.slice(0, 1).toUpperCase()}${page.slice(1)}`;
}
