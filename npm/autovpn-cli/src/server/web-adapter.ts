export interface WebAdapterOptions {
  passwordEnabled?: boolean;
}

export function renderWebAdapterScript(options: WebAdapterOptions = {}): string {
  return `
(() => {
  const passwordEnabled = ${JSON.stringify(Boolean(options.passwordEnabled))};
  const params = new URLSearchParams(window.location.search);
  let token = params.get('token') || window.localStorage.getItem('autovpn.server.token') || '';
  if (token) {
    window.localStorage.setItem('autovpn.server.token', token);
  }

  function withToken(path) {
    if (!token) return path;
    const url = new URL(path, window.location.origin);
    url.searchParams.set('token', token);
    return url.pathname + url.search;
  }

  function ensureLoginStyles() {
    if (document.getElementById('autovpn-server-login-style')) return;
    const style = document.createElement('style');
    style.id = 'autovpn-server-login-style';
    style.textContent = [
      '.server-login-page{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:28px;background:radial-gradient(circle at top left,rgba(91,92,226,.08),transparent 24%),linear-gradient(180deg,#fbfcff 0%,var(--bg,#f5f7ff) 100%);font-family:Inter,"SF Pro Display","PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--text,#1e2746);}',
      '.server-login-panel{width:min(440px,calc(100vw - 40px));display:grid;gap:22px;padding:30px;border:1px solid var(--border,#dfe5f5);border-radius:20px;background:rgba(255,255,255,.96);box-shadow:var(--shadow,0 20px 44px rgba(29,39,71,.1));}',
      '.server-login-brand{display:flex;align-items:center;gap:14px;}',
      '.server-login-logo{width:54px;height:54px;object-fit:contain;border-radius:18px;}',
      '.server-login-title{margin:0;font-size:28px;font-weight:850;letter-spacing:0;}',
      '.server-login-copy{margin:5px 0 0;color:var(--text-soft,#6d7794);line-height:1.5;}',
      '.server-login-form{display:grid;gap:14px;}',
      '.server-login-form input{width:100%;min-height:48px;border:1px solid var(--border,#dfe5f5);border-radius:14px;background:#fff;color:var(--text,#1e2746);padding:0 14px;outline:none;}',
      '.server-login-form input:focus{border-color:rgba(91,92,226,.45);box-shadow:0 0 0 4px rgba(91,92,226,.12);}',
      '.server-login-form button{min-height:48px;border:0;border-radius:14px;background:var(--accent,#5b5ce2);color:#fff;font-weight:800;cursor:pointer;box-shadow:0 12px 28px rgba(91,92,226,.22);}',
      '.server-login-form button:disabled{background:var(--border-strong,#cfd7ef);box-shadow:none;cursor:not-allowed;}',
      '.server-login-error{min-height:22px;margin:0;color:var(--danger,#f05b69);font-weight:700;}'
    ].join('');
    document.head.append(style);
  }

  function loginMessage(payload) {
    if (payload?.error === 'ip_banned') return '密码错误次数过多，此 IP 已被封禁。';
    if (payload?.error === 'invalid_password') {
      const remaining = Number(payload.attemptsRemaining ?? 0);
      return '密码错误，剩余 ' + remaining + ' 次尝试。';
    }
    return '登录失败，请重试。';
  }

  function showLoginPage(message = '', banned = false) {
    ensureLoginStyles();
    let root = document.querySelector('[data-server-login]');
    if (!root) {
      root = document.createElement('section');
      root.className = 'server-login-page';
      root.setAttribute('data-server-login', '');
      root.innerHTML = [
        '<div class="server-login-panel">',
        '<div class="server-login-brand">',
        '<img class="server-login-logo" src="./assets/vpn-auto-logo-v2-minimal.svg" alt="" aria-hidden="true" />',
        '<div>',
        '<h1 class="server-login-title">AutoVPN</h1>',
        '<p class="server-login-copy">输入 serve 启动时打印的密码继续访问。</p>',
        '</div>',
        '</div>',
        '<form class="server-login-form" data-server-login-form>',
        '<input data-server-password type="password" autocomplete="current-password" placeholder="密码" />',
        '<button data-server-login-submit type="submit">登录</button>',
        '<p class="server-login-error" data-server-login-error aria-live="polite"></p>',
        '</form>',
        '</div>'
      ].join('');
      document.body.append(root);
    }
    const error = root.querySelector('[data-server-login-error]');
    const submit = root.querySelector('[data-server-login-submit]');
    const input = root.querySelector('[data-server-password]');
    if (error) error.textContent = message;
    if (submit) submit.disabled = Boolean(banned);
    if (input) {
      input.disabled = Boolean(banned);
      if (!banned) input.focus();
    }
    return root;
  }

  function hideLoginPage() {
    document.querySelector('[data-server-login]')?.remove();
  }

  async function submitPassword(password) {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.token) {
      return { ok: false, status: response.status, payload };
    }
    token = String(payload.token);
    window.localStorage.setItem('autovpn.server.token', token);
    hideLoginPage();
    return { ok: true, token };
  }

  function loginWithPassword(message = '') {
    return new Promise((resolve, reject) => {
      const root = showLoginPage(message);
      const form = root.querySelector('[data-server-login-form]');
      const input = root.querySelector('[data-server-password]');
      form.onsubmit = async (event) => {
        event.preventDefault();
        const result = await submitPassword(input?.value || '');
        if (result.ok) {
          resolve(result.token);
          return;
        }
        const banned = result.payload?.error === 'ip_banned' || result.status === 403;
        showLoginPage(loginMessage(result.payload), banned);
        if (banned) {
          reject(new Error('ip_banned'));
        }
      };
    });
  }

  async function request(path, requestOptions = {}) {
    if (passwordEnabled && !token) {
      await loginWithPassword();
    }
    const headers = { ...(requestOptions.headers || {}) };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (requestOptions.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { ...requestOptions, headers });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && passwordEnabled) {
      window.localStorage.removeItem('autovpn.server.token');
      token = '';
      await loginWithPassword('登录已过期，请重新输入密码。');
      return request(path, requestOptions);
    }
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
