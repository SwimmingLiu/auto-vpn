import { getMessages, resolveLanguage, LANGUAGE_STORAGE_KEY, formatMessage } from './i18n.js';
import { buildStageModel, toMetricItems } from './state.js';

const state = {
  profile: null,
  unsubscribe: null,
  stageStatus: {},
  counts: {},
  language: 'zh-CN'
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
  brandTitle: document.querySelector('#brandTitle'),
  brandSubtitle: document.querySelector('#brandSubtitle'),
  navOverview: document.querySelector('#navOverview'),
  navSources: document.querySelector('#navSources'),
  navSpeedTest: document.querySelector('#navSpeedTest'),
  navDeploy: document.querySelector('#navDeploy'),
  navHistory: document.querySelector('#navHistory'),
  sidebarPillPages: document.querySelector('#sidebarPillPages'),
  sidebarPillPipeline: document.querySelector('#sidebarPillPipeline'),
  eyebrow: document.querySelector('#eyebrow'),
  heroTitle: document.querySelector('#heroTitle'),
  heroBody: document.querySelector('#heroBody'),
  languageLabel: document.querySelector('#languageLabel'),
  languageSelect: document.querySelector('#languageSelect'),
  saveBtn: document.querySelector('#saveBtn'),
  runBtn: document.querySelector('#runBtn'),
  sourceMatrixTitle: document.querySelector('#sourceMatrixTitle'),
  sourceMatrixSubtitle: document.querySelector('#sourceMatrixSubtitle'),
  pipelineTitle: document.querySelector('#pipelineTitle'),
  pipelineSubtitle: document.querySelector('#pipelineSubtitle'),
  minSpeedLabel: document.querySelector('#minSpeedLabel'),
  timeoutSecondsLabel: document.querySelector('#timeoutSecondsLabel'),
  concurrencyLabel: document.querySelector('#concurrencyLabel'),
  projectNameLabel: document.querySelector('#projectNameLabel'),
  pagesProjectUrlLabel: document.querySelector('#pagesProjectUrlLabel'),
  subscriptionUrlLabel: document.querySelector('#subscriptionUrlLabel'),
  speedUrlsLabel: document.querySelector('#speedUrlsLabel'),
  metricsTitle: document.querySelector('#metricsTitle'),
  metricsSubtitle: document.querySelector('#metricsSubtitle'),
  stagesTitle: document.querySelector('#stagesTitle'),
  stagesSubtitle: document.querySelector('#stagesSubtitle'),
  logsTitle: document.querySelector('#logsTitle'),
  logsSubtitle: document.querySelector('#logsSubtitle'),
  sourcesGrid: document.querySelector('#sourcesGrid'),
  minSpeed: document.querySelector('#minSpeed'),
  timeoutSeconds: document.querySelector('#timeoutSeconds'),
  concurrency: document.querySelector('#concurrency'),
  projectName: document.querySelector('#projectName'),
  pagesProjectUrl: document.querySelector('#pagesProjectUrl'),
  subscriptionUrl: document.querySelector('#subscriptionUrl'),
  speedUrls: document.querySelector('#speedUrls'),
  metrics: document.querySelector('#metrics'),
  stages: document.querySelector('#stages'),
  logOutput: document.querySelector('#logOutput')
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

function renderAll() {
  renderStaticCopy();
  renderProfile();
  renderStages();
  renderMetrics();
}

function renderStaticCopy() {
  const m = getMessages(state.language);
  document.documentElement.lang = state.language;
  document.title = m.appTitle;

  elements.brandTitle.textContent = m.appTitle;
  elements.brandSubtitle.textContent = m.brandSubtitle;
  elements.navOverview.textContent = m.navOverview;
  elements.navSources.textContent = m.navSources;
  elements.navSpeedTest.textContent = m.navSpeedTest;
  elements.navDeploy.textContent = m.navDeploy;
  elements.navHistory.textContent = m.navHistory;
  elements.sidebarPillPages.textContent = m.sidebarPillPages;
  elements.sidebarPillPipeline.textContent = m.sidebarPillPipeline;
  elements.eyebrow.textContent = m.eyebrow;
  elements.heroTitle.textContent = m.heroTitle;
  elements.heroBody.textContent = m.heroBody;
  elements.languageLabel.textContent = m.languageLabel;
  elements.languageSelect.value = state.language;
  elements.saveBtn.textContent = m.saveButton;
  elements.runBtn.textContent = m.runButton;
  elements.sourceMatrixTitle.textContent = m.sourceMatrixTitle;
  elements.sourceMatrixSubtitle.textContent = m.sourceMatrixSubtitle;
  elements.pipelineTitle.textContent = m.pipelineTitle;
  elements.pipelineSubtitle.textContent = m.pipelineSubtitle;
  elements.minSpeedLabel.textContent = m.minSpeed;
  elements.timeoutSecondsLabel.textContent = m.timeoutSeconds;
  elements.concurrencyLabel.textContent = m.concurrency;
  elements.projectNameLabel.textContent = m.projectName;
  elements.pagesProjectUrlLabel.textContent = m.pagesProjectUrl;
  elements.subscriptionUrlLabel.textContent = m.subscriptionUrl;
  elements.speedUrlsLabel.textContent = m.speedUrls;
  elements.metricsTitle.textContent = m.metricsTitle;
  elements.metricsSubtitle.textContent = m.metricsSubtitle;
  elements.stagesTitle.textContent = m.stagesTitle;
  elements.stagesSubtitle.textContent = m.stagesSubtitle;
  elements.logsTitle.textContent = m.logsTitle;
  elements.logsSubtitle.textContent = m.logsSubtitle;
}

function renderProfile() {
  const m = getMessages(state.language);
  const { sources, speed_test: speed, deploy } = state.profile;
  elements.sourcesGrid.innerHTML = '';
  Object.entries(sources).forEach(([name, source]) => {
    const card = document.createElement('div');
    card.className = 'source-card';
    card.innerHTML = `
      <div class="source-top">
        <div>
          <div class="source-name">${name}</div>
          <div class="source-meta">${m.sourceEnabled}</div>
        </div>
        <button class="toggle ${source.enabled ? 'enabled' : ''}" data-source="${name}" data-role="toggle" aria-label="${m.sourceEnabled}"></button>
      </div>
      <label class="source-field">
        <span>${m.sourceUrl}</span>
        <input data-source="${name}" data-key="url" value="${escapeHtml(source.url)}" />
      </label>
      <label class="source-field source-field-key">
        <span>${m.sourceKey}</span>
        <input data-source="${name}" data-key="key" value="${escapeHtml(source.key)}" />
      </label>
    `;
    elements.sourcesGrid.appendChild(card);
  });

  elements.minSpeed.value = speed.min_download_mb_s;
  elements.timeoutSeconds.value = speed.timeout_seconds;
  elements.concurrency.value = speed.concurrency;
  elements.projectName.value = deploy.project_name;
  elements.pagesProjectUrl.value = deploy.pages_project_url;
  elements.subscriptionUrl.value = deploy.subscription_url;
  elements.speedUrls.value = speed.urls.join('\n');

  elements.sourcesGrid.querySelectorAll('[data-role="toggle"]').forEach((button) => {
    button.addEventListener('click', () => {
      const source = button.dataset.source;
      state.profile.sources[source].enabled = !state.profile.sources[source].enabled;
      renderProfile();
    });
  });
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

function renderMetrics() {
  const m = getMessages(state.language);
  const cards = toMetricItems(state.counts);
  if (cards.length === 0) {
    elements.metrics.innerHTML = `
      <div class="metric-card">
        <div class="metric-label">${m.metricFallbackLabel}</div>
        <div class="metric-value">${m.metricFallbackValue}</div>
      </div>
    `;
    return;
  }
  elements.metrics.innerHTML = cards.map((card) => `
    <div class="metric-card">
      <div class="metric-label">${card.label}</div>
      <div class="metric-value">${card.value}</div>
    </div>
  `).join('');
}

function bindActions() {
  elements.saveBtn.addEventListener('click', saveProfile);
  elements.runBtn.addEventListener('click', runPipeline);
  elements.languageSelect.addEventListener('change', handleLanguageChange);
}

function handleLanguageChange() {
  state.language = elements.languageSelect.value;
  localStorage.setItem(LANGUAGE_STORAGE_KEY, state.language);
  renderAll();
}

async function saveProfile() {
  syncInputsIntoProfile();
  if (window.vpnAutomation) {
    await window.vpnAutomation.saveProfile(state.profile);
  }
  appendLog(getMessages(state.language).profileSaved);
}

async function runPipeline() {
  const m = getMessages(state.language);
  elements.runBtn.disabled = true;
  appendLog(m.pipelineStarted);
  state.stageStatus = {};
  state.counts = {};
  renderStages();
  renderMetrics();
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
    return;
  }
  if (event.type === 'summary') {
    state.stageStatus = event.stage_status;
    state.counts = event.counts;
    renderStages();
    renderMetrics();
    appendLog(`[summary] artifacts: ${event.artifact_dir}`);
  }
}

function syncInputsIntoProfile() {
  Object.entries(state.profile.sources).forEach(([name, source]) => {
    source.url = elements.sourcesGrid.querySelector(`input[data-source="${name}"][data-key="url"]`).value.trim();
    source.key = elements.sourcesGrid.querySelector(`input[data-source="${name}"][data-key="key"]`).value.trim();
  });
  state.profile.speed_test.min_download_mb_s = Number(elements.minSpeed.value);
  state.profile.speed_test.timeout_seconds = Number(elements.timeoutSeconds.value);
  state.profile.speed_test.concurrency = Number(elements.concurrency.value);
  state.profile.speed_test.urls = elements.speedUrls.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  state.profile.deploy.project_name = elements.projectName.value.trim();
  state.profile.deploy.pages_project_url = elements.pagesProjectUrl.value.trim();
  state.profile.deploy.subscription_url = elements.subscriptionUrl.value.trim();
}

function appendLog(message) {
  elements.logOutput.textContent += `${message}\n`;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

bootstrap();
