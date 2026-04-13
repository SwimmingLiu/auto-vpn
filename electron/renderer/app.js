import { buildStageModel, toMetricItems } from './state.js';

const state = {
  profile: null,
  unsubscribe: null,
  stageStatus: {},
  counts: {}
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
  logOutput: document.querySelector('#logOutput'),
  saveBtn: document.querySelector('#saveBtn'),
  runBtn: document.querySelector('#runBtn')
};

async function bootstrap() {
  if (!window.vpnAutomation) {
    state.profile = structuredClone(demoProfile);
    renderProfile();
    renderStages();
    renderMetrics();
    appendLog('[demo] running without Electron bridge');
    return;
  }

  state.profile = await window.vpnAutomation.loadProfile();
  renderProfile();
  renderStages();
  renderMetrics();
  bindActions();
  state.unsubscribe = window.vpnAutomation.onPipelineEvent(handlePipelineEvent);
}

function renderProfile() {
  const { sources, speed_test: speed, deploy } = state.profile;
  elements.sourcesGrid.innerHTML = '';
  Object.entries(sources).forEach(([name, source]) => {
    const card = document.createElement('div');
    card.className = 'source-card';
    card.innerHTML = `
      <div class="source-top">
        <div class="source-name">${name}</div>
        <button class="toggle ${source.enabled ? 'enabled' : ''}" data-source="${name}" data-role="toggle"></button>
      </div>
      <label class="source-field">
        <span>Capture URL</span>
        <input data-source="${name}" data-key="url" value="${escapeHtml(source.url)}" />
      </label>
      <label class="source-field" style="margin-top:12px;">
        <span>Key</span>
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
  const rows = buildStageModel(state.stageStatus);
  elements.stages.innerHTML = rows.map((row) => `
    <div class="stage-row">
      <span>${row.name}</span>
      <span class="stage-chip ${row.status}">${row.status.toUpperCase()}</span>
    </div>
  `).join('');
}

function renderMetrics() {
  const cards = toMetricItems(state.counts);
  if (cards.length === 0) {
    elements.metrics.innerHTML = `
      <div class="metric-card">
        <div class="metric-label">STATUS</div>
        <div class="metric-value">Idle</div>
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
}

async function saveProfile() {
  syncInputsIntoProfile();
  await window.vpnAutomation.saveProfile(state.profile);
  appendLog('[ui] profile saved');
}

async function runPipeline() {
  elements.runBtn.disabled = true;
  appendLog('[ui] pipeline started');
  state.stageStatus = {};
  state.counts = {};
  renderStages();
  renderMetrics();
  await saveProfile();
  const result = await window.vpnAutomation.runPipeline();
  elements.runBtn.disabled = false;
  appendLog(`[ui] pipeline finished with code ${result.code}`);
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
