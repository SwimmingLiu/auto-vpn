import { getMessages, resolveLanguage, LANGUAGE_STORAGE_KEY, formatMessage } from './i18n.js';
import { resolveRunControlState } from './state.js';
import {
  buildPageMarkup,
  buildShortcutStrip,
  buildSidebarNav,
  buildSidebarStatus,
  buildViewModel
} from './views.js';

const demoProfile = {
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

const state = {
  profile: null,
  unsubscribe: null,
  stageStatus: {},
  counts: {},
  language: 'zh-CN',
  activePage: 'dashboard',
  subtabs: {
    config: 'sources',
    logs: 'runtime',
    deploy: 'platform',
    settings: 'general'
  },
  isDemo: false,
  runState: 'idle',
  runResult: 'idle',
  logEntries: [],
  lastUpdateAt: null
};

const elements = {
  sidebarTitle: document.querySelector('#sidebarTitle'),
  sidebarVersion: document.querySelector('#sidebarVersion'),
  sidebarNav: document.querySelector('#sidebarNav'),
  sidebarStatusTitle: document.querySelector('#sidebarStatusTitle'),
  sidebarStatusBadge: document.querySelector('#sidebarStatusBadge'),
  sidebarStatusBody: document.querySelector('#sidebarStatusBody'),
  pageTitle: document.querySelector('#pageTitle'),
  pageSubtitle: document.querySelector('#pageSubtitle'),
  languageLabel: document.querySelector('#languageLabel'),
  languageSelect: document.querySelector('#languageSelect'),
  projectBtn: document.querySelector('#projectBtn'),
  topSettingsBtn: document.querySelector('#topSettingsBtn'),
  saveBtn: document.querySelector('#saveBtn'),
  stopBtn: document.querySelector('#stopBtn'),
  runBtn: document.querySelector('#runBtn'),
  runStateBadge: document.querySelector('#runStateBadge'),
  shortcutStrip: document.querySelector('#shortcutStrip'),
  pageContent: document.querySelector('#pageContent')
};

async function bootstrap() {
  state.language = resolveLanguage(
    localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? '',
    navigator.language
  );

  renderAll();
  bindActions();

  if (!window.vpnAutomation) {
    state.isDemo = true;
    state.profile = structuredClone(demoProfile);
    touchUpdate();
    renderAll();
    appendLog(getMessages(state.language).demoMode);
    return;
  }

  state.isDemo = false;
  state.profile = await window.vpnAutomation.loadProfile();
  touchUpdate();
  renderAll();
  state.unsubscribe = window.vpnAutomation.onPipelineEvent(handlePipelineEvent);
}

function bindActions() {
  elements.saveBtn.addEventListener('click', () => saveProfile());
  elements.runBtn.addEventListener('click', runPipeline);
  elements.stopBtn.addEventListener('click', stopPipeline);
  elements.languageSelect.addEventListener('change', () => {
    updateLanguage(elements.languageSelect.value);
  });

  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('input', handleDocumentInput);
  document.addEventListener('change', handleDocumentInput);
}

function renderAll() {
  const messages = getMessages(state.language);
  const viewModel = buildViewModel(state, messages, state.language);
  document.documentElement.lang = state.language;
  document.title = messages.appTitle;
  document.body.dataset.page = state.activePage;

  renderChrome(messages, viewModel);
  elements.pageContent.innerHTML = buildPageMarkup(
    state.activePage,
    viewModel,
    messages,
    state.language,
    state.subtabs
  );
}

function renderChrome(messages, viewModel) {
  const controlState = resolveRunControlState(state.runState);
  elements.sidebarTitle.textContent = messages.sidebarTitle;
  elements.sidebarVersion.textContent = messages.sidebarVersion;
  elements.pageTitle.textContent = messages.pageTitles[state.activePage];
  elements.pageSubtitle.textContent = messages.pageSubtitles[state.activePage];
  elements.languageLabel.textContent = messages.languageLabel;
  elements.languageSelect.value = state.language;
  elements.projectBtn.textContent = messages.projectButton;
  elements.topSettingsBtn.textContent = messages.settingsButton;
  elements.saveBtn.textContent = messages.saveButton;
  elements.stopBtn.textContent = messages.stopButton;
  elements.runBtn.textContent = resolveRunButtonLabel(messages);
  elements.runBtn.disabled = controlState.runDisabled;
  elements.stopBtn.disabled = controlState.stopDisabled;
  elements.sidebarStatusTitle.textContent = messages.sidebarStatusTitle;
  elements.sidebarStatusBadge.textContent = messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle;
  elements.sidebarStatusBadge.className = `badge ${runTone()}`;
  elements.runStateBadge.textContent = messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle;
  elements.runStateBadge.className = `badge ${runTone()}`;
  elements.sidebarNav.innerHTML = buildSidebarNav(messages, state.activePage);
  elements.shortcutStrip.innerHTML = buildShortcutStrip(messages);
  elements.sidebarStatusBody.innerHTML = buildSidebarStatus(viewModel, messages, state, state.language);
}

function resolveRunButtonLabel(messages) {
  if (state.runState === 'running') {
    return messages.runButtonRunning;
  }
  if (state.runState === 'stopping') {
    return messages.runButtonStopping;
  }
  return messages.runButton;
}

function runTone() {
  if (state.runState === 'running') {
    return 'success';
  }
  if (state.runState === 'stopping') {
    return 'warning';
  }
  return 'neutral';
}

function handleDocumentClick(event) {
  const navButton = event.target.closest('[data-page-target]');
  if (navButton) {
    state.activePage = navButton.dataset.pageTarget;
    renderAll();
    return;
  }

  const shortcut = event.target.closest('[data-shortcut-target]');
  if (shortcut) {
    state.activePage = shortcut.dataset.shortcutTarget;
    if (shortcut.dataset.shortcutTab) {
      state.subtabs[state.activePage] = shortcut.dataset.shortcutTab;
    }
    renderAll();
    return;
  }

  const subtab = event.target.closest('[data-subtab-page]');
  if (subtab) {
    state.subtabs[subtab.dataset.subtabPage] = subtab.dataset.subtab;
    renderAll();
    return;
  }

  if (event.target.closest('#projectBtn')) {
    state.activePage = 'subscriptions';
    renderAll();
    return;
  }

  if (event.target.closest('#topSettingsBtn')) {
    state.activePage = 'settings';
    renderAll();
    return;
  }

  const copyButton = event.target.closest('[data-copy-text]');
  if (copyButton) {
    copyText(copyButton.dataset.copyText);
  }
}

function handleDocumentInput(event) {
  const target = event.target;

  if (target.id === 'settingsLanguage') {
    updateLanguage(target.value);
    return;
  }

  if (!state.profile) {
    return;
  }

  if (target.matches('[data-source][data-key]')) {
    const sourceName = target.dataset.source;
    const key = target.dataset.key;
    if (!state.profile.sources[sourceName]) {
      return;
    }
    state.profile.sources[sourceName][key] =
      target.type === 'checkbox' ? target.checked : target.value.trim();
  }
}

async function copyText(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // Ignore clipboard failures in browser demo mode.
  }

  appendLog(formatMessage(getMessages(state.language).copiedMessage, { value: text }));
}

function updateLanguage(language) {
  state.language = language;
  localStorage.setItem(LANGUAGE_STORAGE_KEY, state.language);
  renderAll();
}

async function saveProfile({ silent = false } = {}) {
  if (!state.profile) {
    return;
  }

  if (window.vpnAutomation) {
    await window.vpnAutomation.saveProfile(state.profile);
  }
  touchUpdate();
  renderAll();
  if (!silent) {
    appendLog(getMessages(state.language).profileSaved);
  }
}

async function runPipeline() {
  if (state.runState !== 'idle' || !state.profile) {
    return;
  }

  const messages = getMessages(state.language);
  state.runState = 'running';
  state.runResult = 'running';
  state.stageStatus = {};
  state.counts = {};
  state.logEntries = [];
  touchUpdate();
  renderAll();
  appendLog(messages.pipelineStarted);
  await saveProfile({ silent: true });

  if (!window.vpnAutomation) {
    state.runState = 'idle';
    state.runResult = 'demo';
    touchUpdate();
    renderAll();
    appendLog(formatMessage(messages.pipelineFinished, { code: 'demo' }));
    return;
  }

  try {
    const result = await window.vpnAutomation.runPipeline();
    finishRun(result);
  } catch (error) {
    state.runState = 'idle';
    state.runResult = 'failed';
    touchUpdate();
    renderAll();
    appendLog(formatMessage(messages.pipelineFailed, { error: error.message }));
  }
}

async function stopPipeline() {
  const messages = getMessages(state.language);
  if (!window.vpnAutomation || state.runState !== 'running') {
    appendLog(messages.stopUnavailable);
    return;
  }

  state.runState = 'stopping';
  touchUpdate();
  renderAll();
  appendLog(messages.pipelineStopping);

  const result = await window.vpnAutomation.stopPipeline();
  if (!result?.ok) {
    state.runState = 'running';
    touchUpdate();
    renderAll();
    appendLog(messages.stopUnavailable);
  }
}

function finishRun(result = {}) {
  const messages = getMessages(state.language);
  state.runState = 'idle';

  if (result.stopped) {
    state.runResult = 'stopped';
    touchUpdate();
    renderAll();
    appendLog(messages.pipelineStopped);
    return;
  }

  if (result.ok) {
    state.runResult = 'success';
    touchUpdate();
    renderAll();
    appendLog(formatMessage(messages.pipelineFinished, { code: result.code ?? 0 }));
    return;
  }

  state.runResult = 'failed';
  touchUpdate();
  renderAll();
  if (result.error) {
    appendLog(formatMessage(messages.pipelineFailed, { error: result.error }));
  } else {
    appendLog(formatMessage(messages.pipelineFinished, { code: result.code ?? 'error' }));
  }
}

function handlePipelineEvent(event) {
  if (event.type === 'log') {
    appendLog(event.message);
    return;
  }

  if (event.type === 'stage') {
    state.stageStatus[event.stage] = event.status;
    touchUpdate();
    renderAll();
    return;
  }

  if (event.type === 'summary') {
    state.stageStatus = event.stage_status;
    state.counts = event.counts;
    touchUpdate();
    renderAll();
    appendLog(`[summary] artifacts: ${event.artifact_dir}`);
  }
}

function appendLog(message) {
  state.logEntries.push(String(message));
  touchUpdate();
  renderAll();
}

function touchUpdate() {
  state.lastUpdateAt = Date.now();
}

bootstrap();
