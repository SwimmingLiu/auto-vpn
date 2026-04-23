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
    leiting: { url: '', key: '', enabled: true },
    heidong: { url: '', key: '', enabled: true },
    mifeng: { url: '', key: '', enabled: true },
    xuanfeng1: { url: '', key: '', enabled: true },
    xuanfeng2: { url: '', key: '', enabled: true }
  },
  speed_test: {
    min_download_mb_s: 1.0,
    timeout_seconds: 20,
    concurrency: 3,
    urls: []
  },
  deploy: {
    project_name: '',
    pages_project_url: '',
    subscription_url: ''
  },
  workspace: {
    project_root: '',
    artifacts_root: '',
    state_root: '',
    profile_path: ''
  }
};

const state = {
  profile: null,
  savedProfile: null,
  unsubscribe: null,
  stageStatus: {},
  counts: {},
  language: 'zh-CN',
  activePage: 'dashboard',
  isDemo: false,
  runState: 'idle',
  runResult: 'idle',
  logEntries: [],
  lastUpdateAt: null,
  artifactDir: '',
  deployment: null
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
    state.savedProfile = structuredClone(demoProfile);
    touchUpdate();
    renderAll();
    return;
  }

  state.isDemo = false;
  const loadedProfile = await window.vpnAutomation.loadProfile();
  state.profile = loadedProfile;
  state.savedProfile = structuredClone(loadedProfile);
  touchUpdate();
  renderAll();
  state.unsubscribe = window.vpnAutomation.onPipelineEvent(handlePipelineEvent);
}

function bindActions() {
  elements.saveBtn.addEventListener('click', () => saveProfile());
  elements.runBtn.addEventListener('click', runPipeline);
  elements.stopBtn.addEventListener('click', stopPipeline);
  elements.languageSelect.addEventListener('change', () => updateLanguage(elements.languageSelect.value));
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
  elements.pageContent.innerHTML = buildPageMarkup(state.activePage, viewModel, messages, state.language);
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
  elements.shortcutStrip.innerHTML = buildShortcutStrip(messages, viewModel);
  elements.sidebarStatusBody.innerHTML = buildSidebarStatus(viewModel, messages);
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

async function handleDocumentClick(event) {
  const navButton = event.target.closest('[data-page-target]');
  if (navButton) {
    state.activePage = navButton.dataset.pageTarget;
    renderAll();
    return;
  }

  if (event.target.closest('#projectBtn')) {
    await openPath(state.profile?.workspace?.project_root ?? '');
    return;
  }

  if (event.target.closest('#topSettingsBtn')) {
    state.activePage = 'config';
    renderAll();
    return;
  }

  const actionButton = event.target.closest('[data-action]');
  if (actionButton) {
    await performAction(actionButton.dataset.action);
    return;
  }

  const copyButton = event.target.closest('[data-copy-text]');
  if (copyButton) {
    await copyText(copyButton.dataset.copyText);
  }
}

function handleDocumentInput(event) {
  const target = event.target;
  if (!state.profile) {
    return;
  }

  if (target.id === 'languageSelect') {
    updateLanguage(target.value);
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
    return;
  }

  if (target.matches('[data-section][data-key]')) {
    const section = target.dataset.section;
    const key = target.dataset.key;
    if (!state.profile[section]) {
      return;
    }

    if (section === 'speed_test' && key === 'urls') {
      state.profile.speed_test.urls = target.value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      return;
    }

    if (target.type === 'number') {
      state.profile[section][key] = Number(target.value);
      return;
    }

    state.profile[section][key] = target.value.trim();
  }
}

async function performAction(action) {
  switch (action) {
    case 'save-profile':
      await saveProfile();
      return;
    case 'reset-profile':
      resetProfile();
      return;
    case 'run-pipeline':
      await runPipeline();
      return;
    case 'stop-pipeline':
      await stopPipeline();
      return;
    case 'open-artifacts':
      await openPath(state.artifactDir || state.profile?.workspace?.artifacts_root || '');
      return;
    case 'export-logs':
      await exportLogs();
      return;
    default:
      return;
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
  state.savedProfile = structuredClone(state.profile);
  touchUpdate();
  renderAll();
  if (!silent) {
    appendLog(getMessages(state.language).profileSaved);
  }
}

function resetProfile() {
  state.profile = structuredClone(state.savedProfile ?? demoProfile);
  touchUpdate();
  renderAll();
  appendLog(getMessages(state.language).profileReset);
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
  state.artifactDir = '';
  state.deployment = null;
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
    state.artifactDir = event.artifact_dir ?? '';
    state.deployment = event.deployment ?? null;
    touchUpdate();
    renderAll();
    appendLog(`[summary] artifacts: ${event.artifact_dir}`);
  }
}

async function openPath(targetPath) {
  const normalized = String(targetPath ?? '').trim();
  if (!normalized) {
    return;
  }

  if (window.vpnAutomation?.openPath) {
    const result = await window.vpnAutomation.openPath(normalized);
    if (result?.ok) {
      appendLog(formatMessage(getMessages(state.language).openedPathMessage, { value: normalized }));
    }
    return;
  }

  appendLog(formatMessage(getMessages(state.language).openedPathMessage, { value: normalized }));
}

async function exportLogs() {
  if (!state.logEntries.length) {
    return;
  }

  const payload = state.logEntries.join('\n');
  if (window.vpnAutomation?.exportLogs) {
    const result = await window.vpnAutomation.exportLogs(payload);
    if (result?.path) {
      appendLog(formatMessage(getMessages(state.language).exportedLogsMessage, { value: result.path }));
      return;
    }
  }

  const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'vpn-automation-session.log';
  anchor.click();
  URL.revokeObjectURL(url);
  appendLog(formatMessage(getMessages(state.language).exportedLogsMessage, { value: anchor.download }));
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
