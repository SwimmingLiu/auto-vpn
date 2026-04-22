import { buildStageModel, PAGE_INDEX, PAGE_ORDER } from './state.js';

const SOURCE_NAMES = ['leiting', 'heidong', 'mifeng', 'xuanfeng1', 'xuanfeng2'];

const NAV_ICONS = {
  dashboard: 'DB',
  config: 'CF',
  run: 'RN',
  artifacts: 'AR',
  logs: 'LG',
  about: 'AB'
};

export function buildViewModel(state, messages, language) {
  const profile = normalizeProfile(state.profile);
  const counts = {
    raw_links: Number(state.counts.raw_links ?? 0),
    postprocess_links: Number(state.counts.postprocess_links ?? 0),
    speedtest_links: Number(state.counts.speedtest_links ?? 0),
    availability_links: Number(state.counts.availability_links ?? 0)
  };
  const stageRows = buildStageModel(state.stageStatus);
  const hasRunData =
    Object.values(counts).some((value) => value > 0) ||
    stageRows.some((row) => row.status !== 'pending') ||
    state.runResult !== 'idle';
  const hasLogs = state.logEntries.length > 0;
  const hasSubscription = Boolean(profile.deploy.subscription_url.trim());
  const artifactDir = state.artifactDir ?? profile.workspace.artifacts_root;
  const hasArtifacts = Boolean(state.artifactDir || hasSubscription);

  return {
    profile,
    counts,
    stageRows,
    hasRunData,
    hasLogs,
    hasSubscription,
    hasArtifacts,
    artifactDir,
    deployment: state.deployment ?? {},
    logEntries: state.logEntries,
    lastUpdated: formatDate(state.lastUpdateAt, language) || messages.notAvailableValue,
    shortcutActions: [
      { id: 'shortcutConfig', page: 'config', label: messages.shortcutActions.config, tone: 'accent' },
      { id: 'shortcutRun', page: 'run', label: messages.shortcutActions.run, tone: 'warning' },
      { id: 'shortcutArtifacts', page: 'artifacts', label: messages.shortcutActions.artifacts, tone: 'success' },
      { id: 'shortcutLogs', page: 'logs', label: messages.shortcutActions.logs, tone: 'accent' }
    ],
    metrics: [
      [pick(language, '原始节点', 'Raw nodes'), counts.raw_links || 0],
      [pick(language, '去重后', 'After dedupe'), counts.postprocess_links || 0],
      [pick(language, '测速通过', 'Speed passed'), counts.speedtest_links || 0],
      [pick(language, '可用通过', 'Availability passed'), counts.availability_links || 0]
    ],
    runtimeRows: [
      [pick(language, '项目根目录', 'Project root'), profile.workspace.project_root || messages.notAvailableValue],
      [pick(language, '产物目录', 'Artifacts root'), profile.workspace.artifacts_root || messages.notAvailableValue],
      [pick(language, '状态目录', 'State root'), profile.workspace.state_root || messages.notAvailableValue],
      [pick(language, '配置文件', 'Profile file'), profile.workspace.profile_path || messages.notAvailableValue]
    ],
    statusRows: [
      [pick(language, '状态', 'State'), messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle],
      [pick(language, '模式', 'Mode'), state.isDemo ? messages.demoRunMode : messages.manualRunMode],
      [pick(language, '日志', 'Logs'), String(state.logEntries.length)],
      [pick(language, '最后更新', 'Last update'), formatDate(state.lastUpdateAt, language) || messages.notAvailableValue]
    ]
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

export function buildShortcutStrip(messages, viewModel) {
  return viewModel.shortcutActions.map((action) => `
    <button
      id="${action.id}"
      class="shortcut-action"
      data-page-target="${action.page}"
      type="button"
    >
      <span class="shortcut-accent ${action.tone}"></span>
      <span>${escapeHtml(action.label)}</span>
    </button>
  `).join('');
}

export function buildSidebarStatus(viewModel, messages) {
  return `
    ${viewModel.statusRows.map(([label, value]) => `
      <div class="status-row">
        <span class="status-row-label">${escapeHtml(label)}</span>
        <strong class="status-row-value">${escapeHtml(value)}</strong>
      </div>
    `).join('')}
    <div class="status-divider"></div>
    <div class="status-footnote">
      <span>${escapeHtml(messages.currentTaskLabel)}</span>
      <strong>${escapeHtml(resolveCurrentTaskLabel(viewModel.stageRows, messages))}</strong>
    </div>
  `;
}

export function buildPageMarkup(activePage, viewModel, messages, language) {
  return `
    <section class="page-shell" data-page-shell="${activePage}">
      <header class="page-header-card">
        <span class="page-index-badge">${PAGE_INDEX[activePage]}</span>
        <div class="page-header-copy">
          <h2>${escapeHtml(messages.pageTitles[activePage])}</h2>
          <p>${escapeHtml(messages.pageSubtitles[activePage])}</p>
        </div>
      </header>
      ${buildPageInner(activePage, viewModel, messages, language)}
    </section>
  `;
}

function buildPageInner(activePage, viewModel, messages, language) {
  switch (activePage) {
    case 'dashboard':
      return buildDashboardPage(viewModel, messages, language);
    case 'config':
      return buildConfigPage(viewModel, messages, language);
    case 'run':
      return buildRunPage(viewModel, messages, language);
    case 'artifacts':
      return buildArtifactsPage(viewModel, messages, language);
    case 'logs':
      return buildLogsPage(viewModel, messages, language);
    default:
      return buildAboutPage(viewModel, messages, language);
  }
}

function buildDashboardPage(vm, messages, language) {
  return `
    <div id="dashboardOverview" class="page-grid dashboard-grid runtime-grid">
      <article class="panel wide-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(messages.dashboardMetricsTitle)}</h3>
          ${renderBadge(messages.runStateLabels.idle, 'neutral')}
        </div>
        <div class="metric-grid compact">
          ${vm.metrics.map(([label, value]) => `
            <div class="metric-card accent">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(String(value))}</strong>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '快捷入口', 'Quick access'))}</h3>
        </div>
        <div class="action-grid">
          <button class="btn btn-secondary" data-page-target="config" type="button">${escapeHtml(messages.shortcutActions.config)}</button>
          <button class="btn btn-primary" data-page-target="run" type="button">${escapeHtml(messages.shortcutActions.run)}</button>
          <button class="btn btn-secondary" data-page-target="artifacts" type="button">${escapeHtml(messages.shortcutActions.artifacts)}</button>
          <button class="btn btn-secondary" data-page-target="logs" type="button">${escapeHtml(messages.shortcutActions.logs)}</button>
        </div>
      </article>

      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '最近运行摘要', 'Recent run summary'))}</h3>
        </div>
        ${
          vm.hasRunData
            ? `
              <div class="key-value-list">
                ${vm.stageRows.map((row) => `
                  <div class="key-value-row">
                    <span>${escapeHtml(messages.stageLabels[row.name] ?? row.name)}</span>
                    <strong>${escapeHtml(messages.statusLabels[row.status] ?? row.status)}</strong>
                  </div>
                `).join('')}
              </div>
            `
            : `
              <div id="dashboardEmptyState" class="empty-state">
                <strong>${escapeHtml(messages.emptyStates.noRunData)}</strong>
                <p>${escapeHtml(messages.dashboardPrimaryEmptyHint)}</p>
              </div>
            `
        }
      </article>
    </div>
  `;
}

function buildConfigPage(vm, messages, language) {
  const sourceRows = Object.entries(vm.profile.sources);
  return `
    <div class="page-grid runtime-grid">
      <article class="panel wide-panel">
        <div class="form-grid two-columns">
          <section class="form-column">
            <h3>${escapeHtml(messages.configSourcesTitle)}</h3>
            ${sourceRows.map(([name, source], index) => `
              <label class="field">
                <span>${escapeHtml(index === 0 ? pick(language, '主抓包 API URL', 'Primary capture URL') : `${pick(language, '备用抓包 API URL', 'Backup capture URL')} ${index}`)}</span>
                <input
                  ${index === 0 ? 'id="configPrimarySource"' : ''}
                  data-source="${escapeHtml(name)}"
                  data-key="url"
                  value="${escapeHtml(source.url)}"
                />
              </label>
              <label class="field">
                <span>${escapeHtml(index === 0 ? pick(language, '主抓包 KEY', 'Primary key') : `${pick(language, '备用 KEY', 'Backup key')} ${index}`)}</span>
                <input
                  data-source="${escapeHtml(name)}"
                  data-key="key"
                  value="${escapeHtml(source.key)}"
                />
              </label>
            `).join('')}
          </section>

          <section class="form-column">
            <h3>${escapeHtml(messages.configSpeedTitle)}</h3>
            ${renderBoundField(pick(language, '最低下载速度 MB/s', 'Minimum download MB/s'), 'number', vm.profile.speed_test.min_download_mb_s, 'speed_test', 'min_download_mb_s')}
            ${renderBoundField(pick(language, '测速超时（秒）', 'Timeout (seconds)'), 'number', vm.profile.speed_test.timeout_seconds, 'speed_test', 'timeout_seconds')}
            ${renderBoundField(pick(language, '并发数', 'Concurrency'), 'number', vm.profile.speed_test.concurrency, 'speed_test', 'concurrency')}
            ${renderBoundField(pick(language, '测速地址（每行一个）', 'Speed test URLs'), 'textarea', vm.profile.speed_test.urls.join('\n'), 'speed_test', 'urls')}
          </section>
        </div>
      </article>

      <article class="panel wide-panel">
        <div class="form-grid two-columns">
          <section class="form-column">
            <h3>${escapeHtml(messages.configDeployTitle)}</h3>
            ${renderBoundField(pick(language, 'Pages 项目名', 'Pages project name'), 'text', vm.profile.deploy.project_name, 'deploy', 'project_name')}
            ${renderBoundField(pick(language, '订阅地址', 'Subscription URL'), 'text', vm.profile.deploy.subscription_url, 'deploy', 'subscription_url')}
            ${renderBoundField(pick(language, 'Pages 项目 URL', 'Pages project URL'), 'text', vm.profile.deploy.pages_project_url, 'deploy', 'pages_project_url')}
          </section>
          <section class="form-column">
            <div class="empty-state compact">
              <strong>${escapeHtml(pick(language, '说明', 'Note'))}</strong>
              <p>${escapeHtml(pick(language, '这里只保留真实可编辑的配置项，不再展示未落地的监控、历史、节点管理假页面。', 'Only real editable configuration fields remain here. Fake pages for history, monitoring, and node management are removed.'))}</p>
            </div>
            <div class="page-actions">
              <button class="btn btn-secondary" data-action="reset-profile" type="button">${escapeHtml(messages.resetButton)}</button>
              <button class="btn btn-primary" data-action="save-profile" type="button">${escapeHtml(messages.saveButton)}</button>
            </div>
          </section>
        </div>
      </article>
    </div>
  `;
}

function buildRunPage(vm, messages, language) {
  return `
    <div class="page-grid runtime-grid">
      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '阶段状态', 'Stage state'))}</h3>
        </div>
        <div class="run-stage-list">
          ${vm.stageRows.map((row, index) => `
            <div class="run-stage-row">
              <span class="timeline-index ${row.status}">${index + 1}</span>
              <span class="timeline-copy">${escapeHtml(messages.stageLabels[row.name] ?? row.name)}</span>
              ${renderBadge(messages.statusLabels[row.status] ?? row.status, badgeTone(row.status))}
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel terminal-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '实时执行日志', 'Live run log'))}</h3>
        </div>
        <pre id="runLogOutput" class="terminal-output">${
          vm.hasLogs ? escapeHtml(vm.logEntries.join('\n')) : escapeHtml(messages.emptyStates.noLogs)
        }</pre>
        <div class="action-grid">
          <button class="btn btn-primary" data-action="run-pipeline" type="button">${escapeHtml(messages.runButton)}</button>
          <button class="btn btn-danger" data-action="stop-pipeline" type="button">${escapeHtml(messages.stopButton)}</button>
          <button class="btn btn-secondary" data-page-target="logs" type="button">${escapeHtml(messages.openLogsButton)}</button>
        </div>
      </article>
    </div>
  `;
}

function buildArtifactsPage(vm, messages, language) {
  return `
    <div id="artifactsPanel" class="page-grid runtime-grid">
      <article class="panel wide-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '当前订阅与产物', 'Current subscription and artifacts'))}</h3>
        </div>
        ${
          vm.hasArtifacts
            ? `
              <div class="key-value-list">
                <div class="key-value-row">
                  <span>${escapeHtml(pick(language, '订阅地址', 'Subscription URL'))}</span>
                  <strong class="mono">${escapeHtml(vm.profile.deploy.subscription_url || messages.emptyStates.noSubscription)}</strong>
                </div>
                <div class="key-value-row">
                  <span>${escapeHtml(pick(language, '输出目录', 'Output directory'))}</span>
                  <strong class="mono">${escapeHtml(vm.artifactDir || messages.notAvailableValue)}</strong>
                </div>
              </div>
              <div class="page-actions">
                <button class="btn btn-secondary" data-copy-text="${escapeHtml(vm.profile.deploy.subscription_url)}" type="button">${escapeHtml(pick(language, '复制订阅地址', 'Copy subscription URL'))}</button>
                <button class="btn btn-primary" data-action="open-artifacts" type="button">${escapeHtml(messages.openArtifactsButton)}</button>
              </div>
            `
            : `
              <div class="empty-state">
                <strong>${escapeHtml(messages.emptyStates.noArtifacts)}</strong>
                <p>${escapeHtml(pick(language, '只有在保存了部署参数并成功运行流水线后，这里才会显示真实订阅地址和产物目录。', 'This page shows real subscription data only after deploy settings are saved and the pipeline has produced artifacts.'))}</p>
              </div>
            `
        }
      </article>
    </div>
  `;
}

function buildLogsPage(vm, messages, language) {
  return `
    <div class="page-grid runtime-grid">
      <article class="panel wide-panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '当前会话日志', 'Current session logs'))}</h3>
          <button class="btn btn-secondary small" data-action="export-logs" type="button">${escapeHtml(messages.exportLogsButton)}</button>
        </div>
        <div id="logCenterTable" class="table-wrap">
          ${
            vm.hasLogs
              ? `
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>${escapeHtml(pick(language, '序号', 'No.'))}</th>
                      <th>${escapeHtml(pick(language, '日志内容', 'Log message'))}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${vm.logEntries.map((line, index) => `
                      <tr>
                        <td>${index + 1}</td>
                        <td>${escapeHtml(line)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              `
              : `
                <div class="empty-state">
                  <strong>${escapeHtml(messages.emptyStates.noLogs)}</strong>
                  <p>${escapeHtml(pick(language, '运行流水线后，这里会显示当前会话的实时日志。', 'Run the pipeline to populate the live session logs here.'))}</p>
                </div>
              `
          }
        </div>
      </article>
    </div>
  `;
}

function buildAboutPage(vm, messages, language) {
  return `
    <div class="page-grid runtime-grid">
      <article class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(messages.aboutRuntimeTitle)}</h3>
        </div>
        <div class="key-value-list">
          ${vm.runtimeRows.map(([label, value]) => `
            <div class="key-value-row">
              <span>${escapeHtml(label)}</span>
              <strong class="mono">${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>
        <div class="empty-state compact">
          <strong>${escapeHtml(pick(language, '说明', 'Note'))}</strong>
          <p>${escapeHtml(messages.aboutRuntimeHint)}</p>
        </div>
      </article>

      <article id="aboutArchitecture" class="panel">
        <div class="panel-headline">
          <h3>${escapeHtml(pick(language, '实际运行链路', 'Runtime flow'))}</h3>
        </div>
        <div class="architecture-diagram">
          <div class="architecture-row">
            <div class="architecture-block">
              <strong>${escapeHtml(pick(language, 'Electron 界面', 'Electron UI'))}</strong>
              <span>${escapeHtml(pick(language, '配置、运行、日志、产物', 'Config, run, logs, artifacts'))}</span>
            </div>
            <div class="architecture-block">
              <strong>${escapeHtml(pick(language, 'IPC', 'IPC'))}</strong>
              <span>${escapeHtml(pick(language, 'load / save / run / stop', 'load / save / run / stop'))}</span>
            </div>
          </div>
          <div class="architecture-row">
            <div class="architecture-block">
              <strong>${escapeHtml(pick(language, 'Python backend', 'Python backend'))}</strong>
              <span>${escapeHtml(pick(language, '抓取、测速、处理、部署', 'extract, speed-test, process, deploy'))}</span>
            </div>
            <div class="architecture-block">
              <strong>${escapeHtml(pick(language, '运行时 profile', 'Runtime profile'))}</strong>
              <span>${escapeHtml(pick(language, '开发态用仓库 state，打包态用用户目录', 'repo state in dev, user directory when packaged'))}</span>
            </div>
          </div>
        </div>
      </article>
    </div>
  `;
}

function renderBoundField(label, type, value, section, key) {
  if (type === 'textarea') {
    return `
      <label class="field">
        <span>${escapeHtml(label)}</span>
        <textarea data-section="${escapeHtml(section)}" data-key="${escapeHtml(key)}" rows="5">${escapeHtml(value)}</textarea>
      </label>
    `;
  }

  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input
        type="${type}"
        data-section="${escapeHtml(section)}"
        data-key="${escapeHtml(key)}"
        value="${escapeHtml(value)}"
      />
    </label>
  `;
}

function renderBadge(text, tone) {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function badgeTone(status) {
  if (status === 'success') {
    return 'success';
  }
  if (status === 'running') {
    return 'warning';
  }
  if (status === 'failed') {
    return 'danger';
  }
  return 'neutral';
}

function resolveCurrentTaskLabel(stageRows, messages) {
  const running = stageRows.find((row) => row.status === 'running');
  if (running) {
    return messages.stageLabels[running.name] ?? running.name;
  }

  const completed = stageRows.filter((row) => row.status === 'success');
  if (completed.length) {
    return messages.stageLabels[completed.at(-1).name] ?? completed.at(-1).name;
  }

  return messages.taskWaiting;
}

function normalizeProfile(profile) {
  const result = blankProfile();
  if (!profile) {
    return result;
  }

  for (const name of SOURCE_NAMES) {
    if (profile.sources?.[name]) {
      result.sources[name] = {
        ...result.sources[name],
        ...profile.sources[name]
      };
    }
  }

  result.speed_test = {
    ...result.speed_test,
    ...(profile.speed_test ?? {}),
    urls: Array.isArray(profile.speed_test?.urls) ? profile.speed_test.urls : result.speed_test.urls
  };

  result.deploy = {
    ...result.deploy,
    ...(profile.deploy ?? {})
  };

  result.workspace = {
    ...result.workspace,
    ...(profile.workspace ?? {})
  };

  return result;
}

function blankProfile() {
  return {
    sources: Object.fromEntries(
      SOURCE_NAMES.map((name) => [
        name,
        {
          url: '',
          key: '',
          enabled: true
        }
      ])
    ),
    speed_test: {
      min_download_mb_s: 1.0,
      timeout_seconds: 20,
      concurrency: 3,
      urls: []
    },
    deploy: {
      project_name: '',
      subscription_url: '',
      pages_project_url: ''
    },
    workspace: {
      project_root: '',
      artifacts_root: '',
      state_root: '',
      profile_path: ''
    }
  };
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

function pick(language, zh, en) {
  return language === 'zh-CN' ? zh : en;
}

function navId(page) {
  return `nav${page[0].toUpperCase()}${page.slice(1)}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
