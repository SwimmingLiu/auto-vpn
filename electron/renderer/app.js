import { getMessages, formatMessage } from './i18n.js';
import { createLogViewState, createQrState, resolveRunControlState } from './state.js';
// Keep appearance changes separate from profile saves and running jobs, so a
// theme switch cannot discard a settings draft or restart the pipeline.
import { getThemePreference, initializeAppearance, selectTheme, toggleSidebar } from './appearance.js';
import { enhanceTables } from './tables.js';
import { icon } from './icons.js';
import { renderAnalytics, clearAnalytics } from './analytics.bundle.js';
import {
  addAvailabilityTargetDraft,
  applyAvailabilityTargetDraft,
  applyNetworkDraft,
  applySourceIterationDraft,
  buildAvailabilityTargetDraft,
  buildNetworkDraft,
  buildPageMarkup,
  buildDashboardMetricsMarkup,
  buildDashboardStateMarkup,
  buildLogCenterMarkup,
  buildLogStateActions,
  buildRunsCurrentStageMarkup,
  buildRunsStageProgressMarkup,
  buildSpeedTestDraft,
  buildSourceIterationDraft,
  buildSidebarNav,
  buildViewModel,
  buildAccountPoolRecords,
  removeAvailabilityTargetDraft,
  resolveDashboardRunSummary,
  SOURCE_ROUND_DEFAULTS,
  validateSourceDraft,
  classifyLogEntry,
  escapeHtml,
  extractSourceUrlFromCurl,
  filterLogEntries
} from './views.js';

initializeAppearance();

const demoProfile = {
  sources: {
    leiting: { mode: 'credential', official_site: 'https://www.68123836.com', enabled: true, ...SOURCE_ROUND_DEFAULTS },
    heidong: { mode: 'credential', official_site: 'https://www.67986457.com', enabled: true, ...SOURCE_ROUND_DEFAULTS },
    mifeng: { mode: 'credential', official_site: 'https://www.86933221.com', enabled: true, ...SOURCE_ROUND_DEFAULTS },
    xuanfeng: { mode: 'credential', official_site: 'https://www.16863988.com', enabled: true, ...SOURCE_ROUND_DEFAULTS }
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
  extractProgress: {},
  language: 'zh-CN',
  themePreference: getThemePreference(),
  activePage: 'dashboard',
  subtabs: {},
  logFilter: '全部',
  settingsDrawer: null,
  accountPool: {
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
    canSetExpiry: typeof window.vpnAutomation?.setAccountExpiry === 'function',
    expiryEditorId: null
  },
  isDemo: false,
  runtime: document.body.dataset.runtime === 'web' ? 'web' : 'electron',
  runOptions: { skipDeploy: false, skipVerify: false, saveBeforeRun: true },
  activity: [],
  activityUnavailable: 0,
  runState: 'idle',
  runResult: 'idle',
  logEntries: [],
  logView: createLogViewState(),
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
  qr: createQrState(),
  runStartedAt: null,
  lastUpdateAt: null,
  modalTransform: '',
  progressSnapshot: null
};

let settingsDrawerOpener = null;
let runDetailsMobileBreakpoint = null;
let nextLogSequence = 0;

const elements = {
  sidebarTitle: document.querySelector('#sidebarTitle'),
  sidebarVersion: document.querySelector('#sidebarVersion'),
  sidebarNav: document.querySelector('#sidebarNav'),
  pageTitle: document.querySelector('#pageTitle'),
  runStateBadge: document.querySelector('#runStateBadge'),
  pageActions: document.querySelector('#pageActions'),
  pageContent: document.querySelector('#pageContent'),
  toastRoot: document.querySelector('#toastRoot')
};

let toastTimer = null;
let qrRequestId = 0;

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
  void hydrateAccountPool();
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
  state.activity = Array.isArray(loadedState.activity) ? loadedState.activity : [];
  state.activityUnavailable = Number(loadedState.activityUnavailable ?? 0);
  // An older profile has no [network] section. Seeding the displayed defaults
  // here means saving any other drawer writes the section the pipeline reads
  // instead of leaving it absent, and the network drawer opens on real values.
  state.profile = { ...loadedProfile, network: buildNetworkDraft(loadedProfile.network) };
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
  const snapshot = state.progressSnapshot;
  for (const event of events) {
    handlePipelineEvent(event, { historical: true });
  }
  state.runState = previousRunState;
  state.runResult = previousRunState === 'idle' ? previousRunResult : previousRunState;
  if (snapshot) applyProgressSnapshot(snapshot);
}

function bindActions() {
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('input', handleDocumentInput);
  document.addEventListener('change', handleDocumentInput);
  document.addEventListener('keydown', handleSettingsDrawerKeydown);
  document.addEventListener('scroll', handleLogScroll, true);
  window.addEventListener('resize', syncRunDetailsPresentation);
  
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
  const activeElement = document.activeElement;
  const focusKey = activeElement?.dataset
    ? (activeElement.dataset.accountSearch !== undefined ? 'account-search'
      : activeElement.dataset.drawerSource && activeElement.dataset.drawerKey
        ? `drawer:${activeElement.dataset.drawerSource}:${activeElement.dataset.drawerKey}`
        : '')
    : '';
  const focusSelection = focusKey && 'selectionStart' in activeElement
    ? [activeElement.selectionStart, activeElement.selectionEnd]
    : null;

  renderChrome(messages, viewModel);
  const qrPanelOpen = document.querySelector('.subscription-qr')?.open === true;
  clearAnalytics();
  elements.pageContent.innerHTML = buildPageMarkup(
    state.activePage,
    viewModel,
    messages,
    state.language,
    state.subtabs
  );
  // Every full render replaces the tables; reapply layout to the current DOM.
  const qrPanel = document.querySelector('.subscription-qr');
  if (qrPanel) qrPanel.open = qrPanelOpen;
  enhanceTables(elements.pageContent);
  renderAnalytics(document.querySelector('#dashboardAnalytics'), viewModel);
  if (focusKey) {
    const selector = focusKey === 'account-search'
      ? '[data-account-search]'
      : `[data-drawer-source="${CSS.escape(focusKey.split(':')[1])}"][data-drawer-key="${CSS.escape(focusKey.split(':')[2])}"]`;
    const restored = document.querySelector(selector);
    restored?.focus();
    if (restored && focusSelection && focusSelection[0] !== null) {
      try {
        restored.setSelectionRange(focusSelection[0], focusSelection[1]);
      } catch {
        // Number inputs do not expose a text selection.
      }
    }
  }
  syncRunDetailsPresentation();
  updateChromeState(messages);
  renderToast();
}

function syncRunDetailsPresentation() {
  const details = document.querySelector('details.run-secondary-controls');
  if (!details) return;
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  const isNewDetails = details.dataset.breakpointInitialized !== 'true';
  if (isNewDetails || mobile !== runDetailsMobileBreakpoint) {
    details.open = !mobile;
    details.dataset.breakpointInitialized = 'true';
  }
  runDetailsMobileBreakpoint = mobile;
}

function renderChrome(messages, viewModel) {
  elements.sidebarTitle.textContent = messages.sidebarTitle;
  elements.sidebarVersion.textContent = messages.sidebarVersion;
  elements.pageTitle.textContent = messages.pageTitles[state.activePage];
  elements.sidebarNav.innerHTML = buildSidebarNav(messages, state.activePage);
  const controlState = resolveRunControlState(state.runState);
  elements.pageActions.replaceChildren();
  updateChromeState(messages);
}

function updateChromeState(messages = getMessages(state.language)) {
  const controlState = resolveRunControlState(state.runState);
  elements.runStateBadge.textContent = messages.runStateLabels[state.runState] ?? messages.runStateLabels.idle;
  elements.runStateBadge.className = `badge ${runTone()}`;
  for (const button of document.querySelectorAll('[data-run-action="start"]')) {
    button.disabled = controlState.runDisabled;
    button.setAttribute('aria-busy', String(controlState.isBusy));
    // Preserve the action icon when live pipeline status changes its label.
    button.innerHTML = icon('play');
    button.setAttribute('aria-label', resolveRunButtonLabel(messages));
    button.title = resolveRunButtonLabel(messages);
  }
  for (const button of document.querySelectorAll('[data-run-action="stop"]')) {
    button.disabled = controlState.stopDisabled;
    button.setAttribute('aria-busy', String(state.runState === 'stopping'));
  }
  for (const button of document.querySelectorAll('[data-action="retry-stage"]')) {
    button.disabled = controlState.isBusy || !state.selectedRetryArtifactDir || !state.selectedRetryStage;
  }
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

async function handleDocumentClick(event) {
  if (event.target.closest('#sidebarToggle')) {
    toggleSidebar();
    return;
  }
  const themeChoice = event.target.closest('[data-theme-choice]');
  if (themeChoice) {
    state.themePreference = themeChoice.dataset.themeChoice;
    selectTheme(state.themePreference);
    return;
  }
  const jumpLatest = event.target.closest('[data-log-jump-latest]');
  if (jumpLatest) {
    state.logView.follow = true;
    state.logView.unseenCount = 0;
    renderAll();
    scrollLogToLatest();
    return;
  }

  const undoClear = event.target.closest('[data-log-undo-clear]');
  if (undoClear && state.logView.clearedSnapshot) {
    state.logEntries = state.logView.clearedSnapshot;
    state.logView.clearedSnapshot = null;
    state.logView.follow = true;
    state.logView.unseenCount = 0;
    state.toast = null;
    renderAll();
    scrollLogToLatest();
    return;
  }
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

  const logFilterButton = event.target.closest('[data-log-filter]');
  if (logFilterButton) {
    state.logFilter = logFilterButton.dataset.logFilter;
    renderAll();
    return;
  }

  const copyButton = event.target.closest('[data-copy-text]');
  if (copyButton) {
    copyText(copyButton.dataset.copyText, { control: copyButton, successLog: '已复制订阅链接' });
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
      failureLog: formatMessage(messages.copyFailedLogMessage, { error: '{error}' }),
      control: action
    });
    return;
  }
  if (action?.dataset.action === 'retry-qr') {
    refreshQrCode();
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
    state.logView.clearedSnapshot = [...state.logEntries];
    state.logEntries = [];
    state.logView.follow = true;
    state.logView.unseenCount = 0;
    renderAll();
    showToast({ tone: 'neutral', message: '日志已清空', durationMs: 5000, action: 'undo-clear' });
    return;
  }
  if (action?.dataset.action === 'open-log-file') {
    openCurrentLogFile();
    return;
  }

  const settingsCard = event.target.closest('[data-settings-card]');
  if (settingsCard) {
    openSettingsDrawer(settingsCard.dataset.settingsCard, settingsCard);
    return;
  }

  const accountAction = event.target.closest('[data-account-action]');
  if (accountAction) {
    handleAccountPoolAction(accountAction);
    return;
  }

  const availabilityAction = event.target.closest('[data-availability-action]');
  if (availabilityAction) {
    handleAvailabilityTargetAction(availabilityAction);
    return;
  }

  if (event.target.closest('[data-drawer-dismiss="backdrop"]')) {
    closeSettingsDrawer({ restoreFocus: true });
    return;
  }

  if (event.target.closest('[data-drawer-close="cancel"]')) {
    closeSettingsDrawer({ restoreFocus: true });
    return;
  }

  if (event.target.closest('[data-drawer-save="save"]')) {
    await saveSettingsDrawer();
  }
}

function handleDocumentInput(event) {
  if (event.target.dataset.runOption) {
    state.runOptions[event.target.dataset.runOption] = event.target.checked;
    return;
  }
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

  if (target.matches('[data-account-file]')) {
    handleAccountFileSelected(target);
    return;
  }

  if (target.matches('[data-account-search]')) {
    state.accountPool.query = target.value;
    touchUpdate();
    renderAccountPoolRecords();
    return;
  }

  if (target.matches('[data-account-status-filter]')) {
    state.accountPool.statusFilter = target.value;
    touchUpdate();
    renderAccountPoolRecords();
    return;
  }

  if (target.matches('[data-account-brand-filter]')) {
    state.accountPool.brandFilter = target.value;
    touchUpdate();
    renderAccountPoolRecords();
    return;
  }

  if (target.matches('[data-account-sort]')) {
    state.accountPool.sortBy = target.value;
    touchUpdate();
    renderAccountPoolRecords();
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
    // Only the official site is free text now. `enabled` is a boolean and the
    // round fields are numbers, so nothing here needs the URL normaliser.
    const rawValue = target.type === 'checkbox' ? target.checked : target.value.trim();
    sourceDraft[sourceName][key] =
      target.type === 'checkbox'
        ? rawValue
        : coerceProfileValue(rawValue, sourceDraft[sourceName][key]);
    // A source that never set a round has no existing number to copy the type
    // from, and `coerceProfileValue` would leave the field a string — which then
    // lands in profile.toml quoted. Round controls are always numbers.
    if (SOURCE_NUMERIC_KEYS.has(key)) {
      const parsed = Number(sourceDraft[sourceName][key]);
      if (Number.isFinite(parsed)) {
        const floor = SOURCE_MINIMUM_ONE_KEYS.has(key) ? 1 : 0;
        sourceDraft[sourceName][key] = Math.max(floor, Math.trunc(parsed));
      }
      // The area controls have a hard ceiling the backend also clamps to.
      if (SOURCE_MAXIMUM_KEYS.has(key)) {
        sourceDraft[sourceName][key] = Math.min(SOURCE_MAXIMUM_KEYS.get(key), sourceDraft[sourceName][key]);
      }
    }
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
  sanitizedDraft.min_final_links = Math.max(0, Math.trunc(Number(sanitizedDraft.min_final_links ?? 10) || 0));
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

/** Source fields that are always numbers, whatever the draft already held. */
const SOURCE_NUMERIC_KEYS = new Set([
  'max_iterations',
  'min_iterations',
  'plateau_limit',
  'areas_per_round',
  'area_concurrency',
  'max_runtime_seconds',
  'max_areas',
  'area_min',
  'area_max'
]);

/** Of those, the ones the runner clamps to at least one. */
const SOURCE_MINIMUM_ONE_KEYS = new Set([
  'max_iterations',
  'plateau_limit',
  'areas_per_round',
  'area_concurrency'
]);

/** Numeric source fields with a hard upper bound, matching the backend clamp. */
const SOURCE_MAXIMUM_KEYS = new Map([
  ['areas_per_round', 64],
  ['area_concurrency', 16]
]);

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

function showToast({ tone = 'neutral', message, durationMs = 2400, action = null }) {
  if (!message) {
    return;
  }
  state.toast = { tone, message, action };
  renderToast();
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    if (state.toast?.action === 'undo-clear') {
      state.logView.clearedSnapshot = null;
      renderActiveRuntimeSections(buildViewModel(state, getMessages(state.language), state.language));
    }
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
      ${state.toast.action === 'undo-clear' ? '<button class="btn small" data-log-undo-clear type="button">撤销</button>' : ''}
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

  const control = options.control;
  if (control?.getAttribute('aria-busy') === 'true') return;
  if (control) {
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');
  }
  try {
    await writeClipboardText(text);
    showToast({ tone: 'success', message: options.successToast ?? messages.copiedToastMessage });
    appendLog(options.successLog ?? '已复制内容');
  } catch (error) {
    showToast({
      tone: 'danger',
      message: options.safeFailureToast ?? '复制失败，请重试'
    });
    appendLog(options.safeFailureLog ?? '复制操作失败');
  } finally {
    if (control?.isConnected) {
      control.disabled = false;
      control.setAttribute('aria-busy', 'false');
    }
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
  const requestId = ++qrRequestId;
  const subscriptionUrl = resolveActiveSubscriptionUrl();
  if (!subscriptionUrl || !window.vpnAutomation?.generateQr) {
    state.qr = createQrState('unavailable', '', '当前环境不支持二维码生成');
    renderAll();
    return;
  }

  state.qr = createQrState('loading');
  renderAll();
  try {
    const result = await window.vpnAutomation.generateQr(subscriptionUrl);
    if (requestId !== qrRequestId || subscriptionUrl !== resolveActiveSubscriptionUrl()) return;
    state.qr = result?.dataUrl
      ? createQrState('success', result.dataUrl)
      : createQrState('unavailable', '', '二维码服务未返回图片');
  } catch (error) {
    if (requestId !== qrRequestId || subscriptionUrl !== resolveActiveSubscriptionUrl()) return;
    state.qr = createQrState('error', '', resolveErrorMessage(error));
  }
  renderAll();
}

function resolveActiveSubscriptionUrl() {
  const baseUrl = state.profile?.deploy?.subscription_url ?? '';
  if (!baseUrl) {
    return '';
  }

  return baseUrl;
}

function openSettingsDrawer(section, opener = document.activeElement) {
  if (!state.profile) {
    return;
  }

  const draft = buildSettingsDraft(section);
  if (!draft) {
    return;
  }

  state.modalTransform = '';
  settingsDrawerOpener = opener?.matches?.('[data-settings-card]')
    ? `[data-settings-card="${CSS.escape(opener.dataset.settingsCard)}"]`
    : opener?.id
      ? `#${CSS.escape(opener.id)}`
      : null;
  state.settingsDrawer = { section, draft };
  renderAll();
  queueMicrotask(() => {
    const dialog = document.querySelector('[data-settings-dialog]');
    const focusTarget = dialog?.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])');
    focusTarget?.focus();
  });
}

function closeSettingsDrawer({ restoreFocus = true } = {}) {
  const openerSelector = settingsDrawerOpener;
  state.settingsDrawer = null;
  state.modalTransform = '';
  settingsDrawerOpener = null;
  renderAll();
  if (restoreFocus && openerSelector) {
    queueMicrotask(() => document.querySelector(openerSelector)?.focus());
  }
}

function handleSettingsDrawerKeydown(event) {
  const dialog = document.querySelector('[data-settings-dialog]');
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSettingsDrawer({ restoreFocus: true });
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function buildSettingsDraft(section) {
  if (!state.profile) {
    return null;
  }

  if (section === 'sources') return buildSourceIterationDraft(state.profile.sources);
  if (section === 'speed_test') return buildSpeedTestDraft(state.profile.speed_test);
  if (section === 'availability_targets') return buildAvailabilityTargetDraft(state.profile.availability_targets);
  if (section === 'deploy') return buildDeployDraft(state.profile.deploy);
  if (section === 'network') return buildNetworkDraft(state.profile.network);
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
  if (section === 'sources') {
    const problem = validateSourceDraft(draft);
    if (problem) {
      showToast({ tone: 'danger', message: problem, durationMs: 4200 });
      return;
    }
  }
  if (section !== 'about') {
    state.profile[section] = resolveSettingsDraftPayload(section, draft);
  }
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
    closeSettingsDrawer({ restoreFocus: true });
    return;
  }
  closeSettingsDrawer({ restoreFocus: true });
}

async function hydrateAccountPool() {
  state.accountPool.status = 'loading';
  // Re-detect each hydration: the preload bridge is fixed for the page, but a
  // test harness or a future H5 adapter may attach it after bootstrap.
  state.accountPool.canSetExpiry = typeof window.vpnAutomation?.setAccountExpiry === 'function';
  touchUpdate();
  renderAccountPoolPanelOnly();
  if (!window.vpnAutomation?.loadAccounts) {
    state.accountPool.status = 'unavailable';
    state.accountPool.error = '未连接账号服务';
    renderAccountPoolPanelOnly();
    return false;
  }
  try {
    const snapshot = await window.vpnAutomation.loadAccounts();
    if (!snapshot?.ok) {
      throw new Error(snapshot?.error || '账号池读取失败');
    }
    state.accountPool.status = 'ready';
    state.accountPool.stats = snapshot.stats ?? null;
    state.accountPool.accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    state.accountPool.error = '';
  } catch (error) {
    state.accountPool.status = 'error';
    state.accountPool.error = resolveErrorMessage(error);
  }
  touchUpdate();
  renderAccountPoolPanelOnly();
  return state.accountPool.status === 'ready';
}

function renderAccountPoolPanelOnly() {
  // A full re-render, not a patched subtree: the panel shares the page with the
  // settings drawer, and replacing only the panel left the open drawer's draft
  // bound to detached nodes.
  renderAll();
}

function renderAccountPoolRecords() {
  const holder = document.querySelector('#accountPoolRecords');
  if (!holder) return;
  const messages = getMessages(state.language);
  const viewModel = buildViewModel(state, messages, state.language);
  holder.innerHTML = buildAccountPoolRecords(viewModel.accountPool);
  enhanceTables(holder);
}

async function handleAccountPoolAction(button) {
  const action = button.dataset.accountAction;
  if (action === 'refresh') {
    const ok = await hydrateAccountPool();
    showToast(
      ok
        ? { tone: 'success', message: '账号池已刷新' }
        : { tone: 'danger', message: state.accountPool.error || '账号池刷新失败' }
    );
    return;
  }
  if (action === 'upload') {
    document.querySelector('#accountPoolFile')?.click();
    return;
  }
  if (action === 'template') {
    await downloadAccountsTemplate();
    return;
  }
  if (action === 'toggle') {
    await toggleAccountStatus(Number(button.dataset.accountId));
    return;
  }
  if (action === 'expiry-edit') {
    state.accountPool.expiryEditorId = Number(button.dataset.accountId);
    renderAll();
    queueMicrotask(() => document.querySelector(`[data-account-expiry-input="${CSS.escape(String(button.dataset.accountId))}"]`)?.focus());
    return;
  }
  if (action === 'expiry-cancel') {
    state.accountPool.expiryEditorId = null;
    renderAll();
    return;
  }
  if (action === 'expiry-save') {
    const id = Number(button.dataset.accountId);
    const input = document.querySelector(`[data-account-expiry-input="${CSS.escape(String(id))}"]`);
    await setAccountExpiry(id, input?.value ?? '');
  }
}

async function setAccountExpiry(id, expiresAt) {
  const account = (state.accountPool.accounts ?? []).find((item) => item.id === id);
  // Feature-detected: the browser build has no preload bridge, so this path is
  // never reachable there and the row hides the affordance.
  if (!account || typeof window.vpnAutomation?.setAccountExpiry !== 'function') {
    return;
  }
  const value = String(expiresAt ?? '').trim();
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    showToast({ tone: 'danger', message: '请选择有效的到期日期' });
    return;
  }
  state.accountPool.busy = true;
  renderAccountPoolPanelOnly();
  try {
    // Preload bridge signature: setAccountExpiry(id, 'YYYY-MM-DD'); '' clears it.
    const result = await window.vpnAutomation.setAccountExpiry(id, value);
    if (!result?.ok) {
      throw new Error(result?.error || '操作失败');
    }
    state.accountPool.expiryEditorId = null;
    showToast({ tone: 'success', message: value ? `${account.account_masked} 到期日已设为 ${value}` : `${account.account_masked} 到期日已清除` });
  } catch (error) {
    showToast({ tone: 'danger', message: resolveErrorMessage(error) });
  } finally {
    state.accountPool.busy = false;
  }
  await hydrateAccountPool();
}

async function downloadAccountsTemplate() {
  try {
    let content = '';
    if (window.vpnAutomation?.accountsTemplate) {
      const result = await window.vpnAutomation.accountsTemplate();
      content = String(result?.content ?? '');
    }
    if (!content) {
      throw new Error('模板不可用');
    }
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'accounts-template.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    showToast({ tone: 'success', message: '模板已下载' });
  } catch (error) {
    showToast({ tone: 'danger', message: resolveErrorMessage(error) });
  }
}

async function handleAccountFileSelected(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  if (file.size > 1024 * 1024) {
    showToast({ tone: 'danger', message: '文件超过 1MB，请拆分后上传' });
    return;
  }
  state.accountPool.busy = true;
  state.accountPool.message = '';
  state.accountPool.issues = [];
  renderAccountPoolPanelOnly();
  // Tone of the closing toast follows what actually happened. A rejected import
  // must not end green just because the reload after it succeeded.
  let importOk = false;
  try {
    const content = await file.text();
    const result = await window.vpnAutomation.importAccounts(content, 'auto');
    state.accountPool.issues = Array.isArray(result?.issues) ? result.issues : [];
    if (!result?.ok) {
      state.accountPool.message = result?.error === 'no_usable_rows'
        ? '文件里没有可导入的账号'
        : (result?.error || '导入失败');
      showToast({ tone: 'danger', message: state.accountPool.message });
    } else {
      importOk = true;
      const summary = `导入完成：新增 ${result.inserted ?? 0}，更新 ${result.updated ?? 0}，改密 ${result.rotated ?? 0}，恢复 ${result.revived ?? 0}，未变 ${result.unchanged ?? 0}`;
      state.accountPool.message = state.accountPool.issues.length ? `${summary}；${state.accountPool.issues.length} 行有问题` : summary;
      showToast({ tone: state.accountPool.issues.length ? 'warning' : 'success', message: summary });
      appendLog(`[账号池] ${summary}`);
    }
  } catch (error) {
    // The served web UI answers a rejected import with HTTP 400 and the parsed
    // issues; `web-adapter.js` carries that payload on the error so the line
    // numbers still reach the panel instead of a bare `request_failed`.
    const payload = error?.payload;
    if (payload && typeof payload === 'object') {
      state.accountPool.issues = Array.isArray(payload.issues) ? payload.issues : [];
      state.accountPool.message = payload.error === 'no_usable_rows'
        ? '文件里没有可导入的账号'
        : (payload.error || '导入失败');
    } else {
      state.accountPool.message = resolveErrorMessage(error);
    }
    showToast({ tone: 'danger', message: state.accountPool.message });
  } finally {
    state.accountPool.busy = false;
  }
  const reloaded = await hydrateAccountPool();
  if (!importOk) {
    // The panel now carries the failure reason, so a second toast would only
    // stack noise on top of the danger toast that already fired.
    return;
  }
  showToast({
    tone: state.accountPool.issues.length ? 'warning' : 'success',
    message: state.accountPool.message || (reloaded ? '账号池已更新' : state.accountPool.error)
  });
}

async function toggleAccountStatus(id) {
  const account = (state.accountPool.accounts ?? []).find((item) => item.id === id);
  if (!account || !window.vpnAutomation?.setAccountStatus) {
    return;
  }
  const nextStatus = account.status === 'active' ? 'disabled' : 'active';
  state.accountPool.busy = true;
  renderAccountPoolPanelOnly();
  try {
    const result = await window.vpnAutomation.setAccountStatus({ id, status: nextStatus, reason: '停用（界面操作）' });
    if (!result?.ok) {
      throw new Error(result?.error || '操作失败');
    }
    showToast({
      tone: nextStatus === 'active' ? 'success' : 'neutral',
      message: `${account.account_masked} 已${nextStatus === 'active' ? '启用' : '停用'}`
    });
  } catch (error) {
    showToast({ tone: 'danger', message: resolveErrorMessage(error) });
  } finally {
    state.accountPool.busy = false;
  }
  await hydrateAccountPool();
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
  if (section === 'network') {
    return applyNetworkDraft(draft);
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
  state.extractProgress = {};
  state.extractDedupedFingerprints = new Set();
  state.logEntries = [];
  state.artifactDir = '';
  state.outputFiles = [];
  state.nodeRows = [];
  state.selectedRetryStage = '';
  state.runStartedAt = Date.now();
  touchUpdate();
  renderRuntimeOnly();
  appendLog(messages.pipelineStarted);

  if (runOptions.saveBeforeRun) {
    await saveProfile({ silent: true });
  }

  if (!window.vpnAutomation) {
    state.runState = 'idle';
    state.runResult = 'demo';
    touchUpdate();
    renderRuntimeOnly();
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
    renderRuntimeOnly();
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
  state.extractProgress = {};
  state.extractDedupedFingerprints = new Set();
  state.logEntries = [];
  state.artifactDir = '';
  state.outputFiles = [];
  state.nodeRows = [];
  state.runStartedAt = Date.now();
  touchUpdate();
  renderRuntimeOnly();
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
    renderRuntimeOnly();
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
    renderRuntimeOnly();
    appendLog(formatMessage(messages.pipelineFailed, { error: error.message }));
  }
}

function collectRunOptions() {
  const optionInputs = document.querySelectorAll('[data-run-option]');
  const options = { ...state.runOptions };
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
  renderRuntimeOnly();
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
        renderRuntimeOnly();
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
    renderRuntimeOnly();
    appendLog(messages.pipelineStopped);
    void hydrateRetryArtifacts();
    return;
  }

  if (result.ok) {
    state.runState = 'success';
    state.runResult = 'success';
    touchUpdate();
    renderRuntimeOnly();
    appendLog(formatMessage(messages.pipelineFinished, { code: result.code ?? 0 }));
    void hydrateRetryArtifacts();
    return;
  }

  state.runState = 'failed';
  state.runResult = 'failed';
  touchUpdate();
  renderRuntimeOnly();
  if (result.error) {
    appendLog(formatMessage(messages.pipelineFailed, { error: result.error }));
  } else {
    appendLog(formatMessage(messages.pipelineFinished, { code: result.code ?? 'error' }));
  }
  void hydrateRetryArtifacts();
}

function applyProgressSnapshot(snapshot) {
  if (!snapshot?.counts || !snapshot.source_counts) return;
  state.progressSnapshot = snapshot;
  state.counts = normalizeCounts({ ...state.counts, ...snapshot.counts });
  state.sourceCounts = normalizeSourceCounts(snapshot.source_counts);
}

function handlePipelineEvent(event, options = {}) {
  handlePipelineEventDetails(event, options);
  if (event.progress_snapshot && !options.historical
    && (!event.progress_snapshot.artifact_dir || event.progress_snapshot.artifact_dir === state.artifactDir)) {
    applyProgressSnapshot(event.progress_snapshot);
    touchUpdate();
    renderRuntimeOnly({ chrome: false });
  }
}

function handlePipelineEventDetails(event, options = {}) {
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
      renderRuntimeOnly();
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

  if (event.type === 'extract_substage') {
    if (!['apk_download', 'apk_analysis', 'domain_discovery'].includes(event.substage)
      || !['running', 'success', 'failed', 'cached'].includes(event.status)) return;
    const key = [event.source_name, event.platform, event.substage].join(':');
    state.extractProgress[key] = { source: String(event.source_name ?? ''), platform: String(event.platform ?? ''), substage: event.substage, status: event.status };
    touchUpdate();
    renderRuntimeOnly({ chrome: false });
    return;
  }

  if (event.type === 'stage') {
    state.stageStatus[event.stage] = normalizeStageStatus(event.status);
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
    state.stageStatus = normalizeStageStatuses(event.stage_status);
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

  if (event.type === 'extract_platform_started') {
    appendLog(`[extract] ${event.source_name} ${platformTag(event.platform)}开始提取，最多 ${event.requested_iterations ?? 0} 次，最少 ${event.min_iterations ?? 0} 次`, {
      kind: 'stage',
      stage: 'extract',
      level: 'info'
    });
    return;
  }

  if (event.type === 'extract_platform_completed') {
    appendLog(`[extract] ${event.source_name} ${platformTag(event.platform)}完成，成功 ${event.successful_iterations ?? 0} 次，失败 ${event.failed_iterations ?? 0} 次，原始节点 ${event.raw_links ?? 0} 个`, {
      kind: 'stage',
      stage: 'extract',
      level: 'info'
    });
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
    appendLog(`[extract] ${event.source_name} ${platformTag(event.platform)}#${event.iteration} ${event.via} ${status}${retry}`, {
      kind: 'stage',
      stage: 'extract',
      level: event.success ? 'info' : 'warning'
    });
    return;
  }

  if (event.type === 'extract_decrypt_result' && !event.success) {
    appendLog(`[extract] ${event.source_name} ${platformTag(event.platform)}#${event.iteration} 解密失败`, {
      kind: 'stage',
      stage: 'extract',
      level: 'error'
    });
    return;
  }

  if (event.type === 'extract_source_completed') {
    if (!event.progress_snapshot && !(historical && state.progressSnapshot)) updateExtractMetrics({ source_name: event.source_name, total_links: event.raw_links });
    appendLog(`[extract] ${event.source_name} 完成，成功 ${event.successful_iterations ?? 0} 次，失败 ${event.failed_iterations ?? 0} 次，原始节点 ${event.raw_links ?? 0} 个`, {
      kind: 'stage',
      stage: 'extract',
      level: 'info'
    });
    return;
  }

  if (event.type === 'extract_iteration') {
    if (!event.progress_snapshot && !(historical && state.progressSnapshot)) updateExtractMetrics(event);
    // Android and iOS run the same round numbers independently, so a bare `#N`
    // shows two identical lines. The tag only appears when the event carries a
    // platform, which keeps older backends and the URL-mode stream unchanged.
    appendLog(`[extract] ${event.source_name} ${platformTag(event.platform)}#${event.iteration ?? 0} 新增 ${event.new_items ?? 0} 个，本次解析 ${event.extracted_links ?? 0} 个，累计 ${event.total_links ?? 0} 个`, {
      kind: 'stage',
      stage: 'extract',
      level: 'info'
    });
    return;
  }

  if (event.type === 'speedtest_result') {
    if (event.progress_snapshot || (historical && state.progressSnapshot)) return;
    if (event.passed_threshold) {
      state.counts.speedtest_links = Number(state.counts.speedtest_links ?? 0) + 1;
    }
    touchUpdate();
    renderRuntimeOnly({ chrome: false });
    return;
  }

  if (event.type === 'availability_link_result') {
    if (event.progress_snapshot || (historical && state.progressSnapshot)) return;
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
    const nextArtifactDir = String(event.artifact_dir ?? '');
    if (nextArtifactDir !== state.artifactDir) {
      resetRunScopedProgress();
      state.runState = 'running';
      state.runResult = 'running';
      state.runStartedAt = Date.now();
    }
    state.artifactDir = nextArtifactDir;
    touchUpdate();
    renderAll();
  }
}

function normalizeStageStatus(status) {
  return status === 'skipped' ? '已跳过' : status;
}

function normalizeStageStatuses(stageStatuses = {}) {
  return Object.fromEntries(
    Object.entries(stageStatuses ?? {}).map(([stage, status]) => [stage, normalizeStageStatus(status)])
  );
}

function resetRunScopedProgress() {
  state.progressSnapshot = null;
  state.stageStatus = {};
  state.counts = {};
  state.sourceCounts = {};
  state.extractProgress = {};
  state.extractDedupedFingerprints = new Set();
  state.outputFiles = [];
  state.nodeRows = [];
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
        ...(counts && Object.hasOwn(counts, 'deduped_links')
          ? { deduped_links: Number(counts.deduped_links) }
          : {})
      }
    ])
  );
}

function updateExtractMetrics(event) {  const sourceName = event.source_name;
  if (!sourceName) {
    return;
  }

  const previous = state.sourceCounts[sourceName] ?? {};
  const previousRawLinks = validNonNegativeNumber(previous.raw_links) ?? 0;
  const previousDedupedLinks = validNonNegativeNumber(previous.deduped_links) ?? 0;
  const rawLinks = Math.max(previousRawLinks, validNonNegativeNumber(event.total_links) ?? previousRawLinks);
  const eventDedupedLinks = event.deduped_links == null
    ? rawLinks
    : validNonNegativeNumber(event.deduped_links) ?? previousDedupedLinks;
  const sourceDedupedLinks = Math.max(
    previousDedupedLinks,
    eventDedupedLinks
  );
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

function validNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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
  // Bounded log history cannot reconstruct metrics that predate its tail.
  state.progressSnapshot = result.progress_snapshot ?? null;
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
    state.stageStatus = normalizeStageStatuses(result.stage_status);
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
    state.activity = Array.isArray(result.activity) ? result.activity : [];
    state.activityUnavailable = Number(result.activityUnavailable ?? 0);
    touchUpdate();
    // Completion refreshes history asynchronously, after the last pipeline
    // event. Update the visible calendar without requiring a page switch.
    renderRuntimeOnly({ chrome: false });
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

// Both channels emit the same round numbers, so the log needs the channel on
// the line. `[android] ` keeps the rest of the format untouched; an event with
// no platform (older backend, URL-mode extract) renders exactly as before.
function platformTag(platform) {
  const value = String(platform ?? '').trim().toLowerCase();
  return value === 'android' || value === 'ios' ? `[${value}] ` : '';
}

function appendLog(message, overrides = {}) {
  const logCenter = document.querySelector('#logCenterTable');
  if (logCenter) {
    state.logView.follow = logCenter.scrollHeight - logCenter.scrollTop - logCenter.clientHeight <= 32;
    if (!state.logView.follow) {
      const streamTop = logCenter.getBoundingClientRect().top;
      state.logView.anchorId = [...logCenter.querySelectorAll('.log-line')]
        .find((line) => line.getBoundingClientRect().bottom >= streamTop)
        ?.dataset.logId ?? state.logView.anchorId;
    }
  }
  if (!state.logView.follow) {
    state.logView.unseenCount += 1;
  }
  state.logEntries.push({
    ...classifyLogEntry(message, overrides),
    logId: `live-${++nextLogSequence}`
  });
  touchUpdate();
  renderRuntimeOnly({ chrome: false });
}

function renderRuntimeOnly({ chrome = true } = {}) {
  const messages = getMessages(state.language);
  const viewModel = buildViewModel(state, messages, state.language);
  if (chrome) {
    updateChromeState(messages);
  }
  renderActiveRuntimeSections(viewModel);
  renderToast();
}

function renderActiveRuntimeSections(viewModel) {
  const logCenter = document.querySelector('#logCenterTable');
  if (logCenter) {
    const previousScrollTop = logCenter.scrollTop;
    const streamTop = logCenter.getBoundingClientRect().top;
    const anchor = [...logCenter.querySelectorAll('.log-line')]
      .find((line) => line.getBoundingClientRect().bottom >= streamTop);
    const anchorId = anchor?.dataset.logId;
    const anchorViewportTop = anchor?.getBoundingClientRect().top;
    logCenter.innerHTML = buildLogCenterMarkup(viewModel);
    const workspace = logCenter.closest('#logsWorkspace');
    const stateActions = workspace?.querySelector('.log-state-actions');
    if (stateActions) stateActions.innerHTML = buildLogStateActions(viewModel);
    if (state.logView.follow) {
      logCenter.scrollTop = logCenter.scrollHeight;
    } else if (anchorId) {
      const restoredAnchor = logCenter.querySelector(`[data-log-id="${CSS.escape(anchorId)}"]`);
      logCenter.scrollTop += (restoredAnchor?.getBoundingClientRect().top ?? anchorViewportTop) - anchorViewportTop;
    } else {
      logCenter.scrollTop = previousScrollTop;
    }
  }

  const stageProgress = document.querySelector('#runsStageProgress');
  if (stageProgress) {
    const scrollTop = stageProgress.querySelector('.timeline')?.scrollTop ?? 0;
    stageProgress.outerHTML = buildRunsStageProgressMarkup(viewModel);
    document.querySelector('#runsStageProgress .timeline').scrollTop = scrollTop;
  }

  const currentStage = document.querySelector('#runsCurrentStage');
  if (currentStage) {
    // Preserve the focused run controls while live events refresh details.
    const template = document.createElement('template');
    template.innerHTML = buildRunsCurrentStageMarkup(viewModel);
    currentStage.querySelector('[data-current-stage-body]').replaceWith(template.content.querySelector('[data-current-stage-body]'));
    currentStage.querySelector('.panel-headline > .badge').replaceWith(template.content.querySelector('.panel-headline > .badge'));
  }

  const hero = document.querySelector('.status-hero-card');
  if (hero) {
    const summary = resolveDashboardRunSummary(viewModel);
    const copy = hero.querySelector('.dashboard-state-copy');
    if (copy.querySelector('h3')?.textContent !== viewModel.currentStatusLabel
      || Boolean(copy.querySelector('p')) !== summary.failed) {
      copy.innerHTML = buildDashboardStateMarkup(viewModel);
    }
    hero.classList.toggle('is-running', summary.isRunning);
    hero.dataset.tone = viewModel.runStateTone;
  }

  renderAnalytics(document.querySelector('#dashboardAnalytics'), viewModel);
  const dashboardMetrics = document.querySelector('#dashboardMetricsPanel');
  if (dashboardMetrics) {
    dashboardMetrics.outerHTML = buildDashboardMetricsMarkup(viewModel);
  }
}

function handleLogScroll(event) {
  if (event.target?.id !== 'logCenterTable') return;
  const distance = event.target.scrollHeight - event.target.scrollTop - event.target.clientHeight;
  state.logView.follow = distance <= 32;
  if (state.logView.follow) {
    state.logView.unseenCount = 0;
    event.target.closest('#logsWorkspace')?.querySelectorAll('[data-log-jump-latest]').forEach((node) => node.remove());
  }
}

function scrollLogToLatest() {
  const logCenter = document.querySelector('#logCenterTable');
  if (logCenter) logCenter.scrollTop = logCenter.scrollHeight;
}

function resolveVisibleLogEntries() {
  return filterLogEntries((state.logEntries ?? []).map((entry) => classifyLogEntry(entry)), state.logFilter);
}

function touchUpdate() {
  state.lastUpdateAt = Date.now();
}

bootstrap();
