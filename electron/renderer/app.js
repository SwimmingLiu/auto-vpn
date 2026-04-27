import { getMessages, formatMessage } from './i18n.js';
import { resolveRunControlState } from './state.js';
import {
  addAvailabilityTargetDraft,
  applyAvailabilityTargetDraft,
  applySourceIterationDraft,
  buildAvailabilityTargetDraft,
  buildPageMarkup,
  buildDashboardMetricsMarkup,
  buildLogCenterMarkup,
  buildRunsCurrentStageMarkup,
  buildRunsStageProgressMarkup,
  buildSourceIterationDraft,
  buildSidebarNav,
  buildViewModel,
  buildTopbarActions,
  removeAvailabilityTargetDraft,
  classifyLogEntry,
  extractSourceUrlFromCurl,
  filterLogEntries
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
  availability_targets: {
    gemini: {
      url: 'https://gemini.google.com/',
      enabled: true,
      allowed_hosts: ['gemini.google.com', 'accounts.google.com'],
      negative_phrases: ['not available in your country', 'not available in your region']
    },
    chatgpt: {
      url: 'https://chatgpt.com/',
      enabled: true,
      allowed_hosts: ['chatgpt.com', 'chat.openai.com'],
      negative_phrases: ['unsupported country', 'unsupported region']
    },
    claude: {
      url: 'https://claude.ai/',
      enabled: true,
      allowed_hosts: ['claude.ai'],
      negative_phrases: ['unavailable in your region']
    }
  },
  deploy: {
    project_name: 'vpn-auto',
    pages_project_url: 'https://vpn-auto.pages.dev',
    subscription_url: 'https://vpn.example.top/179ba8dd-3854-4747-b853-fc1868ef3937'
  },
  paths: {
    project_root: '/Users/user/vpn-sub',
    artifacts_root: '/Users/user/vpn-sub/artifacts'
  },
  workspace: {
    project_root: '/Users/user/vpn-sub',
    artifacts_root: '/Users/user/vpn-sub/artifacts',
    state_root: '/Users/user/vpn-sub/state',
    profile_path: '/Users/user/vpn-sub/state/profile.toml'
  }
};

const state = {
  profile: null,
  savedProfile: null,
  unsubscribe: null,
  stageStatus: {},
  counts: {},
  sourceCounts: {},
  language: 'zh-CN',
  activePage: 'dashboard',
  subtabs: {},
  subscriptionFormat: 'Clash',
  logFilter: '全部',
  settingsDrawer: null,
  isDemo: false,
  runState: 'idle',
  runResult: 'idle',
  logEntries: [],
  artifactDir: '',
  retryArtifacts: [],
  selectedRetryArtifactDir: '',
  selectedRetryStage: '',
  outputFiles: [],
  nodeRows: [],
  qrDataUrl: '',
  runStartedAt: null,
  lastUpdateAt: null,
  modalTransform: ''
};

const elements = {
  sidebarTitle: document.querySelector('#sidebarTitle'),
  sidebarVersion: document.querySelector('#sidebarVersion'),
  sidebarNav: document.querySelector('#sidebarNav'),
  pageTitle: document.querySelector('#pageTitle'),
  pageSubtitle: document.querySelector('#pageSubtitle'),
  runStateBadge: document.querySelector('#runStateBadge'),
  pageActions: document.querySelector('#pageActions'),
  pageContent: document.querySelector('#pageContent')
};

async function bootstrap() {
  state.language = 'zh-CN';
  renderAll();
  bindActions();

  if (!window.vpnAutomation) {
    state.isDemo = true;
    state.profile = structuredClone(demoProfile);
    state.savedProfile = structuredClone(demoProfile);
    touchUpdate();
    renderAll();
    appendLog(getMessages(state.language).demoMode);
    return;
  }

  state.isDemo = false;
  const loadedProfile = await window.vpnAutomation.loadProfile();
  state.profile = loadedProfile;
  state.savedProfile = structuredClone(loadedProfile);
  touchUpdate();
  await refreshQrCode();
  await hydrateRetryArtifacts();
  await hydrateLatestArtifact();
  renderAll();
  state.unsubscribe = window.vpnAutomation.onPipelineEvent(handlePipelineEvent);
}

function bindActions() {
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('input', handleDocumentInput);
  document.addEventListener('change', handleDocumentInput);
  
  document.addEventListener('mousedown', (e) => {
    const header = e.target.closest('.settings-drawer-head');
    if (!header) return;
    
    const panel = header.closest('.settings-drawer-panel');
    if (!panel) return;
    
    e.preventDefault();
    
    let startX = e.clientX;
    let startY = e.clientY;
    
    const style = window.getComputedStyle(panel);
    // Parse matrix to get current X/Y translate
    const matrix = new DOMMatrixReadOnly(style.transform);
    let currentX = matrix.m41;
    let currentY = matrix.m42;
    
    const onMouseMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const newTransform = `scale(1) translate(${currentX + dx}px, ${currentY + dy}px)`;
      panel.style.transform = newTransform;
      state.modalTransform = newTransform;
    };
    
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
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
  elements.runStateBadge.textContent = messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle;
  elements.runStateBadge.className = `badge ${runTone()}`;
  elements.sidebarNav.innerHTML = buildSidebarNav(messages, state.activePage);
  elements.pageActions.innerHTML = buildTopbarActions(state.activePage, viewModel, messages, {
    runDisabled: controlState.runDisabled,
    stopDisabled: controlState.stopDisabled,
    runLabel: resolveRunButtonLabel(messages),
    stopLabel: messages.stopButton,
    saveLabel: messages.saveButton
  });
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

  const subtab = event.target.closest('[data-subtab-page]');
  if (subtab) {
    state.subtabs[subtab.dataset.subtabPage] = subtab.dataset.subtab;
    renderAll();
    return;
  }

  const formatButton = event.target.closest('[data-subscription-format]');
  if (formatButton) {
    state.subscriptionFormat = formatButton.dataset.subscriptionFormat;
    refreshQrCode();
    renderAll();
    return;
  }

  const logFilterButton = event.target.closest('[data-log-filter]');
  if (logFilterButton) {
    state.logFilter = logFilterButton.dataset.logFilter;
    renderAll();
    return;
  }

  const copyButton = event.target.closest('[data-copy-text]');
  if (copyButton) {
    copyText(copyButton.dataset.copyText);
    return;
  }

  const runAction = event.target.closest('[data-run-action]');
  if (runAction?.dataset.runAction === 'start') {
    runPipeline();
    return;
  }
  if (runAction?.dataset.runAction === 'stop') {
    stopPipeline();
    return;
  }

  const retryArtifactSelect = event.target.closest('[data-run-retry-artifact]');
  if (retryArtifactSelect) {
    state.selectedRetryArtifactDir = retryArtifactSelect.value;
    touchUpdate();
    renderAll();
    return;
  }

  const retryStageSelect = event.target.closest('[data-run-retry-stage]');
  if (retryStageSelect) {
    state.selectedRetryStage = retryStageSelect.value;
    touchUpdate();
    renderAll();
    return;
  }

  const openUrlButton = event.target.closest('[data-open-url]');
  if (openUrlButton) {
    openUrl(openUrlButton.dataset.openUrl);
    return;
  }

  const action = event.target.closest('[data-action]');
  if (action?.dataset.action === 'open-settings') {
    state.activePage = 'settings';
    renderAll();
    return;
  }
  if (action?.dataset.action === 'save-profile') {
    saveProfile();
    return;
  }
  if (action?.dataset.action === 'open-artifact-dir') {
    openArtifactDir();
    return;
  }
  if (action?.dataset.action === 'copy-nodes') {
    copyText((state.nodeRows ?? []).map((row) => row.link || row.name).filter(Boolean).join('\n'));
    return;
  }
  if (action?.dataset.action === 'retry-stage') {
    retryStage();
    return;
  }
  if (action?.dataset.action === 'copy-log') {
    copyText(resolveVisibleLogEntries().map((entry) => entry.line).join('\n'));
    return;
  }
  if (action?.dataset.action === 'clear-log') {
    state.logEntries = [];
    renderAll();
    return;
  }
  if (action?.dataset.action === 'open-log-file') {
    openCurrentLogFile();
    return;
  }

  const settingsCard = event.target.closest('[data-settings-card]');
  if (settingsCard) {
    openSettingsDrawer(settingsCard.dataset.settingsCard);
    return;
  }

  const availabilityAction = event.target.closest('[data-availability-action]');
  if (availabilityAction) {
    handleAvailabilityTargetAction(availabilityAction);
    return;
  }

  if (event.target.closest('[data-drawer-dismiss="backdrop"]')) {
    state.settingsDrawer = null;
    state.modalTransform = '';
    renderAll();
    return;
  }

  if (event.target.closest('[data-drawer-close="cancel"]')) {
    state.settingsDrawer = null;
    state.modalTransform = '';
    renderAll();
    return;
  }

  if (event.target.closest('[data-drawer-save="save"]')) {
    saveSettingsDrawer();
  }
}

function handleDocumentInput(event) {
  const target = event.target;

  if (!state.profile) {
    return;
  }

  if (target.matches('[data-run-retry-artifact]')) {
    state.selectedRetryArtifactDir = target.value;
    const selectedArtifact = (state.retryArtifacts ?? []).find((item) => item.artifact_dir === target.value);
    state.selectedRetryStage = resolveDefaultRetryStage(selectedArtifact);
    touchUpdate();
    renderAll();
    return;
  }

  if (target.matches('[data-run-retry-stage]')) {
    state.selectedRetryStage = target.value;
    touchUpdate();
    renderAll();
    return;
  }

  if (target.matches('[data-drawer-source][data-drawer-key]')) {
    if (!state.settingsDrawer?.draft) {
      return;
    }
    const sourceDraft = resolveDrawerSourceDraft();
    const sourceName = target.dataset.drawerSource;
    const key = target.dataset.drawerKey;
    if (!sourceDraft?.[sourceName]) {
      return;
    }
    const rawValue = target.type === 'checkbox' ? target.checked : target.value.trim();
    const normalizedValue = key === 'url' && typeof rawValue === 'string'
      ? normalizeSourceUrlInput(rawValue)
      : rawValue;
    if (target.type !== 'checkbox' && normalizedValue !== target.value) {
      target.value = normalizedValue;
    }
    sourceDraft[sourceName][key] =
      target.type === 'checkbox'
        ? normalizedValue
        : coerceProfileValue(normalizedValue, sourceDraft[sourceName][key]);
    return;
  }

  if (target.matches('[data-availability-index][data-availability-key]')) {
    updateAvailabilityTargetDraft(target);
    return;
  }

  if (target.matches('[data-drawer-path]')) {
    setDrawerPath(target.dataset.drawerPath, target.value.trim());
    return;
  }

  if (target.matches('[data-source][data-key]')) {
    const sourceName = target.dataset.source;
    const key = target.dataset.key;
    if (!state.profile.sources[sourceName]) {
      return;
    }
    state.profile.sources[sourceName][key] =
      target.type === 'checkbox' ? target.checked : coerceProfileValue(target.value.trim(), state.profile.sources[sourceName][key]);
    renderAll();
    return;
  }

  if (target.matches('[data-profile-path]')) {
    setProfilePath(target.dataset.profilePath, target.value.trim());
    if (target.dataset.profilePath === 'deploy.subscription_url') {
      refreshQrCode();
    }
    renderAll();
  }
}

function setProfilePath(path, value) {
  if (!state.profile) {
    return;
  }
  setObjectPath(state.profile, path, value);
}

function setDrawerPath(path, value) {
  if (!state.settingsDrawer?.draft) {
    return;
  }

  const section = state.settingsDrawer.section;
  const normalizedPath = String(path ?? '').startsWith(`${section}.`)
    ? String(path).slice(section.length + 1)
    : String(path ?? '');
  setObjectPath(state.settingsDrawer.draft, normalizedPath, value);
}

function resolveDrawerSourceDraft() {
  if (state.settingsDrawer?.section !== 'sources') {
    return null;
  }
  return state.settingsDrawer.draft?.sources ?? state.settingsDrawer.draft;
}

function normalizeSourceUrlInput(value) {
  const text = String(value ?? '').trim();
  if (!/^curl(?:\s|$)/i.test(text)) {
    return text;
  }
  return extractSourceUrlFromCurl(text) || text;
}

function setObjectPath(root, path, value) {
  const segments = String(path ?? '').split('.').filter(Boolean);
  if (!segments.length || !root) {
    return;
  }

  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    if (!cursor[segment]) {
      return;
    }
    cursor = cursor[segment];
  }

  const key = segments.at(-1);
  cursor[key] = coerceProfileValue(value, cursor[key]);
}

function coerceProfileValue(value, currentValue) {
  if (typeof currentValue === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : currentValue;
  }
  return value;
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

async function openUrl(url) {
  const value = String(url ?? '').trim();
  if (!value || !window.vpnAutomation?.openUrl) {
    return;
  }
  try {
    await window.vpnAutomation.openUrl(value);
  } catch (error) {
    appendLog(formatMessage(getMessages(state.language).openFailed, { error: error.message }));
  }
}

async function openArtifactDir() {
  const artifactDir = state.artifactDir || resolveProfilePaths().artifacts_root;
  if (!artifactDir || !window.vpnAutomation?.openPath) {
    return;
  }
  const result = await window.vpnAutomation.openPath(artifactDir);
  if (!result?.ok) {
    appendLog(formatMessage(getMessages(state.language).openFailed, { error: result?.error ?? 'unknown' }));
    return;
  }
  appendLog(formatMessage(getMessages(state.language).openedPathMessage, { value: artifactDir }));
}

async function openCurrentLogFile() {
  const artifactDir = state.artifactDir || resolveProfilePaths().artifacts_root;
  const logPath = artifactDir ? `${artifactDir}/human.log` : '';
  if (!logPath || !window.vpnAutomation?.openPath) {
    appendLog(formatMessage(getMessages(state.language).openFailed, { error: 'log_file_not_found' }));
    return;
  }

  const result = await window.vpnAutomation.openPath(logPath);
  if (!result?.ok) {
    appendLog(formatMessage(getMessages(state.language).openFailed, { error: result?.error ?? 'unknown' }));
    return;
  }
  appendLog(formatMessage(getMessages(state.language).openedPathMessage, { value: logPath }));
}

async function refreshQrCode() {
  const subscriptionUrl = resolveActiveSubscriptionUrl();
  if (!subscriptionUrl || !window.vpnAutomation?.generateQr) {
    state.qrDataUrl = '';
    return;
  }

  try {
    const result = await window.vpnAutomation.generateQr(subscriptionUrl);
    state.qrDataUrl = result?.dataUrl ?? '';
    renderAll();
  } catch {
    state.qrDataUrl = '';
  }
}

function resolveActiveSubscriptionUrl() {
  const baseUrl = state.profile?.deploy?.subscription_url ?? '';
  if (!baseUrl) {
    return '';
  }

  const format = state.subscriptionFormat ?? 'Clash';
  if (format === 'Clash') {
    return baseUrl;
  }
  return `${baseUrl}?format=${encodeURIComponent(format.toLowerCase().replaceAll(' ', '-'))}`;
}

function openSettingsDrawer(section) {
  if (!state.profile) {
    return;
  }

  const draft = buildSettingsDraft(section);
  if (!draft) {
    return;
  }

  state.modalTransform = '';
  state.settingsDrawer = { section, draft };
  renderAll();
}

function buildSettingsDraft(section) {
  if (!state.profile) {
    return null;
  }

  if (section === 'sources') return buildSourceIterationDraft(state.profile.sources);
  if (section === 'speed_test') return structuredClone(state.profile.speed_test);
  if (section === 'availability_targets') return buildAvailabilityTargetDraft(state.profile.availability_targets);
  if (section === 'deploy') return structuredClone(state.profile.deploy);
  if (section === 'paths') return structuredClone(state.profile.paths);
  if (section === 'about') return { version: getMessages(state.language).sidebarVersion };
  return null;
}

function resolveProfilePaths(profile = state.profile) {
  return {
    project_root: profile?.paths?.project_root ?? profile?.workspace?.project_root ?? '',
    artifacts_root: profile?.paths?.artifacts_root ?? profile?.workspace?.artifacts_root ?? '',
    state_root: profile?.paths?.state_root ?? profile?.workspace?.state_root ?? '',
    profile_path: profile?.paths?.profile_path ?? profile?.workspace?.profile_path ?? ''
  };
}

async function saveSettingsDrawer() {
  if (!state.settingsDrawer || !state.profile) {
    return;
  }

  const { section, draft } = state.settingsDrawer;
  if (section !== 'about') {
    state.profile[section] = resolveSettingsDraftPayload(section, draft);
  }
  state.settingsDrawer = null;
  state.modalTransform = '';
  touchUpdate();
  if (section === 'deploy') {
    await refreshQrCode();
  }
  if (section !== 'about') {
    await saveProfile({ silent: true });
    return;
  }
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

function resolveSettingsDraftPayload(section, draft) {
  if (section === 'sources') {
    return applySourceIterationDraft(draft.sources, draft);
  }
  if (section === 'availability_targets') {
    return applyAvailabilityTargetDraft(draft);
  }
  return structuredClone(draft);
}

function handleAvailabilityTargetAction(action) {
  if (state.settingsDrawer?.section !== 'availability_targets') {
    return;
  }
  if (action.dataset.availabilityAction === 'add') {
    addAvailabilityTargetDraft(state.settingsDrawer.draft, 'custom');
    renderAll();
    return;
  }
  if (action.dataset.availabilityAction === 'remove') {
    removeAvailabilityTargetDraft(state.settingsDrawer.draft, action.dataset.availabilityIndex);
    renderAll();
  }
}

function updateAvailabilityTargetDraft(target) {
  if (state.settingsDrawer?.section !== 'availability_targets') {
    return;
  }
  const index = Number(target.dataset.availabilityIndex);
  const key = target.dataset.availabilityKey;
  const row = state.settingsDrawer.draft?.targets?.[index];
  if (!row || !key) {
    return;
  }
  row[key] = target.type === 'checkbox' ? target.checked : target.value;
}

async function exportLogs() {
  if (!state.logEntries.length) {
    return;
  }

  const payload = resolveVisibleLogEntries().map((entry) => entry.line).join('\n');
  if (window.vpnAutomation?.exportLogs) {
    const result = await window.vpnAutomation.exportLogs(payload);
    if (result?.path) {
      appendLog(formatMessage(getMessages(state.language).exportedLogsMessage, { value: result.path }));
      return;
    }
  }

  await copyText(payload);
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
  state.sourceCounts = {};
  state.logEntries = [];
  state.artifactDir = '';
  state.outputFiles = [];
  state.nodeRows = [];
  state.selectedRetryStage = '';
  state.runStartedAt = Date.now();
  touchUpdate();
  renderAll();
  appendLog(messages.pipelineStarted);

  const runOptions = collectRunOptions();
  if (runOptions.saveBeforeRun) {
    await saveProfile({ silent: true });
  }

  if (!window.vpnAutomation) {
    state.runState = 'idle';
    state.runResult = 'demo';
    touchUpdate();
    renderAll();
    appendLog(formatMessage(messages.pipelineFinished, { code: 'demo' }));
    return;
  }

  try {
    const result = await window.vpnAutomation.runPipeline(runOptions);
    if (!result?.ok) {
      finishRun(result);
    }
  } catch (error) {
    state.runState = 'idle';
    state.runResult = 'failed';
    state.runStartedAt = null;
    touchUpdate();
    renderAll();
    appendLog(formatMessage(messages.pipelineFailed, { error: error.message }));
  }
}

async function retryStage() {
  if (state.runState !== 'idle' || !state.profile || !state.selectedRetryArtifactDir || !state.selectedRetryStage) {
    return;
  }

  const messages = getMessages(state.language);
  state.runState = 'running';
  state.runResult = 'running';
  state.stageStatus = {};
  state.counts = {};
  state.sourceCounts = {};
  state.logEntries = [];
  state.artifactDir = '';
  state.outputFiles = [];
  state.nodeRows = [];
  state.runStartedAt = Date.now();
  touchUpdate();
  renderAll();
  appendLog(`[retry] artifact=${state.selectedRetryArtifactDir} stage=${state.selectedRetryStage}`);

  const runOptions = collectRunOptions();
  if (runOptions.saveBeforeRun) {
    await saveProfile({ silent: true });
  }

  if (!window.vpnAutomation?.retryStage) {
    state.runState = 'idle';
    state.runResult = 'failed';
    state.runStartedAt = null;
    touchUpdate();
    renderAll();
    appendLog(formatMessage(messages.pipelineFailed, { error: 'retry bridge unavailable' }));
    return;
  }

  try {
    const result = await window.vpnAutomation.retryStage({
      artifactDir: state.selectedRetryArtifactDir,
      stage: state.selectedRetryStage,
      saveBeforeRun: runOptions.saveBeforeRun
    });
    if (!result?.ok) {
      finishRun(result);
    }
  } catch (error) {
    state.runState = 'idle';
    state.runResult = 'failed';
    state.runStartedAt = null;
    touchUpdate();
    renderAll();
    appendLog(formatMessage(messages.pipelineFailed, { error: error.message }));
  }
}

function collectRunOptions() {
  const optionInputs = document.querySelectorAll('[data-run-option]');
  const options = {
    skipDeploy: false,
    skipVerify: false,
    saveBeforeRun: true
  };
  for (const input of optionInputs) {
    options[input.dataset.runOption] = Boolean(input.checked);
  }
  return options;
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
  state.runStartedAt = null;

  if (result.stopped) {
    state.runResult = 'stopped';
    touchUpdate();
    renderAll();
    appendLog(messages.pipelineStopped);
    void hydrateRetryArtifacts();
    return;
  }

  if (result.ok) {
    state.runResult = 'success';
    touchUpdate();
    renderAll();
    appendLog(formatMessage(messages.pipelineFinished, { code: result.code ?? 0 }));
    void hydrateRetryArtifacts();
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
  void hydrateRetryArtifacts();
}

function handlePipelineEvent(event) {
  if (event.type === 'log') {
    appendLog(event.message);
    return;
  }

  if (event.type === 'stage') {
    state.stageStatus[event.stage] = event.status;
    appendLog(`[stage] ${event.stage} ${event.status}`, {
      kind: 'stage',
      stage: event.stage,
      level: event.status === 'failed' ? 'error' : event.status === 'running' ? 'warning' : 'info'
    });
    touchUpdate();
    renderRuntimeOnly({ chrome: false });
    return;
  }

  if (event.type === 'summary') {
    state.stageStatus = event.stage_status ?? {};
    state.counts = normalizeCounts(event.counts ?? {});
    state.sourceCounts = normalizeSourceCounts(event.source_counts ?? state.sourceCounts);
    state.artifactDir = event.artifact_dir ?? '';
    state.selectedRetryArtifactDir = state.artifactDir || state.selectedRetryArtifactDir;
    touchUpdate();
    renderAll();
    appendLog(`[summary] artifacts: ${event.artifact_dir}`);
    hydrateArtifactPreview();
    void hydrateRetryArtifacts();
    return;
  }

  if (event.type === 'extract_iteration') {
    updateExtractMetrics(event);
    touchUpdate();
    renderRuntimeOnly({ chrome: false });
    return;
  }

  if (event.type === 'speedtest_result') {
    if (event.passed_threshold) {
      state.counts.speedtest_links = Number(state.counts.speedtest_links ?? 0) + 1;
    }
    touchUpdate();
    renderRuntimeOnly({ chrome: false });
    return;
  }

  if (event.type === 'availability_link_result') {
    if (event.all_passed) {
      state.counts.availability_links = Number(state.counts.availability_links ?? 0) + 1;
    }
    touchUpdate();
    renderRuntimeOnly({ chrome: false });
    return;
  }

  if (event.type === 'finished') {
    finishRun(event);
    return;
  }

  if (event.type === 'run_started') {
    state.artifactDir = event.artifact_dir ?? '';
    touchUpdate();
    renderAll();
  }
}

function normalizeCounts(counts) {
  return {
    ...counts,
    raw_links: Number(counts.raw_links ?? 0),
    speedtest_links: Number(counts.speedtest_links ?? 0),
    availability_links: Number(counts.availability_links ?? 0),
    deduped_links: Number(counts.deduped_links ?? counts.postprocess_links ?? 0)
  };
}

function normalizeSourceCounts(sourceCounts = {}) {
  return Object.fromEntries(
    Object.entries(sourceCounts).map(([sourceName, counts]) => [
      sourceName,
      {
        ...counts,
        raw_links: Number(counts?.raw_links ?? 0),
        deduped_links: Number(counts?.deduped_links ?? 0)
      }
    ])
  );
}

function updateExtractMetrics(event) {
  const sourceName = event.source_name;
  if (!sourceName) {
    return;
  }

  const previous = state.sourceCounts[sourceName] ?? {};
  const rawLinks = Number(event.total_links ?? previous.raw_links ?? 0);
  state.sourceCounts = {
    ...state.sourceCounts,
    [sourceName]: {
      ...previous,
      raw_links: rawLinks
    }
  };
  state.counts.raw_links = Object.values(state.sourceCounts)
    .reduce((total, item) => total + Number(item?.raw_links ?? 0), 0);
}

async function hydrateArtifactPreview() {
  if (!state.artifactDir || !window.vpnAutomation?.previewArtifact) {
    state.outputFiles = [];
    state.nodeRows = [];
    return;
  }

  const result = await window.vpnAutomation.previewArtifact(state.artifactDir);
  if (result?.ok) {
    state.outputFiles = result.outputFiles ?? [];
    state.nodeRows = result.nodeRows ?? [];
    renderAll();
  }
}

async function hydrateLatestArtifact() {
  if (!window.vpnAutomation?.latestArtifact) {
    return;
  }

  try {
    const result = await window.vpnAutomation.latestArtifact();
    if (!result?.ok || !result.artifact_dir) {
      return;
    }
    state.artifactDir = result.artifact_dir;
    state.counts = normalizeCounts(result.counts ?? {});
    state.sourceCounts = normalizeSourceCounts(result.source_counts ?? {});
    state.outputFiles = result.outputFiles ?? [];
    state.nodeRows = result.nodeRows ?? [];
    state.runResult = result.run_status === 'success' ? 'success' : state.runResult;
    if (result.stage_status) {
      state.stageStatus = result.stage_status;
    }
    touchUpdate();
  } catch (error) {
    appendLog(formatMessage(getMessages(state.language).openFailed, { error: error.message }));
  }
}

async function hydrateRetryArtifacts() {
  if (!window.vpnAutomation?.artifactList) {
    return;
  }

  try {
    const result = await window.vpnAutomation.artifactList();
    if (!result?.ok) {
      return;
    }
    state.retryArtifacts = result.items ?? [];
    if (!state.selectedRetryArtifactDir) {
      state.selectedRetryArtifactDir = state.retryArtifacts[0]?.artifact_dir ?? '';
    }
    const selectedArtifact = state.retryArtifacts.find((item) => item.artifact_dir === state.selectedRetryArtifactDir) ?? state.retryArtifacts[0];
    const nextStage = selectedArtifact?.retryable_stages?.includes(state.selectedRetryStage)
      ? state.selectedRetryStage
      : resolveDefaultRetryStage(selectedArtifact);
    state.selectedRetryArtifactDir = selectedArtifact?.artifact_dir ?? '';
    state.selectedRetryStage = nextStage;
    touchUpdate();
  } catch (error) {
    appendLog(formatMessage(getMessages(state.language).openFailed, { error: error.message }));
  }
}

function resolveDefaultRetryStage(artifact) {
  const retryableStages = Array.isArray(artifact?.retryable_stages) ? artifact.retryable_stages : [];
  if (!retryableStages.length) {
    return '';
  }
  const failedStage = retryableStages.find((stage) => artifact?.stage_status?.[stage] === 'failed');
  return failedStage || retryableStages.at(-1) || '';
}

function appendLog(message, overrides = {}) {
  state.logEntries.push(classifyLogEntry(message, overrides));
  touchUpdate();
  renderRuntimeOnly({ chrome: false });
}

function renderRuntimeOnly({ chrome = true } = {}) {
  const messages = getMessages(state.language);
  const viewModel = buildViewModel(state, messages, state.language);
  if (chrome) {
    renderChrome(messages, viewModel);
  }
  renderActiveRuntimeSections(viewModel);
}

function renderActiveRuntimeSections(viewModel) {
  const logCenter = document.querySelector('#logCenterTable');
  if (logCenter) {
    logCenter.innerHTML = buildLogCenterMarkup(viewModel);
  }

  const stageProgress = document.querySelector('#runsStageProgress');
  if (stageProgress) {
    stageProgress.outerHTML = buildRunsStageProgressMarkup(viewModel);
  }

  const currentStage = document.querySelector('#runsCurrentStage');
  if (currentStage) {
    currentStage.outerHTML = buildRunsCurrentStageMarkup(viewModel);
  }

  const dashboardMetrics = document.querySelector('#dashboardMetricsPanel');
  if (dashboardMetrics) {
    dashboardMetrics.outerHTML = buildDashboardMetricsMarkup(viewModel);
  }
}

function resolveVisibleLogEntries() {
  return filterLogEntries((state.logEntries ?? []).map((entry) => classifyLogEntry(entry)), state.logFilter);
}

function touchUpdate() {
  state.lastUpdateAt = Date.now();
}

bootstrap();
