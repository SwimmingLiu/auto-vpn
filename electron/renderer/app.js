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
  escapeHtml,
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
  },
  deploy: {
    project_name: 'sub-nodes',
    pages_project_url: 'https://sub-nodes.pages.dev',
    subscription_url: 'https://vpn.example.top/179ba8dd-3854-4747-b853-fc1868ef3937',
    verify_subscription_url: 'https://www.swimmingliu.online/sub?token=8410fb43eb2176497f5beafc0c39f5bc',
    cloudflare_api_token: '',
    pages_secret_admin: 'swimmingliu'
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
  runtime: document.body.dataset.runtime === 'web' ? 'web' : 'electron',
  runState: 'idle',
  runResult: 'idle',
  logEntries: [],
  extractDedupedFingerprints: new Set(),
  artifactDir: '',
  retryArtifacts: [],
  selectedRetryArtifactDir: '',
  selectedRetryStage: '',
  retryContext: {},
  deployment: {},
  outputFiles: [],
  nodeRows: [],
  toast: null,
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
  pageContent: document.querySelector('#pageContent'),
  toastRoot: document.querySelector('#toastRoot')
};

let toastTimer = null;

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
  const loadedState = window.vpnAutomation.loadState
    ? await window.vpnAutomation.loadState()
    : { profile: await window.vpnAutomation.loadProfile() };
  hydrateInitialRuntimeState(loadedState);
  hydrateHistoricalEvents(loadedState?.logEvents);
  touchUpdate();
  await refreshQrCode();
  if (!loadedState?.retryArtifacts) {
    await hydrateRetryArtifacts();
  }
  if (!loadedState?.artifact) {
    await hydrateLatestArtifact();
  }
  renderAll();
  state.unsubscribe = window.vpnAutomation.onPipelineEvent(handlePipelineEvent);
}

function hydrateInitialRuntimeState(loadedState = {}) {
  const loadedProfile = loadedState.profile ?? {};
  state.profile = loadedProfile;
  state.savedProfile = structuredClone(loadedProfile);
  const nextRunState = String(loadedState.runState ?? '');
  if (['idle', 'running', 'stopping', 'failed', 'success'].includes(nextRunState)) {
    state.runState = nextRunState;
    state.runResult = nextRunState === 'idle' ? state.runResult : nextRunState;
    state.runStartedAt = nextRunState === 'running' ? Date.now() : null;
  }
  if (loadedState.artifact) {
    hydrateArtifactState(loadedState.artifact);
  }
  if (Array.isArray(loadedState.retryArtifacts)) {
    hydrateRetryArtifactState(loadedState.retryArtifacts);
  }
  if (loadedState.deployment) {
    state.deployment = loadedState.deployment;
  }
}

function hydrateHistoricalEvents(events = []) {
  if (!Array.isArray(events) || events.length === 0) {
    return;
  }
  const previousRunState = state.runState;
  const previousRunResult = state.runResult;
  for (const event of events) {
    handlePipelineEvent(event, { historical: true });
  }
  state.runState = previousRunState;
  state.runResult = previousRunState === 'idle' ? previousRunResult : previousRunState;
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
  renderToast();
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
  if (state.runState === 'failed') {
    return 'danger';
  }
  if (state.runState === 'success') {
    return 'success';
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
    const messages = getMessages(state.language);
    const nodeLinks = (state.nodeRows ?? []).map((row) => row.link || row.name).filter(Boolean);
    copyText(nodeLinks.join('\n'), {
      emptyToast: messages.nothingToCopyMessage,
      successToast: formatMessage(messages.copiedNodesToastMessage, { count: nodeLinks.length }),
      successLog: formatMessage(messages.copiedNodesLogMessage, { count: nodeLinks.length }),
      failureToast: formatMessage(messages.copyFailedToastMessage, { error: '{error}' }),
      failureLog: formatMessage(messages.copyFailedLogMessage, { error: '{error}' })
    });
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
    handleDeployDrawerInput(target.dataset.drawerPath, target.value.trim(), target);
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

function normalizeDrawerPath(section, path) {
  return String(path ?? '').startsWith(`${section}.`)
    ? String(path).slice(section.length + 1)
    : String(path ?? '');
}

function setDrawerPath(path, value) {
  if (!state.settingsDrawer?.draft) {
    return;
  }

  const section = state.settingsDrawer.section;
  const normalizedPath = normalizeDrawerPath(section, path);
  setObjectPath(state.settingsDrawer.draft, normalizedPath, value);
}

function derivePagesProjectUrl(projectName) {
  const normalizedProjectName = String(projectName ?? '').trim();
  if (!normalizedProjectName) {
    return '';
  }
  return `https://${normalizedProjectName}.pages.dev`;
}

function buildDeployDraft(deploy = {}) {
  const draft = structuredClone(deploy);
  const derivedUrl = derivePagesProjectUrl(draft.project_name);
  if (!draft.pages_project_url && derivedUrl) {
    draft.pages_project_url = derivedUrl;
  }
  draft.__autoLinkedPagesProjectUrl = draft.pages_project_url === derivePagesProjectUrl(draft.project_name);
  return draft;
}

function sanitizeDeployDraft(draft = {}) {
  const sanitizedDraft = structuredClone(draft);
  delete sanitizedDraft.__autoLinkedPagesProjectUrl;
  return sanitizedDraft;
}

function handleDeployDrawerInput(path, value, target) {
  if (state.settingsDrawer?.section !== 'deploy' || !state.settingsDrawer.draft) {
    setDrawerPath(path, value);
    return;
  }

  const normalizedPath = normalizeDrawerPath('deploy', path);
  if (normalizedPath === 'project_name') {
    state.settingsDrawer.draft.project_name = value;
    if (state.settingsDrawer.draft.__autoLinkedPagesProjectUrl) {
      const derivedUrl = derivePagesProjectUrl(value);
      state.settingsDrawer.draft.pages_project_url = derivedUrl;
      const pagesUrlInput = document.querySelector('[data-drawer-path="deploy.pages_project_url"]');
      if (pagesUrlInput && pagesUrlInput !== target) {
        pagesUrlInput.value = derivedUrl;
      }
    }
    return;
  }

  if (normalizedPath === 'pages_project_url') {
    state.settingsDrawer.draft.pages_project_url = value;
    state.settingsDrawer.draft.__autoLinkedPagesProjectUrl =
      value === derivePagesProjectUrl(state.settingsDrawer.draft.project_name);
    return;
  }

  setDrawerPath(path, value);
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

function resolveErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'unknown');
}

async function writeClipboardText(text) {
  if (window.vpnAutomation?.copyText) {
    const result = await window.vpnAutomation.copyText(text);
    if (!result?.ok) {
      throw new Error(result?.error ?? 'clipboard_write_failed');
    }
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('clipboard_unavailable');
}

function showToast({ tone = 'neutral', message, durationMs = 2400 }) {
  if (!message) {
    return;
  }
  state.toast = { tone, message };
  renderToast();
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    renderToast();
    toastTimer = null;
  }, durationMs);
}

function renderToast() {
  if (!elements.toastRoot) {
    return;
  }
  if (!state.toast?.message) {
    elements.toastRoot.innerHTML = '';
    return;
  }
  elements.toastRoot.innerHTML = `
    <div class="toast ${escapeHtml(state.toast.tone || 'neutral')}" data-toast data-toast-tone="${escapeHtml(state.toast.tone || 'neutral')}">
      ${escapeHtml(state.toast.message)}
    </div>
  `;
}

async function copyText(value, options = {}) {
  const text = String(value ?? '').trim();
  const messages = getMessages(state.language);
  if (!text) {
    showToast({ tone: 'neutral', message: options.emptyToast ?? messages.nothingToCopyMessage });
    return;
  }

  try {
    await writeClipboardText(text);
    showToast({ tone: 'success', message: options.successToast ?? messages.copiedToastMessage });
    appendLog(options.successLog ?? formatMessage(messages.copiedMessage, { value: text }));
  } catch (error) {
    const detail = resolveErrorMessage(error);
    showToast({
      tone: 'danger',
      message: (options.failureToast ?? formatMessage(messages.copyFailedToastMessage, { error: detail })).replace('{error}', detail)
    });
    appendLog(
      (options.failureLog ?? formatMessage(messages.copyFailedLogMessage, { error: detail })).replace('{error}', detail)
    );
  }
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
  if (section === 'deploy') return buildDeployDraft(state.profile.deploy);
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
    if (section === 'deploy') {
      showToast({
        tone: 'success',
        message: `部署配置已保存：${state.profile.deploy.project_name} · ${state.profile.deploy.pages_project_url}`,
        durationMs: 3200
      });
      appendLog(
        `[settings] deploy saved project=${state.profile.deploy.project_name} url=${state.profile.deploy.pages_project_url}`
      );
    }
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
  if (section === 'deploy') {
    return sanitizeDeployDraft(draft);
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
  if (resolveRunControlState(state.runState).isBusy || !state.profile) {
    return;
  }

  const messages = getMessages(state.language);
  const runOptions = collectRunOptions();
  const preflightError = validateRunPreflight(runOptions);
  if (preflightError) {
    showToast({ tone: 'danger', message: preflightError, durationMs: 5200 });
    appendLog(`[界面] ${preflightError}`, { level: 'error' });
    return;
  }

  state.runState = 'running';
  state.runResult = 'running';
  state.stageStatus = {};
  state.counts = {};
  state.sourceCounts = {};
  state.extractDedupedFingerprints = new Set();
  state.logEntries = [];
  state.artifactDir = '';
  state.outputFiles = [];
  state.nodeRows = [];
  state.selectedRetryStage = '';
  state.runStartedAt = Date.now();
  touchUpdate();
  renderAll();
  appendLog(messages.pipelineStarted);

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
  if (resolveRunControlState(state.runState).isBusy || !state.profile || !state.selectedRetryArtifactDir || !state.selectedRetryStage) {
    return;
  }

  const messages = getMessages(state.language);
  state.runState = 'running';
  state.runResult = 'running';
  state.stageStatus = {};
  state.counts = {};
  state.sourceCounts = {};
  state.extractDedupedFingerprints = new Set();
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

function validateRunPreflight(runOptions) {
  if (runOptions.skipDeploy) {
    return '';
  }

  const deploy = state.profile?.deploy ?? {};
  const authMode = String(deploy.cloudflare_auth_mode || 'api_token').trim() || 'api_token';
  if (authMode === 'global_key') {
    if (String(deploy.cloudflare_email || '').trim() && String(deploy.cloudflare_global_key || '').trim()) {
      return '';
    }
    return getMessages(state.language).deployCredentialsMissing;
  }

  if (String(deploy.cloudflare_api_token || '').trim()) {
    return '';
  }
  return getMessages(state.language).deployCredentialsMissing;
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

  try {
    const result = await window.vpnAutomation.stopPipeline();
    if (!result?.ok) {
      finishRun({ ok: false, error: result?.error || messages.stopUnavailable });
      return;
    }
    if (result.requested === false) {
      if (result.run_state === 'failed') {
        finishRun({ ok: false, error: result.error || messages.stopUnavailable });
      } else {
        state.runState = 'idle';
        state.runStartedAt = null;
        touchUpdate();
        renderAll();
        appendLog(messages.stopUnavailable);
      }
      return;
    }
    if (result.stopped || result.status === 'stopped') {
      finishRun({ stopped: true });
    }
  } catch (error) {
    finishRun({ ok: false, error: error.message });
  }
}

function finishRun(result = {}) {
  const messages = getMessages(state.language);
  state.runStartedAt = null;

  if (result.stopped) {
    state.runState = 'idle';
    state.runResult = 'stopped';
    touchUpdate();
    renderAll();
    appendLog(messages.pipelineStopped);
    void hydrateRetryArtifacts();
    return;
  }

  if (result.ok) {
    state.runState = 'success';
    state.runResult = 'success';
    touchUpdate();
    renderAll();
    appendLog(formatMessage(messages.pipelineFinished, { code: result.code ?? 0 }));
    void hydrateRetryArtifacts();
    return;
  }

  state.runState = 'failed';
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

function handlePipelineEvent(event, options = {}) {
  const historical = Boolean(options.historical);
  if (event.type === 'server_state') {
    const nextRunState = String(event.run_state ?? '');
    if (['idle', 'running', 'stopping', 'failed', 'success'].includes(nextRunState)) {
      state.runState = nextRunState;
      if (['idle', 'failed', 'success'].includes(nextRunState)) {
        state.runStartedAt = null;
      }
      if (nextRunState === 'failed') {
        state.runResult = 'failed';
      } else if (nextRunState === 'success') {
        state.runResult = 'success';
      }
      touchUpdate();
      renderAll();
    }
    return;
  }

  if (event.type === 'run_failed') {
    if (historical) {
      appendLog(`[run_failed] ${event.error ?? ''}`);
      return;
    }
    if (state.runState !== 'idle' || state.runResult !== 'failed') {
      finishRun({ ok: false, error: event.error });
    }
    return;
  }

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
    state.retryContext = event.retry_context ?? state.retryContext ?? {};
    state.deployment = event.deployment ?? state.deployment ?? {};
    if (state.profile?.deploy && event.deployment) {
      if (event.deployment.project_name) {
        state.profile.deploy.project_name = event.deployment.project_name;
      }
      if (event.deployment.pages_project_url) {
        state.profile.deploy.pages_project_url = event.deployment.pages_project_url;
      }
      if (event.deployment.share_project_name) {
        state.profile.deploy.share_project_name = event.deployment.share_project_name;
      }
    }
    state.artifactDir = event.artifact_dir ?? '';
    state.selectedRetryArtifactDir = state.artifactDir || state.selectedRetryArtifactDir;
    appendLog(`[summary] artifacts: ${event.artifact_dir}`);
    const runStatus = String(event.run_status ?? '');
    if (runStatus === 'failed') {
      if (historical) {
        state.runResult = 'failed';
        touchUpdate();
        renderAll();
        return;
      }
      finishRun({ ok: false, error: event.error });
      hydrateArtifactPreview();
      return;
    }
    if (runStatus === 'success') {
      if (historical) {
        state.runResult = 'success';
        touchUpdate();
        renderAll();
        return;
      }
      finishRun({ ok: true, code: 0 });
      hydrateArtifactPreview();
      return;
    }
    if (runStatus === 'stopped') {
      if (historical) {
        state.runResult = 'idle';
        touchUpdate();
        renderAll();
        return;
      }
      finishRun({ stopped: true });
      hydrateArtifactPreview();
      return;
    }
    touchUpdate();
    renderAll();
    hydrateArtifactPreview();
    void hydrateRetryArtifacts();
    return;
  }

  if (event.type === 'extract_source_started') {
    appendLog(`[extract] ${event.source_name} 开始提取，最多 ${event.requested_iterations ?? 0} 次，最少 ${event.min_iterations ?? 0} 次`, {
      kind: 'stage',
      stage: 'extract',
      level: 'info'
    });
    return;
  }

  if (event.type === 'extract_request_result') {
    const status = event.success ? '成功' : '失败';
    const retry = event.will_retry ? '，将重试' : '';
    appendLog(`[extract] ${event.source_name} #${event.iteration} ${event.via} ${status}${retry}`, {
      kind: 'stage',
      stage: 'extract',
      level: event.success ? 'info' : 'warning'
    });
    return;
  }

  if (event.type === 'extract_decrypt_result' && !event.success) {
    appendLog(`[extract] ${event.source_name} #${event.iteration} 解密失败`, {
      kind: 'stage',
      stage: 'extract',
      level: 'error'
    });
    return;
  }

  if (event.type === 'extract_source_completed') {
    updateExtractMetrics({ source_name: event.source_name, total_links: event.raw_links });
    appendLog(`[extract] ${event.source_name} 完成，成功 ${event.successful_iterations ?? 0} 次，失败 ${event.failed_iterations ?? 0} 次，原始节点 ${event.raw_links ?? 0} 个`, {
      kind: 'stage',
      stage: 'extract',
      level: 'info'
    });
    return;
  }

  if (event.type === 'extract_iteration') {
    updateExtractMetrics(event);
    appendLog(`[extract] ${event.source_name} #${event.iteration ?? 0} 新增 ${event.new_items ?? 0} 个，本次解析 ${event.extracted_links ?? 0} 个，累计 ${event.total_links ?? 0} 个`, {
      kind: 'stage',
      stage: 'extract',
      level: 'info'
    });
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
  const sourceDedupedLinks = Number(event.deduped_links ?? previous.deduped_links ?? rawLinks);
  if (Array.isArray(event.new_item_fingerprints)) {
    for (const fingerprint of event.new_item_fingerprints) {
      if (fingerprint) {
        state.extractDedupedFingerprints.add(String(fingerprint));
      }
    }
  }
  state.sourceCounts = {
    ...state.sourceCounts,
    [sourceName]: {
      ...previous,
      raw_links: rawLinks,
      deduped_links: sourceDedupedLinks
    }
  };
  state.counts.raw_links = Object.values(state.sourceCounts)
    .reduce((total, item) => total + Number(item?.raw_links ?? 0), 0);
  if (state.extractDedupedFingerprints.size > 0) {
    state.counts.deduped_links = state.extractDedupedFingerprints.size;
  } else {
    state.counts.deduped_links = Object.values(state.sourceCounts)
      .reduce((total, item) => total + Number(item?.deduped_links ?? 0), 0);
  }
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
    state.retryContext = result.retry_context ?? state.retryContext ?? {};
    state.deployment = result.deployment ?? state.deployment ?? {};
    renderAll();
  }
}

function hydrateArtifactState(result) {
  if (!result?.artifact_dir) {
    return;
  }
  state.artifactDir = result.artifact_dir;
  state.counts = normalizeCounts(result.counts ?? {});
  state.sourceCounts = normalizeSourceCounts(result.source_counts ?? {});
  state.extractDedupedFingerprints = new Set();
  state.outputFiles = result.outputFiles ?? [];
  state.nodeRows = result.nodeRows ?? [];
  state.retryContext = result.retry_context ?? {};
  state.deployment = result.deployment ?? state.deployment ?? {};
  if (result.run_status === 'success') {
    state.runResult = 'success';
  } else if (result.run_status === 'failed') {
    state.runResult = 'failed';
  }
  if (result.stage_status) {
    state.stageStatus = result.stage_status;
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
    hydrateArtifactState(result);
    touchUpdate();
  } catch (error) {
    appendLog(formatMessage(getMessages(state.language).openFailed, { error: error.message }));
  }
}

function hydrateRetryArtifactState(items = []) {
  state.retryArtifacts = items;
  if (!state.selectedRetryArtifactDir) {
    state.selectedRetryArtifactDir = state.retryArtifacts[0]?.artifact_dir ?? '';
  }
  const selectedArtifact = state.retryArtifacts.find((item) => item.artifact_dir === state.selectedRetryArtifactDir) ?? state.retryArtifacts[0];
  const nextStage = selectedArtifact?.retryable_stages?.includes(state.selectedRetryStage)
    ? state.selectedRetryStage
    : resolveDefaultRetryStage(selectedArtifact);
  state.selectedRetryArtifactDir = selectedArtifact?.artifact_dir ?? '';
  state.selectedRetryStage = nextStage;
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
    hydrateRetryArtifactState(result.items ?? []);
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
  renderToast();
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
