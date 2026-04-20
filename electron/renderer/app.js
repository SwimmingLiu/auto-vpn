import { getMessages, resolveLanguage, LANGUAGE_STORAGE_KEY, formatMessage } from './i18n.js';
import { buildStageModel } from './state.js';

const state = {
  profile: null,
  unsubscribe: null,
  stageStatus: {},
  counts: {},
  language: 'zh-CN',
  activePanel: ''
};

const demoProfile = {
  sources: {
    leiting: { url: 'https://capture.example/leiting', key: 'ks9KUrbWJj46AftX', enabled: true },
    heidong: { url: 'https://capture.example/heidong', key: 'ks9KUrbWJj46AftX', enabled: true },
    mifeng: { url: 'https://capture.example/mifeng', key: 'ks9KUrbWJj46AftX', enabled: true },
    xuanfeng1: { url: 'https://capture.example/xuanfeng1', key: 'awdtif20190619ti', enabled: true },
    xuanfeng2: { url: 'https://capture.example/xuanfeng2', key: 'awdtif20190619ti', enabled: true }
  },
  speed_test: {
    min_download_mb_s: 1.0,
    timeout_seconds: 20,
    concurrency: 3,
    urls: ['https://speed.cloudflare.com/__down?bytes=5000000']
  },
  deploy: {
    project_name: 'vmessnodes',
    pages_project_url: 'https://vmess2clash.pages.dev',
    subscription_url: 'https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937'
  }
};

const elements = {
  appTitle: document.querySelector('#appTitle'),
  brandSubtitle: document.querySelector('#brandSubtitle'),
  eyebrow: document.querySelector('#eyebrow'),
  heroTitle: document.querySelector('#heroTitle'),
  heroBody: document.querySelector('#heroBody'),
  languageLabel: document.querySelector('#languageLabel'),
  languageSelect: document.querySelector('#languageSelect'),
  saveBtn: document.querySelector('#saveBtn'),
  runBtn: document.querySelector('#runBtn'),
  metricsRibbon: document.querySelector('#metricsRibbon'),
  sourcesCardTitle: document.querySelector('#sourcesCardTitle'),
  sourcesCardSubtitle: document.querySelector('#sourcesCardSubtitle'),
  speedCardTitle: document.querySelector('#speedCardTitle'),
  speedCardSubtitle: document.querySelector('#speedCardSubtitle'),
  deployCardTitle: document.querySelector('#deployCardTitle'),
  deployCardSubtitle: document.querySelector('#deployCardSubtitle'),
  metricsCardTitle: document.querySelector('#metricsCardTitle'),
  metricsCardSubtitle: document.querySelector('#metricsCardSubtitle'),
  sourcesExpandBtn: document.querySelector('#sourcesExpandBtn'),
  speedExpandBtn: document.querySelector('#speedExpandBtn'),
  deployExpandBtn: document.querySelector('#deployExpandBtn'),
  sourcesSummary: document.querySelector('#sourcesSummary'),
  speedSummary: document.querySelector('#speedSummary'),
  deploySummary: document.querySelector('#deploySummary'),
  metricsSummary: document.querySelector('#metricsSummary'),
  stagesTitle: document.querySelector('#stagesTitle'),
  stagesSubtitle: document.querySelector('#stagesSubtitle'),
  stages: document.querySelector('#stages'),
  logsTitle: document.querySelector('#logsTitle'),
  logsSubtitle: document.querySelector('#logsSubtitle'),
  logOutput: document.querySelector('#logOutput'),
  drawer: document.querySelector('#drawer'),
  drawerBackdrop: document.querySelector('#drawerBackdrop'),
  drawerTitle: document.querySelector('#drawerTitle'),
  drawerContent: document.querySelector('#drawerContent'),
  drawerClose: document.querySelector('#drawerClose'),
  drawerSave: document.querySelector('#drawerSave')
};

async function bootstrap() {
  state.language = resolveLanguage(
    localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? '',
    navigator.language
  );

  if (!window.vpnAutomation) {
    state.profile = structuredClone(demoProfile);
    renderAll();
    bindActions();
    appendLog(getMessages(state.language).demoMode);
    return;
  }

  state.profile = await window.vpnAutomation.loadProfile();
  renderAll();
  bindActions();
  state.unsubscribe = window.vpnAutomation.onPipelineEvent(handlePipelineEvent);
}

function bindActions() {
  elements.saveBtn.addEventListener('click', saveProfile);
  elements.runBtn.addEventListener('click', runPipeline);
  elements.languageSelect.addEventListener('change', handleLanguageChange);
  elements.drawerClose.addEventListener('click', closeDrawer);
  elements.drawerBackdrop.addEventListener('click', closeDrawer);
  elements.drawerSave.addEventListener('click', handleDrawerSave);
  document.querySelectorAll('[data-panel]').forEach((button) => {
    button.addEventListener('click', () => openDrawer(button.dataset.panel));
  });
}

function renderAll() {
  renderStaticCopy();
  renderSummaryCards();
  renderMetricsRibbon();
  renderStages();
  renderDrawer();
}

function renderStaticCopy() {
  const m = getMessages(state.language);
  document.documentElement.lang = state.language;
  document.title = m.appTitle;

  elements.appTitle.textContent = m.appTitle;
  elements.brandSubtitle.textContent = m.brandSubtitle;
  elements.eyebrow.textContent = m.eyebrow;
  elements.heroTitle.textContent = m.heroTitle;
  elements.heroBody.textContent = m.heroBody;
  elements.languageLabel.textContent = m.languageLabel;
  elements.languageSelect.value = state.language;
  elements.saveBtn.textContent = m.saveButton;
  elements.runBtn.textContent = m.runButton;
  elements.sourcesCardTitle.textContent = m.sourcesCardTitle;
  elements.sourcesCardSubtitle.textContent = m.sourcesCardSubtitle;
  elements.speedCardTitle.textContent = m.speedCardTitle;
  elements.speedCardSubtitle.textContent = m.speedCardSubtitle;
  elements.deployCardTitle.textContent = m.deployCardTitle;
  elements.deployCardSubtitle.textContent = m.deployCardSubtitle;
  elements.metricsCardTitle.textContent = m.metricsCardTitle;
  elements.metricsCardSubtitle.textContent = m.metricsCardSubtitle;
  elements.sourcesExpandBtn.textContent = m.expandButton;
  elements.speedExpandBtn.textContent = m.expandButton;
  elements.deployExpandBtn.textContent = m.expandButton;
  elements.stagesTitle.textContent = m.stagesTitle;
  elements.stagesSubtitle.textContent = m.stagesSubtitle;
  elements.logsTitle.textContent = m.logsTitle;
  elements.logsSubtitle.textContent = m.logsSubtitle;
  elements.drawerClose.textContent = m.drawerClose;
  elements.drawerSave.textContent = m.drawerSave;
  if (!elements.logOutput.textContent.trim()) {
    elements.logOutput.textContent = `${m.logPlaceholder}\n`;
  }
}

function renderSummaryCards() {
  const m = getMessages(state.language);
  const sources = Object.values(state.profile.sources);
  const enabledCount = sources.filter((item) => item.enabled).length;
  elements.sourcesSummary.innerHTML = [
    createSummaryLine(formatMessage(m.summaryEnabledSources, { count: enabledCount, total: sources.length })),
    ...sources.slice(0, 3).map((source) => createSummaryLine(source.url || '—'))
  ].join('');

  elements.speedSummary.innerHTML = [
    createSummaryLine(formatMessage(m.summarySpeed, {
      speed: state.profile.speed_test.min_download_mb_s,
      concurrency: state.profile.speed_test.concurrency
    })),
    createSummaryLine(state.profile.speed_test.urls[0] || '—')
  ].join('');

  elements.deploySummary.innerHTML = [
    createSummaryLine(formatMessage(m.summaryDeploy, { project: state.profile.deploy.project_name || '—' })),
    createSummaryLine(state.profile.deploy.pages_project_url || '—'),
    createSummaryLine(state.profile.deploy.subscription_url || '—')
  ].join('');

  elements.metricsSummary.innerHTML = [
    createSummaryLine(formatMessage(m.summaryRawLinks, { count: state.counts.raw_links ?? 0 })),
    createSummaryLine(formatMessage(m.summarySpeedPassed, { count: state.counts.speedtest_links ?? 0 })),
    createSummaryLine(formatMessage(m.summaryVerifyState, {
      status: m.statusLabels[state.stageStatus.verify ?? 'pending'] ?? m.statusLabels.pending
    }))
  ].join('');
}

function renderMetricsRibbon() {
  const m = getMessages(state.language);
  const items = [
    [m.metricRawLinks, state.counts.raw_links ?? 0],
    [m.metricDedupedLinks, state.counts.deduped_links ?? 0],
    [m.metricSpeedLinks, state.counts.speedtest_links ?? 0],
    [m.metricVerifyStatus, state.stageStatus.verify === 'success' ? m.verifiedValue : m.readyValue]
  ];

  elements.metricsRibbon.innerHTML = items.map(([label, value]) => `
    <div class="metric-pill">
      <span class="metric-pill-label">${label}</span>
      <strong class="metric-pill-value">${value}</strong>
    </div>
  `).join('');
}

function renderStages() {
  const m = getMessages(state.language);
  const rows = buildStageModel(state.stageStatus);
  elements.stages.innerHTML = rows.map((row) => `
    <div class="stage-row">
      <span>${m.stageLabels[row.name] ?? row.name}</span>
      <span class="stage-chip ${row.status}">${m.statusLabels[row.status] ?? row.status}</span>
    </div>
  `).join('');
}

function openDrawer(panel) {
  state.activePanel = panel;
  renderDrawer();
  elements.drawer.classList.add('open');
  elements.drawerBackdrop.classList.add('open');
}

function closeDrawer() {
  elements.drawer.classList.remove('open');
  elements.drawerBackdrop.classList.remove('open');
  state.activePanel = '';
}

function renderDrawer() {
  const m = getMessages(state.language);
  if (!state.activePanel) {
    elements.drawerTitle.textContent = '';
    elements.drawerContent.innerHTML = '';
    return;
  }

  if (state.activePanel === 'sources') {
    elements.drawerTitle.textContent = m.drawerSourcesTitle;
    elements.drawerContent.innerHTML = Object.entries(state.profile.sources).map(([name, source]) => `
      <section class="drawer-section">
        <div class="drawer-section-head">
          <h3>${escapeHtml(name)}</h3>
          <label class="inline-toggle">
            <input type="checkbox" data-source="${escapeHtml(name)}" data-key="enabled" ${source.enabled ? 'checked' : ''} />
            <span>${m.enabledLabel}</span>
          </label>
        </div>
        <label class="drawer-field">
          <span>${m.sourceUrlLabel}</span>
          <input data-source="${escapeHtml(name)}" data-key="url" value="${escapeHtml(source.url)}" />
        </label>
        <label class="drawer-field">
          <span>${m.sourceKeyLabel}</span>
          <input data-source="${escapeHtml(name)}" data-key="key" value="${escapeHtml(source.key)}" />
        </label>
      </section>
    `).join('');
    return;
  }

  if (state.activePanel === 'speed') {
    elements.drawerTitle.textContent = m.drawerSpeedTitle;
    elements.drawerContent.innerHTML = `
      <section class="drawer-section">
        <label class="drawer-field">
          <span>${m.minSpeedLabel}</span>
          <input id="drawerMinSpeed" type="number" step="0.1" value="${state.profile.speed_test.min_download_mb_s}" />
        </label>
        <label class="drawer-field">
          <span>${m.timeoutLabel}</span>
          <input id="drawerTimeout" type="number" value="${state.profile.speed_test.timeout_seconds}" />
        </label>
        <label class="drawer-field">
          <span>${m.concurrencyLabel}</span>
          <input id="drawerConcurrency" type="number" value="${state.profile.speed_test.concurrency}" />
        </label>
        <label class="drawer-field">
          <span>${m.speedUrlsLabel}</span>
          <textarea id="drawerSpeedUrls" rows="8">${escapeHtml(state.profile.speed_test.urls.join('\n'))}</textarea>
        </label>
      </section>
    `;
    return;
  }

  elements.drawerTitle.textContent = m.drawerDeployTitle;
  elements.drawerContent.innerHTML = `
    <section class="drawer-section">
      <label class="drawer-field">
        <span>${m.projectNameLabel}</span>
        <input id="drawerProjectName" value="${escapeHtml(state.profile.deploy.project_name)}" />
      </label>
      <label class="drawer-field">
        <span>${m.pagesSecretLabel}</span>
        <input id="drawerPagesUrl" value="${escapeHtml(state.profile.deploy.pages_project_url)}" />
      </label>
      <label class="drawer-field">
        <span>${m.subscriptionUrlLabel}</span>
        <input id="drawerSubscriptionUrl" value="${escapeHtml(state.profile.deploy.subscription_url)}" />
      </label>
    </section>
  `;
}

function handleDrawerSave() {
  const m = getMessages(state.language);
  syncActiveDrawerIntoProfile();
  renderAll();
  closeDrawer();
  appendLog(m.profileSaved);
}

function syncActiveDrawerIntoProfile() {
  if (!state.activePanel) {
    return;
  }

  if (state.activePanel === 'sources') {
    Object.keys(state.profile.sources).forEach((name) => {
      const url = elements.drawerContent.querySelector(`input[data-source="${name}"][data-key="url"]`);
      const key = elements.drawerContent.querySelector(`input[data-source="${name}"][data-key="key"]`);
      const enabled = elements.drawerContent.querySelector(`input[data-source="${name}"][data-key="enabled"]`);
      if (!url || !key || !enabled) {
        return;
      }
      state.profile.sources[name].url = url.value.trim();
      state.profile.sources[name].key = key.value.trim();
      state.profile.sources[name].enabled = enabled.checked;
    });
    return;
  }

  if (state.activePanel === 'speed') {
    const minSpeed = elements.drawerContent.querySelector('#drawerMinSpeed');
    const timeout = elements.drawerContent.querySelector('#drawerTimeout');
    const concurrency = elements.drawerContent.querySelector('#drawerConcurrency');
    const speedUrls = elements.drawerContent.querySelector('#drawerSpeedUrls');
    if (!minSpeed || !timeout || !concurrency || !speedUrls) {
      return;
    }
    state.profile.speed_test.min_download_mb_s = Number(minSpeed.value);
    state.profile.speed_test.timeout_seconds = Number(timeout.value);
    state.profile.speed_test.concurrency = Number(concurrency.value);
    state.profile.speed_test.urls = speedUrls.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return;
  }

  const projectName = elements.drawerContent.querySelector('#drawerProjectName');
  const pagesProjectUrl = elements.drawerContent.querySelector('#drawerPagesUrl');
  const subscriptionUrl = elements.drawerContent.querySelector('#drawerSubscriptionUrl');
  if (!projectName || !pagesProjectUrl || !subscriptionUrl) {
    return;
  }
  state.profile.deploy.project_name = projectName.value.trim();
  state.profile.deploy.pages_project_url = pagesProjectUrl.value.trim();
  state.profile.deploy.subscription_url = subscriptionUrl.value.trim();
}

function handleLanguageChange() {
  state.language = elements.languageSelect.value;
  localStorage.setItem(LANGUAGE_STORAGE_KEY, state.language);
  renderAll();
}

async function saveProfile() {
  syncActiveDrawerIntoProfile();
  renderAll();
  if (window.vpnAutomation) {
    await window.vpnAutomation.saveProfile(state.profile);
  }
  appendLog(getMessages(state.language).profileSaved);
}

async function runPipeline() {
  const m = getMessages(state.language);
  syncActiveDrawerIntoProfile();
  elements.runBtn.disabled = true;
  appendLog(m.pipelineStarted);
  state.stageStatus = {};
  state.counts = {};
  renderAll();
  await saveProfile();
  if (!window.vpnAutomation) {
    elements.runBtn.disabled = false;
    appendLog(formatMessage(m.pipelineFinished, { code: 'demo' }));
    return;
  }
  const result = await window.vpnAutomation.runPipeline();
  elements.runBtn.disabled = false;
  appendLog(formatMessage(m.pipelineFinished, { code: result.code }));
}

function handlePipelineEvent(event) {
  if (event.type === 'log') {
    appendLog(event.message);
    return;
  }
  if (event.type === 'stage') {
    state.stageStatus[event.stage] = event.status;
    renderStages();
    renderMetricsRibbon();
    renderSummaryCards();
    return;
  }
  if (event.type === 'summary') {
    state.stageStatus = event.stage_status;
    state.counts = event.counts;
    renderStages();
    renderMetricsRibbon();
    renderSummaryCards();
    appendLog(`[summary] artifacts: ${event.artifact_dir}`);
  }
}

function appendLog(message) {
  if (elements.logOutput.textContent.startsWith(getMessages(state.language).logPlaceholder)) {
    elements.logOutput.textContent = '';
  }
  elements.logOutput.textContent += `${message}\n`;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function createSummaryLine(text) {
  return `<div class="summary-line">${escapeHtml(text || '—')}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

bootstrap();
