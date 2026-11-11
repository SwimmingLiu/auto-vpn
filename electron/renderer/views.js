import { buildStageModel, PAGE_INDEX, PAGE_ORDER, resolveRunControlState } from './state.js';
import { icon } from './icons.js';

// Legacy round defaults, kept for a row that carries no lap key. A round
// advances a cursor over that brand's fixed area list and pulls
// `areas_per_round` ids, so the count is per platform and per round. The drawer
// no longer edits these; lap mode below is what it shows.
export const SOURCE_ROUND_DEFAULTS = {
  max_iterations: 200,
  plateau_limit: 50,
  areas_per_round: 8,
  area_concurrency: 4
};
export const SOURCE_ROUND_LIMITS = {
  max_iterations: [1, Number.POSITIVE_INFINITY],
  plateau_limit: [1, Number.POSITIVE_INFINITY],
  areas_per_round: [1, 64],
  area_concurrency: [1, 16]
};
// Lap mode: one lap asks every area on the vendor's frozen list exactly once,
// so the drawer only asks for laps and concurrency — no round/area conversion.
export const SOURCE_LAP_DEFAULTS = {
  max_laps: 50,
  dry_laps: 13
};
// Used only to seed a legacy row and to estimate before the first run has
// measured the list; the pipeline itself never reads this number.
export const REFERENCE_AREA_COUNT = 31;
export const NETWORK_DEFAULTS = {
  proxy_mode: 'proxy',
  proxy_url: 'http://127.0.0.1:7897'
};

const FALLBACK_PROFILE = {
  sources: {
    leiting: { mode: 'credential', official_site: 'https://www.68123836.com', enabled: true, ...SOURCE_ROUND_DEFAULTS },
    heidong: { mode: 'credential', official_site: 'https://www.67986457.com', enabled: true, ...SOURCE_ROUND_DEFAULTS },
    mifeng: { mode: 'credential', official_site: 'https://www.86933221.com', enabled: true, ...SOURCE_ROUND_DEFAULTS },
    xuanfeng: { mode: 'credential', official_site: 'https://www.16863988.com', enabled: true, ...SOURCE_ROUND_DEFAULTS }
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

// SVGs retain the same geometry across installed fonts and theme modes.

const PAGE_STATUS = {
  dashboard: ['', 'neutral'],
  runs: ['', 'neutral'],
  results: ['', 'neutral'],
  subscriptions: ['', 'neutral'],
  logs: ['', 'neutral'],
  settings: ['', 'neutral']
};

const LOG_FILTERS = ['全部', '运行日志', '错误', '按阶段'];
const EMPTY_COUNTS = {
  raw_links: 0,
  deduped_links: 0,
  speedtest_links: 0,
  availability_links: 0,
  postprocess_links: 0
};

const SOURCE_DISPLAY_ORDER = ['leiting', 'heidong', 'mifeng', 'xuanfeng'];
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
  const displayLogs = (state.logEntries ?? []).map((entry, index) => ({
    logId: entry?.logId ?? `history-${index}`,
    ...classifyLogEntry(entry)
  }));
  const logFilter = state.logFilter ?? '全部';
  const filteredLogs = filterLogEntries(displayLogs, logFilter);
  const logWindow = selectLogWindow(filteredLogs, state.logView);
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
    qr: state.qr ?? { status: state.qrDataUrl ? 'success' : 'idle', dataUrl: state.qrDataUrl ?? '', message: '' },
    displayLogs,
    logFilter,
    logView: state.logView ?? { follow: true, unseenCount: 0, clearedSnapshot: null },
    logRows: buildLogRows(logWindow, false),
    logGroups: groupLogEntriesByStage(logWindow, false),
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
    sourceRows: buildSourceRows(profile),
    sourceCounts,
    extractProgress: Object.values(state.extractProgress ?? {}),
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
    runOptions: state.runOptions ?? {},
    activity: state.activity ?? [],
    activityUnavailable: state.activityUnavailable ?? 0,
    runState: state.runState ?? 'idle',
    statusItems: buildStatusItems(state, messages),
    currentStatusLabel: resolveCurrentStatusLabel(state, messages),
    currentTaskLabel: resolveCurrentTaskLabel(state, messages),
    runStateLabel: messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle,
    runStateTone: runStateTone(state.runState),
    settingsDrawer: state.settingsDrawer ?? null,
    accountPool: {
      ...EMPTY_ACCOUNT_POOL,
      ...(state.accountPool ?? {}),
      recordsMarkup: buildAccountPoolRecords({ ...EMPTY_ACCOUNT_POOL, ...(state.accountPool ?? {}) })
    },
    modalTransform: state.modalTransform ?? '',
    runtime: state.runtime ?? 'electron',
    themePreference: state.themePreference ?? 'system'
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
      aria-label="${escapeHtml(messages.nav[page])}"
      title="${escapeHtml(messages.nav[page])}"
      type="button"
      ${activePage === page ? 'aria-current="page"' : ''}
    >
      <span class="nav-icon">${icon(page)}</span>
      <span class="nav-copy">${escapeHtml(messages.nav[page])}</span>
    </button>
  `).join('');
}

// Run actions belong to the state they affect; names remain available to
// assistive technology and tooltips without repeating visible button text.
function buildRunControls(vm, mobile = false) {
  return `<div class="run-icon-controls ${mobile ? 'mobile-run-bar' : ''}" ${mobile ? 'data-mobile-run-bar' : ''}>
    <button class="btn btn-primary icon-only" data-run-action="start" type="button" aria-label="立即运行" title="立即运行" ${vm.runControlState.runDisabled ? 'disabled' : ''}>${icon('play')}</button>
    <button class="btn btn-secondary icon-only" data-run-action="stop" type="button" aria-label="停止运行" title="停止运行" ${vm.runControlState.stopDisabled ? 'disabled' : ''}>${icon('stop')}</button>
  </div>`;
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
    <section ${activePage === 'runs' ? 'id="runsWorkspace"' : ''} class="page-shell" data-page-shell="${activePage}">
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
    case 'logs':
      return buildLogsPage(vm, messages);
    default:
      return buildSettingsPage(vm, messages);
  }
}

// Page construction and live updates share the same current-run state;
// a retained artifact is never evidence that the active run succeeded.
export function resolveDashboardRunSummary(vm) {
  return { isRunning: vm.runControlState?.isBusy === true, failed: vm.runState === 'failed' || vm.runStateTone === 'danger' };
}

export function buildDashboardStateMarkup(vm) {
  const { failed } = resolveDashboardRunSummary(vm);
  return `<h3>${escapeHtml(vm.currentStatusLabel)}</h3>${failed ? '<p>运行失败，可在日志中查看原因</p><button class="btn btn-secondary small" data-page-target="logs" type="button">查看日志</button>' : ''}`;
}

function buildDashboardPage(vm, messages) {
  const { isRunning } = resolveDashboardRunSummary(vm);
  return `
    <div id="dashboardOverview" class="page-grid dashboard-grid">
      <article class="panel wide-panel status-hero-card ${isRunning ? 'is-running' : ''}" data-run-state="${escapeHtml(vm.hasResult ? 'result' : 'empty')}">
        <div class="dashboard-state-copy">${buildDashboardStateMarkup(vm)}</div>
        ${buildRunControls(vm)}
      </article>

      ${buildDashboardMetricsMarkup(vm)}

      <div id="dashboardAnalytics" class="wide-panel"></div>
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
    <div class="page-grid runs-grid">
      <article class="panel wide-panel run-control-panel">
        <details class="run-secondary-controls">
          <summary>${vm.retryArtifacts.length ? '重试与运行选项' : '运行选项'}</summary>
          ${vm.retryArtifacts.length ? `<div class="retry-control-card">
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
          </div>
          ` : ''}
          <div class="run-options">
          ${[
            ['跳过部署', 'skipDeploy', false],
            ['跳过验证', 'skipVerify', false],
            ['保存配置后运行', 'saveBeforeRun', true]
          ].map(([label, key, checked]) => `
            <label class="checkbox-chip"><input data-run-option="${escapeHtml(key)}" type="checkbox" ${(vm.runOptions[key] ?? checked) ? 'checked' : ''} />${escapeHtml(label)}</label>
          `).join('')}
          </div>
        </details>
      </article>

      ${buildRunsStageProgressMarkup(vm)}
      ${buildRunsCurrentStageMarkup(vm)}
    </div>
  `;
}

export function buildRunsStageProgressMarkup(vm) {
  return `
    <article id="runsStageProgress" class="panel timeline-panel">
      <div class="panel-headline"><h3>阶段进度</h3></div>
      <div class="timeline" tabindex="0" role="region" aria-label="流水线阶段">
        ${vm.stageRows.map((stage) => `
          <div class="timeline-row">
            <span class="timeline-index ${stage.status}"></span>
            <span class="timeline-copy">${escapeHtml(stage.name)}</span>
            <span class="inline-state ${stateClass(stage.status)}">${escapeHtml(stageLabel(stage.status))}</span>
          </div>
          ${stage.name === 'extract' && vm.extractProgress?.length ? `<div class="timeline-substeps">${vm.extractProgress.map((step) => `<div class="timeline-substep"><span>${escapeHtml(SOURCE_NAMES[step.source] ?? step.source)} · ${escapeHtml(step.platform)} · ${escapeHtml({ apk_download: 'APK 下载', apk_analysis: 'APK 解析', domain_discovery: '域名探测' }[step.substage])}</span><span class="inline-state ${step.status === 'cached' ? 'neutral' : stateClass(step.status)}">${step.status === 'cached' ? '缓存' : escapeHtml(stageLabel(step.status))}</span></div>`).join('')}</div>` : ''}
        `).join('')}
      </div>
    </article>
  `;
}

export function buildRunsCurrentStageMarkup(vm) {
  return `
    <article id="runsCurrentStage" class="panel">
      <div class="panel-headline run-stage-heading"><h3>当前阶段</h3>${renderBadge(stageLabel(vm.currentStage.status), stateClass(vm.currentStage.status))}</div>
      <div data-current-stage-body>
      <div class="key-value-list">
        <div class="key-value-row"><span>阶段</span><strong>${escapeHtml(vm.currentStage.name)}</strong></div>
        <div class="key-value-row"><span>开始时间</span><strong>${escapeHtml(vm.runStartedAt)}</strong></div>
        <div class="key-value-row"><span>已耗时</span><strong>${escapeHtml(vm.runElapsed)}</strong></div>
        <div class="key-value-row"><span>当前目标</span><strong>${escapeHtml(vm.currentStage.name === 'speedtest' ? '测速通过节点' : '流水线处理')}</strong></div>
      </div>
      </div>
    </article>
  `;
}

function buildResultsPage(vm, messages) {
  const deployStage = vm.stageRows.find((row) => row.name === 'deploy');
  const verifyStage = vm.stageRows.find((row) => row.name === 'verify');
  return `
    <div id="resultsWorkspace" class="page-grid results-grid">
      ${buildSubscriptionPanel(vm)}
      <!-- Keep the artifact identity beside its actions without an introductory heading. -->
      <article class="panel wide-panel artifact-card">
        <div>
          <span class="sr-only">最终节点来源</span>
          <strong class="mono">${escapeHtml(vm.artifactDir || '暂无')}</strong>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-secondary icon-only" data-action="copy-nodes" type="button" aria-label="复制节点" title="复制节点">${icon('copy')}</button>
          ${vm.runtime === 'web' ? '' : `<button class="btn btn-secondary icon-only" data-action="open-artifact-dir" type="button" aria-label="打开目录" title="打开目录">${icon('folder')}</button>`}
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
        <div class="panel-headline node-list-heading"><h3 class="sr-only">最终节点列表</h3><span class="panel-subcopy">${escapeHtml(vm.nodeRows.length)} 个节点</span></div>
        <div id="resultNodePreview" class="table-wrap">
          <table class="data-table decoded-node-table" data-column-table="nodes">
            <thead><tr><th>#</th><th>节点名称</th><th>IP地址</th><th>协议</th><th>path</th></tr></thead>
            <tbody>
              ${vm.nodeRows.length ? vm.nodeRows.map((row, index) => `
                <tr>
                  <td><span class="node-card-field">序号</span><span>${index + 1}</span></td>
                  <td><span class="node-card-field">节点名称</span><span>${escapeHtml(row.name || '—')}</span></td>
                  <td><span class="node-card-field">IP地址</span><span>${escapeHtml(row.address || '—')}</span></td>
                  <td><span class="node-card-field">协议</span><span>${escapeHtml(row.protocol || '—')}</span></td>
                  <td class="mono"><span class="node-card-field">path</span><span>${escapeHtml(row.path || '—')}</span></td>
                </tr>
              `).join('') : '<tr><td colspan="5">暂无节点，运行完成后显示。</td></tr>'}
            </tbody>
          </table>
        </div>
      </article>
      <!-- Low-frequency deployment paths used to bury the node comparison table. -->
      <details class="panel wide-panel result-details" ${deployStage?.status === 'failed' || verifyStage?.status === 'failed' ? 'open' : ''}>
        <summary>部署详情 ${renderBadge(stageLabel(deployStage?.status || 'pending'), stateClass(deployStage?.status || 'pending'))}</summary>
        <div class="key-value-list">
          <div class="key-value-row"><span>项目名称</span><strong>${escapeHtml(vm.deployment.project_name || '—')}</strong></div>
          <div class="key-value-row"><span>Pages 地址</span><strong class="mono">${escapeHtml(vm.deployment.pages_project_url || '—')}</strong></div>
          <div class="key-value-row"><span>入口文件</span><strong class="mono">${escapeHtml(vm.deployment.worker_entry || '—')}</strong></div>
          <div class="key-value-row"><span>Manifest</span><strong class="mono">${escapeHtml(vm.deployment.module_manifest_path || '—')}</strong></div>
          <div class="key-value-row"><span>deploy 状态</span><strong>${escapeHtml(stageLabel(deployStage?.status || 'pending'))}</strong></div>
          <div class="key-value-row"><span>verify 状态</span><strong>${escapeHtml(stageLabel(verifyStage?.status || 'pending'))}</strong></div>
        </div>
      </details>

      <details class="panel wide-panel result-details"><summary>区域统计</summary>
        <div class="region-stat-grid">
          ${vm.regionStats.length ? vm.regionStats.map((item) => `
            <div class="region-stat-card">
              <span>${escapeHtml(item.region)}</span>
              <strong>${escapeHtml(item.count)}</strong>
            </div>
          `).join('') : '<div class="empty-state">暂无区域统计，运行完成后显示。</div>'}
        </div>
      </details>

    </div>
  `;
}

// Results contain the one canonical subscription. QR is an object action,
// rather than a second navigation destination with a large permanent card.
function buildSubscriptionPanel(vm) {
  return `<article id="subscriptionCards" class="panel wide-panel results-subscription-card">
    <div class="subscription-primary mono">${escapeHtml(vm.subscriptionUrl)}</div>
    <div class="subscription-actions">
      <button class="btn btn-primary icon-only" data-copy-text="${escapeHtml(vm.subscriptionUrl)}" type="button" aria-label="复制链接" title="复制链接">${icon('copy')}</button>
      <button class="btn btn-secondary icon-only" data-open-url="${escapeHtml(vm.subscriptionUrl)}" type="button" aria-label="打开订阅" title="打开订阅">${icon('external')}</button>
      <details class="subscription-qr"><summary class="icon-btn" aria-label="订阅二维码" title="订阅二维码">${icon('qr')}</summary><div class="subscription-qr-panel">${renderQr(vm.qr)}</div></details>
    </div>
  </article>`;
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
                aria-pressed="${vm.logFilter === filter ? 'true' : 'false'}"
                type="button"
              >${escapeHtml(filter)}</button>
            `).join('')}
          </div>
          <div class="toolbar-right">
            <div class="log-utility-actions">
              <button class="btn btn-secondary small icon-only" data-action="copy-log" type="button" aria-label="复制日志" title="复制日志">${icon('copy')}</button>
              ${vm.runtime === 'web' ? '' : `<button class="btn btn-secondary small icon-only" data-action="open-log-file" type="button" aria-label="打开日志文件" title="打开日志文件">${icon('folder')}</button>`}
            </div>
            <div class="log-destructive-actions">
              <button class="btn btn-secondary small icon-only" data-action="clear-log" type="button" aria-label="清空显示" title="清空显示">${icon('trash')}</button>
            </div>
            <div class="log-state-actions">${buildLogStateActions(vm)}</div>
          </div>
        </div>
        <div id="logCenterTable" class="terminal-output log-stream" role="log" aria-live="polite">
          ${buildLogCenterMarkup(vm)}
        </div>
      </article>
    </div>
  `;
}

// Transient log actions share the existing toolbar, so appearing feedback
// never shifts the stream or covers a log line being read.
export function buildLogStateActions(vm) {
  const label = `回到底部 · ${vm.logView.unseenCount} 条新消息`;
  return `${!vm.logView.follow && vm.logView.unseenCount > 0 ? `<button class="btn btn-primary small icon-only" data-log-jump-latest type="button" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon('download')}</button>` : ''}${vm.logView.clearedSnapshot ? `<button class="btn btn-secondary small icon-only" data-log-undo-clear type="button" aria-label="撤销清空" title="撤销清空">${icon('refresh')}</button>` : ''}`;
}

export function buildLogCenterMarkup(vm) {
  return vm.logFilter === '按阶段' ? renderLogGroups(vm.logGroups) : renderLogRows(vm.logRows);
}

function buildSettingsPage(vm, messages) {
  // The entries already identify their editor. Repeated instructions used to
  // push the account tools below the first viewport.
  return `
    <div id="settingsWorkspace" class="page-grid settings-grid">
      <article class="panel wide-panel settings-overview-panel">
        <div class="settings-overview-grid">
          ${buildSettingsCard('sources', '数据源配置', `${vm.sourceRows.filter((row) => row.enabled).length} / ${vm.sourceRows.length} 个官网 · 双端并发`)}
          ${buildSettingsCard('speed_test', '测速配置', `最低 ${vm.profile.speed_test.min_download_mb_s} MB/s · 并发 ${vm.profile.speed_test.concurrency}`)}
          ${buildSettingsCard('availability_targets', 'AI可达性检测', `已启用 ${enabledAvailabilityTargetCount(vm.profile.availability_targets)} / ${Object.keys(vm.profile.availability_targets ?? {}).length} 个网站`)}
          ${buildSettingsCard('deploy', '部署配置', `项目 ${vm.profile.deploy.project_name || '未设置'}`)}
          ${buildSettingsCard('network', '网络出口', networkSummary(vm.profile.network))}
        </div>
      </article>

      <article class="panel wide-panel appearance-panel">
        <h3>${icon('sun')}外观</h3>
        <div class="theme-choices" role="group" aria-label="界面主题">
          ${[['system', 'monitor', '跟随系统'], ['light', 'sun', '浅色'], ['dark', 'moon', '深色']].map(([value, glyph, label]) => `<button class="theme-choice" type="button" data-theme-choice="${value}" aria-pressed="${vm.themePreference === value}">${icon(glyph)}${label}</button>`).join('')}
        </div>
      </article>

      ${buildAccountPoolPanel(vm)}
      ${buildSettingsDrawer(vm)}
    </div>
  `;
}

export function filterAccountPoolAccounts(pool = {}) {
  const query = String(pool.query ?? '').trim().toLowerCase();
  const status = pool.statusFilter ?? 'all';
  const brand = pool.brandFilter ?? 'all';
  const rows = (pool.accounts ?? []).filter((account) => {
    if (status !== 'all' && account.status !== status) return false;
    if (brand !== 'all' && account.brand !== brand) return false;
    if (!query) return true;
    return [account.account_masked, account.note, account.status_reason, SOURCE_NAMES[account.brand]]
      .some((value) => String(value ?? '').toLowerCase().includes(query));
  });
  const sortBy = pool.sortBy ?? 'brand';
  return rows.sort((left, right) => {
    if (sortBy === 'recent') return String(right.last_used_at || '').localeCompare(String(left.last_used_at || '')) || left.id - right.id;
    if (sortBy === 'uses') return Number(right.use_count ?? 0) - Number(left.use_count ?? 0) || left.id - right.id;
    if (sortBy === 'expiry') return String(left.expires_at || '9999').localeCompare(String(right.expires_at || '9999')) || left.id - right.id;
    return String(left.brand).localeCompare(String(right.brand)) || left.id - right.id;
  });
}

export function buildAccountPoolRecords(pool = EMPTY_ACCOUNT_POOL) {
  if (pool.status === 'loading') {
    return '<div class="account-pool-empty" role="status">正在读取账号池…</div>';
  }
  if (pool.status === 'error' || pool.status === 'unavailable') {
    return `<div class="account-pool-empty" role="alert">${escapeHtml(pool.error || '账号池不可用')}</div>`;
  }
  const rows = filterAccountPoolAccounts(pool);
  if (rows.length === 0) {
    const hasAny = (pool.accounts ?? []).length > 0;
    return `<div class="account-pool-empty">${hasAny ? '没有匹配的账号' : '暂无账号，上传 CSV 后可用。'}</div>`;
  }
  return `
    <div class="table-wrap account-pool-table-wrap">
      <table class="data-table account-pool-table" data-column-table="accounts">
        <colgroup>
          <col class="account-col-account" />
          <col class="account-col-brand" />
          <col class="account-col-status" />
          <col class="account-col-expiry" />
          <col class="account-col-usage" />
          <col class="account-col-actions" />
        </colgroup>
        <thead><tr><th>账号</th><th>加速器</th><th>状态</th><th>到期</th><th>使用</th><th>操作</th></tr></thead>
        <tbody>
          ${rows.map((account) => {
            const meta = ACCOUNT_STATUS_META[account.status] ?? { label: account.status, tone: 'neutral' };
            const retired = account.status !== 'active';
            const expiry = String(account.expires_at ?? '').trim();
            const editingExpiry = pool.canSetExpiry && Number(pool.expiryEditorId) === Number(account.id);
            return `
              <tr data-account-row="${account.id}">
                <td data-field-label="账号"><code class="account-mask">${escapeHtml(account.account_masked)}</code>${account.note ? `<span class="account-note">${escapeHtml(account.note)}</span>` : ''}</td>
                <td data-field-label="加速器">${escapeHtml(SOURCE_NAMES[account.brand] ?? account.brand)}</td>
                <td data-field-label="状态">${renderBadge(meta.label, meta.tone)}${account.status_reason ? `<span class="account-note">${escapeHtml(account.status_reason)}</span>` : ''}</td>
                <td data-field-label="到期">
                  <span class="account-expiry-value ${expiry ? '' : 'unknown'}">${escapeHtml(expiry || '未知')}</span>
                  ${pool.canSetExpiry ? (editingExpiry
                    ? `<div class="account-expiry-editor">
                        <input type="date" aria-label="${escapeHtml(account.account_masked)}：到期日期" data-account-expiry-input="${account.id}" value="${escapeHtml(expiry.slice(0, 10))}" ${pool.busy ? 'disabled' : ''} />
                        <button class="btn btn-primary small" data-account-action="expiry-save" data-account-id="${account.id}" type="button" ${pool.busy ? 'disabled' : ''}>保存</button>
                        <button class="btn btn-secondary small" data-account-action="expiry-cancel" data-account-id="${account.id}" type="button" ${pool.busy ? 'disabled' : ''}>取消</button>
                      </div>`
                    : `<button class="btn btn-secondary small account-expiry-edit" data-account-action="expiry-edit" data-account-id="${account.id}" type="button" ${pool.busy ? 'disabled' : ''}>${expiry ? '改期' : '设置到期'}</button>`)
                    : ''}
                </td>
                <td data-field-label="使用"><span class="account-usage">${Number(account.use_count ?? 0)} 次</span><span class="account-note">${Number(account.success_count ?? 0)} 成功 / ${Number(account.fail_count ?? 0)} 失败</span></td>
                <td data-field-label="操作"><button class="btn btn-secondary small ${retired ? '' : 'destructive'}" data-account-action="toggle" data-account-id="${account.id}" type="button" ${pool.busy ? 'disabled' : ''}>${retired ? '启用' : '停用'}</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p class="account-pool-count">显示 ${rows.length} / ${(pool.accounts ?? []).length} 个账号</p>
  `;
}

export function buildAccountPoolPanel(vm) {
  const pool = vm.accountPool ?? EMPTY_ACCOUNT_POOL;
  const stats = pool.stats ?? { total: 0, active: 0, disabled: 0, expired: 0, invalid: 0, expiring_soon: 0, by_brand: [] };
  const total = Number(stats.total ?? 0);
  const segments = ['active', 'disabled', 'expired', 'invalid'];
  const message = pool.message || (pool.status === 'error' ? pool.error : '');
  // A failed load must not render a wall of zeros: "0 可用 / 共 0 个" reads as a
  // real empty pool, and counts left over from the last good load read as a
  // successful refresh. Show the state instead and let the records area carry
  // the reason.
  const unavailable = pool.status === 'error' || pool.status === 'unavailable';
  const summary = unavailable
    ? ''
    : `
      <div class="account-pool-summary">
        <div class="account-pool-total">
          <strong>${Number(stats.active ?? 0)}</strong>
          <span>可用账号 / 共 ${total} 个</span>
        </div>
        <div class="account-pool-status-grid">
          ${segments.filter((status) => status !== 'active').map((status) => `
            <div class="account-pool-stat ${ACCOUNT_STATUS_META[status].tone}">
              <span>${ACCOUNT_STATUS_META[status].label}</span>
              <strong>${Number(stats[status] ?? 0)}</strong>
            </div>
          `).join('')}
        </div>
        ${Number(stats.expiring_soon ?? 0) > 0 ? `<p class="account-pool-expiry">7 天内到期 ${Number(stats.expiring_soon)} 个</p>` : ''}
        ${Number.isFinite(Number(stats.expiry_unknown)) && Number(stats.expiry_unknown) > 0 ? `<p class="account-pool-expiry unknown">到期时间未知 ${Number(stats.expiry_unknown)}</p>` : ''}
      </div>

      <div class="account-pool-toolbar">
        <label class="account-pool-search"><span class="sr-only">搜索</span><input data-account-search type="search" value="${escapeHtml(pool.query ?? '')}" placeholder="账号掩码或备注" /></label>
        <label><span class="sr-only">状态</span><select data-account-status-filter>
          <option value="all" ${pool.statusFilter === 'all' ? 'selected' : ''}>全部状态</option>
          ${segments.map((status) => `<option value="${status}" ${pool.statusFilter === status ? 'selected' : ''}>${ACCOUNT_STATUS_META[status].label}</option>`).join('')}
        </select></label>
        <label><span class="sr-only">加速器</span><select data-account-brand-filter>
          <option value="all" ${pool.brandFilter === 'all' ? 'selected' : ''}>全部加速器</option>
          ${SOURCE_DISPLAY_ORDER.map((brand) => `<option value="${brand}" ${pool.brandFilter === brand ? 'selected' : ''}>${SOURCE_NAMES[brand]}</option>`).join('')}
        </select></label>
        <label><span class="sr-only">排序</span><select data-account-sort>
          <option value="brand" ${pool.sortBy === 'brand' ? 'selected' : ''}>按加速器</option>
          <option value="recent" ${pool.sortBy === 'recent' ? 'selected' : ''}>最近使用</option>
          <option value="uses" ${pool.sortBy === 'uses' ? 'selected' : ''}>使用次数</option>
          <option value="expiry" ${pool.sortBy === 'expiry' ? 'selected' : ''}>到期时间</option>
        </select></label>
      </div>
    `;
  return `
    <article class="panel wide-panel account-pool-panel" id="accountPoolPanel" aria-busy="${pool.busy || pool.status === 'loading' ? 'true' : 'false'}">
      <div class="panel-headline account-pool-headline">
        <div>
          <h3>账号池</h3>
        </div>
        <div class="account-pool-actions">
          <button class="btn btn-secondary small icon-only" data-account-action="refresh" type="button" ${pool.busy ? 'disabled' : ''} aria-label="刷新账号池" title="刷新账号池">${icon('refresh')}</button>
          ${pool.canRefreshExpiry ? `<button class="btn btn-secondary small" data-account-action="refresh-expiry" type="button" ${pool.busy ? 'disabled' : ''} title="逐个登录账号池，读取真实会员到期日；已过期和非会员账号会被停用并退出轮换">${icon('shield')}${pool.refreshingExpiry ? '核对中…' : '核对会员到期'}</button>` : ''}
          <button class="btn btn-secondary small icon-only" data-account-action="template" type="button" ${pool.busy ? 'disabled' : ''} aria-label="下载模板" title="下载模板">${icon('download')}</button>
          <button class="btn btn-primary small" data-account-action="upload" type="button" ${pool.busy ? 'disabled' : ''}>${icon('upload')}${pool.busy ? '导入中…' : '上传 CSV'}</button>
          <input id="accountPoolFile" data-account-file type="file" accept=".csv,.txt,text/csv,text/plain" hidden aria-hidden="true" tabindex="-1" />
        </div>
      </div>

      ${summary}

      <div id="accountPoolRecords" class="account-pool-records">${pool.recordsMarkup ?? ''}</div>
      <p class="account-pool-message ${pool.issues?.length ? 'warning' : ''}" role="status" aria-live="polite" ${message || pool.issues?.length ? '' : 'hidden'}>
        ${escapeHtml(message)}${pool.issues?.length ? ` ${pool.issues.slice(0, 3).map((issue) => `第 ${escapeHtml(String(issue.line ?? ''))} 行：${escapeHtml(issue.message)}`).join('；')}${pool.issues.length > 3 ? `；另有 ${pool.issues.length - 3} 行` : ''}` : ''}
      </p>
    </article>
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

function buildSettingsCard(section, title, summary) {
  return `
    <button
      class="settings-overview-card"
      data-settings-card="${section}"
      type="button"
    >
      <span class="settings-card-icon">${icon(section)}</span>
      <span class="settings-card-copy"><span class="settings-card-kicker">${escapeHtml(title)}</span>
      <span class="settings-card-summary" id="settingsCardSummary-${section}">${escapeHtml(summary)}</span></span>
      ${icon('chevron', 'settings-card-arrow')}
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
    deploy: '部署配置',
    network: '网络出口'
  }[section] ?? '设置';

  const style = vm.modalTransform ? `style="transform: ${escapeHtml(vm.modalTransform)};"` : '';

  if (!isOpen) {
    return '<div id="settingsDrawer" class="settings-drawer-shell" data-open="false" data-section="" hidden inert></div>';
  }

  return `
    <div id="settingsDrawer" class="settings-drawer-shell" data-open="${isOpen ? 'true' : 'false'}" data-section="${escapeHtml(section)}">
      <button class="settings-drawer-backdrop" data-drawer-dismiss="backdrop" type="button" aria-label="关闭设置弹窗"></button>
      <aside data-settings-dialog role="dialog" aria-modal="true" aria-labelledby="settingsDrawerTitle" class="settings-drawer-panel" ${style}>
        <div class="settings-drawer-head">
          <div>
            <h3 id="settingsDrawerTitle">${escapeHtml(title)}</h3>
          </div>
          <button class="icon-btn settings-drawer-close" data-drawer-close="cancel" type="button" aria-label="关闭${escapeHtml(title)}" title="关闭${escapeHtml(title)}">${icon('close')}</button>
        </div>
        <div class="settings-drawer-body">
          ${isOpen ? buildSettingsDrawerBody(section, drawer.draft, vm) : ''}
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
  leiting: '雷霆',
  heidong: '黑洞',
  mifeng: '蜜蜂',
  xuanfeng: '旋风'
};

const LEGACY_SOURCE_ALIASES = {
  'xuanfeng-area': 'xuanfeng',
  'xuanfeng-all-area': 'xuanfeng',
  xuanfeng1: 'xuanfeng',
  xuanfeng2: 'xuanfeng'
};

const ACCOUNT_STATUS_META = {
  active: { label: '可用', tone: 'success' },
  disabled: { label: '停用', tone: 'neutral' },
  expired: { label: '到期', tone: 'warning' },
  invalid: { label: '失效', tone: 'danger' }
};

const EMPTY_ACCOUNT_POOL = {
  status: 'idle',
  stats: null,
  accounts: [],
  error: '',
  message: '',
  issues: [],
  query: '',
  statusFilter: 'all',
  brandFilter: 'all',
  sortBy: 'brand',
  busy: false,
  // Feature-detected from the preload bridge. The H5/browser build has no
  // setAccountExpiry, so the row simply omits the affordance there.
  canSetExpiry: false,
  canRefreshExpiry: false,
  refreshingExpiry: false,
  expiryEditorId: null
};

/** Credential sources are also configured by their official site. */
const OFFICIAL_SITES = {
  leiting: 'https://www.68123836.com',
  xuanfeng: 'https://www.16863988.com',
  heidong: 'https://www.67986457.com',
  mifeng: 'https://www.86933221.com'
};

function buildSettingsDrawerBody(section, draft, vm = null) {
  if (section === 'sources') {
    const sourceDraft = normalizeOfficialSourceDraft(draft?.sources ?? {});
    return `
      <details class="context-help"><summary>抓取与早停规则</summary>
      <div class="source-drawer-settings">
        <div class="source-drawer-settings-copy">
          <strong>每个加速器只填官网</strong>
          <span>密钥从 APK 自动发现，账号密码由账号池提供。Android 与 iOS 两个通道同时抓取；「遍数」由两端各自独立跑满，50 遍就是 Android 50 遍加 iOS 50 遍，不是 25+25。</span>
        </div>
        <div class="source-drawer-settings-copy">
          <span>每次运行先按该加速器的节点列表生成一份固定区域列表（去掉中国大陆与免费区域、去重、保持原顺序），运行中不再改变。一遍 = 把该加速器全部区域各请求一次（实测 雷霆 30 / 黑洞 31 / 蜜蜂 31 / 旋风 26）；一遍就是一轮，双端各自计遍。「同时请求数」控制一遍内同时发出的请求数量（默认 4），每遍分 ceil(区域数 ÷ 同时请求数) 批依次发出。</span>
        </div>
        <div class="source-drawer-settings-copy">
          <span>「空转早停」按连续没有新增节点的遍数计数：连续几遍一个新节点都没有，就提前停止该通道。是否为新节点按节点指纹判断（address / port / id / transport / host / path / tls / sni），并在 Android 与 iOS 之间统一去重：改名重复的节点、或另一端已经抓到的节点，都不会让计数归零。</span>
        </div>
      </div>
      </details>
      <div class="table-wrap">
        <table class="data-table settings-source-table">
          <colgroup>
            <col class="settings-col-enabled" />
            <col class="settings-col-name" />
            <col class="settings-col-connection" />
            <col class="settings-col-rounds" />
          </colgroup>
          <thead><tr><th>启用</th><th>加速器</th><th>官网</th><th>抓取</th></tr></thead>
          <tbody>
            ${SOURCE_DISPLAY_ORDER.map((name) => {
              const source = sourceDraft[name];
              const label = escapeHtml(SOURCE_NAMES[name] || name);
              const pool = vm?.accountPool?.stats?.by_brand?.find((item) => item.brand === name);
              const poolHint = vm?.accountPool?.stats
                ? `账号池 ${Number(pool?.active ?? 0)} 个可用`
                : '账号池未连接';
              return `
              <tr data-settings-field-group>
                <td data-field-label="启用"><input aria-label="${label}：启用" type="checkbox" data-drawer-source="${escapeHtml(name)}" data-drawer-key="enabled" ${source.enabled !== false ? 'checked' : ''} /></td>
                <td data-field-label="加速器">
                  <strong class="settings-source-name">${label}</strong>
                  <span class="settings-source-hint ${Number(pool?.active ?? 0) > 0 ? 'ready' : 'empty'}">${escapeHtml(poolHint)}</span>
                </td>
                <td data-field-label="官网">
                  <input aria-label="${label}：官网地址" inputmode="url" spellcheck="false" class="mono" data-drawer-source="${escapeHtml(name)}" data-drawer-key="official_site" placeholder="${escapeHtml(OFFICIAL_SITES[name] ?? '')}" value="${escapeHtml(source.official_site ?? '')}" />
                </td>
                <td data-field-label="抓取">
                  <div class="source-credential-rounds">
                    <label class="source-field">
                      <span>抓取遍数</span>
                      <input type="number" min="1" step="1" inputmode="numeric" aria-label="${label}：抓取遍数" title="Android 与 iOS 各自独立跑满该遍数（50 = 两端各 50 遍）；一遍把该加速器全部区域各请求一次" data-drawer-source="${escapeHtml(name)}" data-drawer-key="max_laps" value="${escapeHtml(source.max_laps ?? SOURCE_LAP_DEFAULTS.max_laps)}" />
                    </label>
                    <label class="source-field">
                      <span>空转早停（遍）</span>
                      <input type="number" min="1" step="1" inputmode="numeric" aria-label="${label}：空转早停（遍）" title="连续多少遍没有真正新增节点就停止该通道；节点指纹在双端之间统一去重" data-drawer-source="${escapeHtml(name)}" data-drawer-key="dry_laps" value="${escapeHtml(source.dry_laps ?? SOURCE_LAP_DEFAULTS.dry_laps)}" />
                    </label>
                    <label class="source-field">
                      <span>同时请求数</span>
                      <input type="number" min="1" max="16" step="1" inputmode="numeric" aria-label="${label}：同时请求数" title="一遍内同时发出的区域请求数量；每遍分 ceil(区域数 ÷ 同时请求数) 批依次发出" data-drawer-source="${escapeHtml(name)}" data-drawer-key="area_concurrency" value="${escapeHtml(source.area_concurrency ?? SOURCE_ROUND_DEFAULTS.area_concurrency)}" />
                    </label>
                  </div>
                  <span class="source-round-summary" data-source-estimate="${escapeHtml(name)}">${escapeHtml(buildSourceLapEstimate(source, vm?.sourceCounts?.[name]?.area_count))}</span>
                </td>
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <details class="context-help source-drawer-notice"><summary>账号与线路规则</summary>

        <p>登录被拒会把该账号标记为失效并停用，会员到期会按日期自动停用；更换密码后重新上传 CSV 即可恢复。抓取结果里免费线路和中国大陆线路会被跳过。</p>
      </details>
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
              <tr data-settings-field-group>
                <td data-field-label="启用"><input aria-label="${escapeHtml(formatAvailabilityName(target.name))}：启用" type="checkbox" data-availability-index="${index}" data-availability-key="enabled" ${target.enabled ? 'checked' : ''} /></td>
                <td data-field-label="名称"><input aria-label="${escapeHtml(formatAvailabilityName(target.name))}：名称" data-availability-index="${index}" data-availability-key="name" value="${escapeHtml(target.name ?? '')}" /></td>
                <td data-field-label="URL">
                  <textarea aria-label="${escapeHtml(formatAvailabilityName(target.name))}：URL" class="table-textarea mono" rows="3" data-availability-index="${index}" data-availability-key="url">${escapeHtml(target.url ?? '')}</textarea>
                </td>
                <td data-field-label="操作"><button class="btn btn-secondary small destructive icon-only" data-availability-action="remove" data-availability-index="${index}" type="button" aria-label="删除${escapeHtml(formatAvailabilityName(target.name))}" title="删除${escapeHtml(formatAvailabilityName(target.name))}">${icon('trash')}</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (section === 'deploy') {
    return `
      <details class="context-help">
        <summary>地址联动与验证规则</summary>
        <p>项目名变化会自动联动默认 Pages 地址；手动修改 URL 后，后续不再自动覆盖。verify 订阅地址用于 deploy 后的健康检查，不影响页面展示二维码。</p>
      </details>
      <div class="form-grid compact-form-grid">
        ${renderDrawerField('项目名称', 'text', draft.project_name, 'deploy.project_name')}
        ${renderDrawerField('最少节点数', 'number', draft.min_final_links ?? 10, 'deploy.min_final_links', false, 'min="0" step="1"')}
        ${renderDrawerField('Pages 地址', 'text', draft.pages_project_url, 'deploy.pages_project_url')}
        ${renderDrawerField('订阅地址', 'text', draft.subscription_url, 'deploy.subscription_url')}
        ${renderDrawerField('verify 订阅地址', 'text', draft.verify_subscription_url, 'deploy.verify_subscription_url')}
        ${renderDrawerField('Cloudflare Token', 'password', draft.cloudflare_api_token, 'deploy.cloudflare_api_token')}
        ${renderDrawerField('Pages Secret ADMIN', 'password', draft.pages_secret_admin, 'deploy.pages_secret_admin')}
      </div>
    `;
  }

  if (section === 'network') {
    const network = buildNetworkDraft(draft);
    return `
      <details class="context-help">
        <summary>出口与回退规则</summary>
        <p>代理：全程经 proxy_url 抓取，代理没在监听时自动改为直连；自动：先直连，遇到 IP 被封（403/429 或封锁页）后整轮改走代理；直连：不使用代理。默认走本机 127.0.0.1:7897。</p>
      </details>
      <div class="form-grid compact-form-grid network-form-grid">
        <label class="field compact">
          <span>出口模式</span>
          <select data-drawer-path="network.proxy_mode" aria-label="出口模式">
            ${[['proxy', '代理'], ['auto', '自动（被封后切代理）'], ['direct', '直连']].map(([value, label]) => `<option value="${value}" ${network.proxy_mode === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        ${renderDrawerField('代理地址', 'text', network.proxy_url, 'network.proxy_url', true, 'inputmode="url" spellcheck="false" placeholder="http://127.0.0.1:7897"')}
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

export function buildNetworkDraft(network = {}) {
  const mode = String(network?.proxy_mode ?? '').trim().toLowerCase();
  const url = String(network?.proxy_url ?? '').trim();
  return {
    proxy_mode: ['proxy', 'direct', 'auto'].includes(mode) ? mode : NETWORK_DEFAULTS.proxy_mode,
    proxy_url: url || NETWORK_DEFAULTS.proxy_url
  };
}

export function applyNetworkDraft(draft = {}) {
  const network = buildNetworkDraft(draft);
  return {
    proxy_mode: network.proxy_mode,
    proxy_url: network.proxy_url
  };
}

function networkSummary(network = {}) {
  const resolved = buildNetworkDraft(network);
  const modeLabel = { proxy: '代理', auto: '自动', direct: '直连' }[resolved.proxy_mode];
  return resolved.proxy_mode === 'direct' ? modeLabel : `${modeLabel} ${resolved.proxy_url}`;
}

function formatAvailabilityName(name) {
  const labels = { gemini: 'Gemini', chatgpt: 'ChatGPT', claude: 'Claude' };
  return labels[String(name ?? '').toLowerCase()] ?? String(name || '网站');
}

function renderDrawerField(label, type, value, path, isCompact = false, extraAttrs = '') {
  return `
    <label class="field ${isCompact ? 'compact' : ''} ${path.startsWith('deploy.') && (path.includes('url') || path.includes('token') || path.includes('secret')) ? 'field-wide' : ''}">
      <span>${escapeHtml(label)}</span>
      <input type="${type}" value="${escapeHtml(value ?? '')}" data-drawer-path="${escapeHtml(path)}" ${extraAttrs} />
    </label>
  `;
}

function renderBadge(text, tone, attributes = '') {
  return `<span class="badge ${tone}"${attributes ? ` ${attributes}` : ''}>${escapeHtml(text)}</span>`;
}

function renderQr(qr) {
  if (qr.status === 'success' && qr.dataUrl) {
    return `<img class="qr-image" alt="订阅二维码" src="${escapeHtml(qr.dataUrl)}" />`;
  }
  if (qr.status === 'loading' || qr.status === 'idle') {
    return '<div class="qr-loading" role="status">二维码生成中</div>';
  }
  if (qr.status === 'unavailable') {
    return '<div class="qr-status"><strong>当前环境不支持二维码生成</strong><span>请使用上方“复制链接”导入订阅。</span></div>';
  }
  return `<div class="qr-status" role="alert"><strong>${escapeHtml(qr.message || '二维码生成失败')}</strong><button class="btn btn-secondary small" data-action="retry-qr" type="button">重试生成</button></div>`;
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

function buildSourceRows(profile) {
  return Object.entries(profile.sources).map(([name, source], index) => ({
    name,
    label: SOURCE_NAMES[name] || name,
    primary: index === 0,
    enabled: source.enabled !== false,
    mode: 'credential',
    officialSite: source.official_site ?? '',
    maxIterations: Number(source.max_iterations ?? SOURCE_ROUND_DEFAULTS.max_iterations),
    plateauLimit: Number(source.plateau_limit ?? SOURCE_ROUND_DEFAULTS.plateau_limit),
    areasPerRound: Number(source.areas_per_round ?? SOURCE_ROUND_DEFAULTS.areas_per_round),
    areaConcurrency: Number(source.area_concurrency ?? SOURCE_ROUND_DEFAULTS.area_concurrency),
    maxLaps: Number(source.max_laps ?? SOURCE_LAP_DEFAULTS.max_laps),
    dryLaps: Number(source.dry_laps ?? SOURCE_LAP_DEFAULTS.dry_laps)
  }));
}

function buildSourceMetricRows(profile, sourceCounts = {}, countKey = 'raw_links') {
  const sourceNames = new Set([
    ...Object.keys(profile.sources ?? {}),
    ...Object.keys(sourceCounts ?? {})
  ]);
  return Array.from(sourceNames)
    .sort((left, right) => {
      const leftIndex = SOURCE_DISPLAY_ORDER.indexOf(left);
      const rightIndex = SOURCE_DISPLAY_ORDER.indexOf(right);
      return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
    })
    .map((name) => ({
      name,
      label: SOURCE_NAMES[name] || name,
      count: countKey !== 'raw_links' && !Object.hasOwn(sourceCounts[name] ?? {}, countKey)
        ? '—'
        : Number(sourceCounts[name]?.[countKey] ?? 0)
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
    const previewRegion = String(row?.regionCode ?? '').trim().toUpperCase();
    const inferredRegion = previewRegion || inferNodeRegion(row?.name);
    const region = inferredRegion === 'ZZ' || inferredRegion === 'OTHER' || inferredRegion === '其他' ? 'US' : inferredRegion;
    counts.set(region, (counts.get(region) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([region, count]) => ({ region, count }));
}

// Fresh profiles have no speed_test section. Reuse these defaults in both
// the settings card and its draft so the displayed controls can always open.
export function buildSpeedTestDraft(config = {}) {
  return structuredClone({ ...FALLBACK_PROFILE.speed_test, ...config });
}

export function buildSourceIterationDraft(sources = {}, sourceCounts = {}) {
  // Snapshot which rows actually stored a legacy budget BEFORE normalization
  // fills every row with the legacy defaults; a fresh row must get the shipped
  // lap defaults, not a conversion of numbers it never had. Aliases count too.
  const storedLegacy = new Set();
  // The stored caps themselves, keyed by canonical name. Normalization fills
  // every row with the shipped legacy defaults, so converting from the
  // normalized row would turn a URL row's stored 40 rounds into 200 and then
  // save 200 back — the operator's number must come from the file.
  const storedCaps = new Map();
  for (const [name, source] of Object.entries(sources ?? {})) {
    const canonical = LEGACY_SOURCE_ALIASES[name] ?? name;
    if (hasStoredLapValue(source?.max_iterations) || hasStoredLapValue(source?.plateau_limit)) {
      storedLegacy.add(canonical);
      if (!storedCaps.has(canonical)) storedCaps.set(canonical, source);
    }
  }
  const normalized = normalizeOfficialSourceDraft(sources);
  // Seeding is draft-only: opening the drawer converts nothing on disk, and
  // 取消 writes nothing. Saving is the opt-in to lap mode; the estimate line
  // shows the converted request counts before 保存 is pressed.
  for (const [name, source] of Object.entries(normalized)) {
    if (!SOURCE_DISPLAY_ORDER.includes(name)) continue;
    const storedLaps = hasStoredLapValue(source.max_laps) ? coercePositiveInteger(source.max_laps, SOURCE_LAP_DEFAULTS.max_laps) : null;
    const storedDry = hasStoredLapValue(source.dry_laps) ? coercePositiveInteger(source.dry_laps, SOURCE_LAP_DEFAULTS.dry_laps) : null;
    if (storedLaps !== null || storedDry !== null) {
      source.max_laps = storedLaps ?? SOURCE_LAP_DEFAULTS.max_laps;
      source.dry_laps = storedDry ?? SOURCE_LAP_DEFAULTS.dry_laps;
      continue;
    }
    // Only a row that actually stored a legacy budget is converted; a fresh
    // row gets the shipped lap defaults (50 / 13), not a conversion of the
    // normalization-filled legacy defaults.
    if (!storedLegacy.has(name)) {
      source.max_laps = SOURCE_LAP_DEFAULTS.max_laps;
      source.dry_laps = SOURCE_LAP_DEFAULTS.dry_laps;
      continue;
    }
    // A legacy row is converted at the measured list length when a run has
    // reported one, else the reference count (labelled 估算 in the drawer).
    const areas = observedAreaCount(sourceCounts?.[name]?.area_count);
    const stored = storedCaps.get(name) ?? {};
    // The stored caps seed the lap estimate. A URL row's caps count URL
    // fetches rather than route-loop rounds, so the conversion is an estimate
    // for that row, which the drawer labels 估算.
    const legacyIterations = coercePositiveInteger(stored.max_iterations, SOURCE_ROUND_DEFAULTS.max_iterations);
    const legacyPlateau = coercePositiveInteger(stored.plateau_limit, SOURCE_ROUND_DEFAULTS.plateau_limit);
    const legacyWidth = coerceBoundedInteger(stored.areas_per_round ?? source.areas_per_round, SOURCE_ROUND_DEFAULTS.areas_per_round, 1, 64);
    // Saving opts the row into lap mode, so the stored budget is kept beside
    // the lap keys: removing them later restores exactly these rounds. A row
    // that never stored a budget keeps the normalization default.
    if (stored.mode === 'credential') {
      source.max_iterations = legacyIterations;
      source.plateau_limit = legacyPlateau;
    }
    // The estimate uses the stored numbers even for a URL row: 3000 URL
    // iterations at width 8 is the work that row used to do.
    const seedIterations = coercePositiveInteger(stored.max_iterations, legacyIterations);
    const seedPlateau = coercePositiveInteger(stored.plateau_limit, legacyPlateau);
    source.max_laps = Math.max(1, Math.round((seedIterations * legacyWidth) / areas));
    source.dry_laps = Math.max(1, Math.round((seedPlateau * legacyWidth) / areas));
  }
  const firstSource = Object.values(normalized)[0] ?? {};
  return {
    sources: normalized,
    maxIterations: coercePositiveInteger(firstSource.max_iterations, SOURCE_ROUND_DEFAULTS.max_iterations),
    plateauLimit: coercePositiveInteger(firstSource.plateau_limit, SOURCE_ROUND_DEFAULTS.plateau_limit),
    areasPerRound: coerceBoundedInteger(firstSource.areas_per_round, SOURCE_ROUND_DEFAULTS.areas_per_round, 1, 64),
    areaConcurrency: coerceBoundedInteger(firstSource.area_concurrency, SOURCE_ROUND_DEFAULTS.area_concurrency, 1, 16)
  };
}

/** A cleared input is '' — still an edit in progress, not an absent field. */
function hasStoredLapValue(value) {
  return value !== undefined && value !== null && value !== '';
}

/** The measured list length when a run reported one, else the reference count. */
function observedAreaCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : REFERENCE_AREA_COUNT;
}

/**
 * The row's derived request budget. Laps × areas is exact arithmetic, so the
 * operator can check it by hand; waves use min(C, N) because a tiny debug list
 * clamps the workers to its own length.
 */
export function buildSourceLapEstimate(source = {}, areaCount) {
  const measured = Number.isFinite(Number(areaCount)) && Number(areaCount) >= 1;
  const areas = observedAreaCount(areaCount);
  const laps = coercePositiveInteger(source.max_laps, SOURCE_LAP_DEFAULTS.max_laps);
  const dry = coercePositiveInteger(source.dry_laps, SOURCE_LAP_DEFAULTS.dry_laps);
  const concurrency = coerceBoundedInteger(source.area_concurrency, SOURCE_ROUND_DEFAULTS.area_concurrency, 1, 16);
  const waves = Math.ceil(areas / Math.min(concurrency, areas));
  return `区域 ${areas}（${measured ? '实测' : '估算'}） · 最多 ${laps} 遍 × ${areas} 区域 = ${laps * areas} 次请求/端` +
    ` · 并发 ${concurrency} → 每遍 ${waves} 批（约 ${waves} 秒/遍） · 早停 ${dry} 遍 = ${dry * areas} 次`;
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
  // The drawer edits each row's rounds in place, and each row is the source of
  // truth when the draft carries rows. The shared `maxIterations` /
  // `plateauLimit` fields remain only for callers that pass bare values, which
  // then apply to every row.
  if (draft?.sources) {
    return normalizeOfficialSourceDraft(draft.sources);
  }
  const maxIterations = coercePositiveInteger(draft.maxIterations, SOURCE_ROUND_DEFAULTS.max_iterations);
  const plateauLimit = coercePositiveInteger(draft.plateauLimit, SOURCE_ROUND_DEFAULTS.plateau_limit);
  const areasPerRound = coerceBoundedInteger(draft.areasPerRound, SOURCE_ROUND_DEFAULTS.areas_per_round, 1, 64);
  const areaConcurrency = coerceBoundedInteger(draft.areaConcurrency, SOURCE_ROUND_DEFAULTS.area_concurrency, 1, 16);
  const normalized = normalizeOfficialSourceDraft(sources);
  return Object.fromEntries(
    Object.entries(normalized).map(([name, source]) => [
      name,
      {
        ...source,
        max_iterations: maxIterations,
        plateau_limit: plateauLimit,
        areas_per_round: areasPerRound,
        area_concurrency: areaConcurrency
      }
    ])
  );
}

export function validateSourceDraft(draft = {}) {
  const sources = draft.sources ?? {};
  for (const [name, source] of Object.entries(sources)) {
    // Only the vendor rows are edited here. A custom url source is passed
    // through untouched, so validating its `official_site` would reject a save
    // for a field the drawer never showed.
    if (!SOURCE_DISPLAY_ORDER.includes(name)) continue;
    if (source.enabled === false) continue;
    const value = String(source.official_site ?? '').trim();
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return `${SOURCE_NAMES[name] ?? name}：请填写有效的官网地址`;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      return `${SOURCE_NAMES[name] ?? name}：官网地址必须以 http:// 或 https:// 开头`;
    }
  }
  if (!Number.isFinite(Number(draft.maxIterations)) || Number(draft.maxIterations) < 1) {
    return '循环轮数至少为 1';
  }
  if (!Number.isFinite(Number(draft.plateauLimit)) || Number(draft.plateauLimit) < 1) {
    return '早停轮数至少为 1';
  }
  for (const [name, source] of Object.entries(sources)) {
    if (!SOURCE_DISPLAY_ORDER.includes(name)) continue;
    for (const [key, label] of [
      ['max_laps', '抓取遍数'],
      ['dry_laps', '空转早停（遍）']
    ]) {
      const raw = source?.[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 1 || Math.trunc(value) !== value) {
        return `${SOURCE_NAMES[name] ?? name}：${label}至少为 1`;
      }
    }
    const laps = Number(source?.max_laps);
    const dry = Number(source?.dry_laps);
    // More dry laps than total laps means the early stop could never fire;
    // that is a typo, not a policy, so it is refused before save.
    if (Number.isFinite(laps) && Number.isFinite(dry) && laps >= 1 && dry > laps) {
      return `${SOURCE_NAMES[name] ?? name}：空转早停（遍）不能大于抓取遍数`;
    }
    for (const [key, label, [, max]] of [
      ['areas_per_round', '每轮区域数', SOURCE_ROUND_LIMITS.areas_per_round],
      ['area_concurrency', '同时请求数', SOURCE_ROUND_LIMITS.area_concurrency]
    ]) {
      const raw = source?.[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 1 || value > max) {
        return `${SOURCE_NAMES[name] ?? name}：${label}必须是 1-${max} 之间的整数`;
      }
    }
  }
  return '';
}

function inferNodeRegion(name = '') {
  const normalized = String(name).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const match = normalized.match(/^([A-Z]{2})(?:\b|[\s_-])/);
  return match ? match[1] : 'US';
}

function coercePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.trunc(parsed);
}

// The two area controls have a closed range; a stored value from outside it is
// clamped rather than rejected, so an older or hand-edited profile still opens.
function coerceBoundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function coerceAreaValue(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function buildLogRows(displayLogs, trimWindow = true) {
  return (trimWindow ? displayLogs.slice(-28) : displayLogs).map((entry) => ({
    ...entry,
    levelClass: entry.level === 'error' ? 'danger' : entry.level === 'warning' ? 'warning' : 'success'
  }));
}

function selectLogWindow(entries, logView) {
  // With the compact shell, 28 lines fit entirely on a tall desktop window.
  // That left no scroll range to pause following and shifted text on append.
  // Keep the same bounded 120-line window in both follow and paused modes.
  if (logView?.follow !== false) return entries.slice(-120);
  const anchorIndex = entries.findIndex((entry) => entry.logId === logView.anchorId);
  const start = anchorIndex >= 0
    ? Math.max(0, Math.min(anchorIndex - 8, Math.max(0, entries.length - 120)))
    : Math.max(0, entries.length - 120);
  return entries.slice(start, start + 120);
}

function renderLogRows(rows) {
  if (!rows.length) {
    return '<div class="empty-state log-empty-state">暂无可显示日志</div>';
  }
  return rows.map((row) => `<div class="log-line ${row.levelClass}" data-log-id="${escapeHtml(row.logId)}">${escapeHtml(row.line)}</div>`).join('');
}

function renderLogGroups(groups) {
  if (!groups.length) {
    return '<div class="empty-state log-empty-state">暂无可显示日志</div>';
  }
  return groups.map((group) => `
    <section class="log-group">
      <div class="log-group-title">${escapeHtml(group.label)}</div>
      ${group.rows.map((row) => `<div class="log-line ${row.levelClass}" data-log-id="${escapeHtml(row.logId)}">${escapeHtml(row.line)}</div>`).join('')}
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

export function groupLogEntriesByStage(entries, trimWindow = true) {
  const groups = new Map();
  for (const row of buildLogRows(entries, trimWindow)) {
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

// Fields the drawer no longer edits. `min_iterations` and `platforms` stay: the
// round policy and `resolveCredentialPlatforms` still read them, so a pinned
// debug profile that sets them must survive a save from the drawer.
const OBSOLETE_SOURCE_FIELDS = [
  'url', 'key', 'account', 'password', 'platform',
  'use_random_area', 'area_min', 'area_max', 'max_areas',
  'resume_from_iteration', 'failure_limit'
];

export function normalizeOfficialSourceDraft(sources = {}) {
  const collapsed = {};
  // A non-vendor row (a custom `url` source) is kept out of the vendor table
  // but must survive a save: the drawer does not render it, and dropping it
  // would delete a working source the operator never touched.
  const extras = {};
  for (const [name, source] of Object.entries(sources ?? {})) {
    const canonical = LEGACY_SOURCE_ALIASES[name] ?? name;
    if (!SOURCE_DISPLAY_ORDER.includes(canonical)) {
      extras[canonical] = { ...source };
      continue;
    }
    const existing = collapsed[canonical];
    collapsed[canonical] = existing
      ? {
          ...existing,
          ...source,
          // The first row listed the vendor's rounds; a legacy duplicate must
          // not overwrite them just by appearing later in the file.
          max_iterations: existing.max_iterations ?? source.max_iterations,
          plateau_limit: existing.plateau_limit ?? source.plateau_limit,
          areas_per_round: existing.areas_per_round ?? source.areas_per_round,
          area_concurrency: existing.area_concurrency ?? source.area_concurrency,
          max_laps: existing.max_laps ?? source.max_laps,
          dry_laps: existing.dry_laps ?? source.dry_laps,
          min_laps: existing.min_laps ?? source.min_laps,
          enabled: existing.enabled !== false || source.enabled !== false
        }
      : { ...source };
  }
  const vendorRows = Object.fromEntries(SOURCE_DISPLAY_ORDER.map((name) => {
    const source = collapsed[name] ?? {};
    const wasCredential = source.mode === 'credential';
    // A lap row already carries the budget in the operator's own unit. Its
    // legacy caps are kept verbatim so removing the lap keys later restores
    // exactly the rounds that were stored, instead of the shipped default.
    const hasLapKey = ['max_laps', 'dry_laps', 'min_laps'].some((key) => hasStoredLapValue(source[key]));
    const keepLegacyCaps = wasCredential || hasLapKey;
    const normalized = {
      ...source,
      mode: 'credential',
      // Fill the vendor default only for a row that has never been stored.
      // A cleared input is a real edit, not a request for the default: refilling
      // it here would undo what the operator just typed.
      official_site: source.official_site === undefined
        ? (OFFICIAL_SITES[name] ?? '')
        : String(source.official_site).trim(),
      enabled: source.enabled !== false,
      max_iterations: keepLegacyCaps ? coercePositiveInteger(source.max_iterations, SOURCE_ROUND_DEFAULTS.max_iterations) : SOURCE_ROUND_DEFAULTS.max_iterations,
      plateau_limit: keepLegacyCaps ? coercePositiveInteger(source.plateau_limit, SOURCE_ROUND_DEFAULTS.plateau_limit) : SOURCE_ROUND_DEFAULTS.plateau_limit,
      areas_per_round: keepLegacyCaps ? coerceBoundedInteger(source.areas_per_round, SOURCE_ROUND_DEFAULTS.areas_per_round, 1, 64) : SOURCE_ROUND_DEFAULTS.areas_per_round,
      area_concurrency: keepLegacyCaps ? coerceBoundedInteger(source.area_concurrency, SOURCE_ROUND_DEFAULTS.area_concurrency, 1, 16) : SOURCE_ROUND_DEFAULTS.area_concurrency
    };
    for (const field of OBSOLETE_SOURCE_FIELDS) delete normalized[field];
    // A URL-mode floor is the same mismatch as its URL-mode cap: 10 URL fetches
    // are not 10 route-loop rounds, so it goes with the rest of the old shape.
    if (!wasCredential && !hasLapKey) delete normalized.min_iterations;
    return [name, normalized];
  }));
  return { ...vendorRows, ...extras };
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
    sources: normalizeOfficialSourceDraft(profile?.sources ?? FALLBACK_PROFILE.sources),
    availability_targets: profile?.availability_targets ?? DEFAULT_AVAILABILITY_TARGETS,
    speed_test: buildSpeedTestDraft(profile?.speed_test),
    deploy: { ...FALLBACK_PROFILE.deploy, ...(profile?.deploy ?? {}) },
    network: buildNetworkDraft(profile?.network),
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
  // A retained result belongs to the previous run. Live state takes priority
  // when another run starts through the service or another client.
  if (state.runState === 'running') return '运行中';
  if (state.runState === 'stopping') return '停止中';
  if (state.runResult === 'success' || state.runResult === 'demo') return '成功';
  if (state.runResult === 'failed') return '失败';
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
