export function renderWebAdapterScript(): string {
  return `
(() => {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || window.localStorage.getItem('autovpn.server.token') || '';
  if (token) {
    window.localStorage.setItem('autovpn.server.token', token);
  }

  function withToken(path) {
    if (!token) return path;
    const url = new URL(path, window.location.origin);
    url.searchParams.set('token', token);
    return url.pathname + url.search;
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'request_failed');
    }
    return payload;
  }

  async function state() {
    return request('/api/state');
  }

  window.vpnAutomation = {
    loadProfile: async () => {
      const payload = await state();
      return payload.profile || {};
    },
    saveProfile: async (profile) => request('/api/profile', {
      method: 'POST',
      body: JSON.stringify(profile || {})
    }),
    runPipeline: async (options = {}) => request('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        skipDeploy: Boolean(options.skipDeploy),
        skipVerify: Boolean(options.skipVerify),
        resumeLatest: Boolean(options.resumeLatest)
      })
    }),
    stopPipeline: async () => request('/api/runs/current/stop', { method: 'POST' }),
    openUrl: async (url) => {
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return { ok: true };
    },
    openPath: async () => ({ ok: false, error: 'open_path_unavailable_in_browser' }),
    generateQr: async (text) => request('/api/qr', {
      method: 'POST',
      body: JSON.stringify({ text: String(text || '') })
    }),
    previewArtifact: async () => {
      const payload = await state();
      return payload.artifact ? { ok: true, ...payload.artifact } : { ok: false };
    },
    latestArtifact: async () => {
      const payload = await state();
      return payload.artifact ? { ok: true, ...payload.artifact } : { ok: false };
    },
    artifactList: async () => {
      const payload = await state();
      return { ok: true, items: payload.retryArtifacts || [] };
    },
    retryStage: async (options = {}) => request('/api/runs/retry-stage', {
      method: 'POST',
      body: JSON.stringify({
        artifactDir: String(options.artifactDir || ''),
        stage: String(options.stage || '')
      })
    }),
    copyText: async (text) => {
      await navigator.clipboard.writeText(String(text || ''));
      return { ok: true };
    },
    exportLogs: async () => ({ ok: false, error: 'export_logs_unavailable_in_browser' }),
    onPipelineEvent: (callback) => {
      const events = new EventSource(withToken('/api/events'));
      events.onmessage = (event) => {
        try {
          callback(JSON.parse(event.data));
        } catch {
          callback({ type: 'log', message: event.data });
        }
      };
      events.onerror = () => {};
      return () => events.close();
    }
  };
})();
`;
}
