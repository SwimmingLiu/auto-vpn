const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vpnAutomation', {
  loadState: () => ipcRenderer.invoke('state:load'),
  loadProfile: () => ipcRenderer.invoke('profile:load'),
  saveProfile: (payload) => ipcRenderer.invoke('profile:save', payload),
  loadAccounts: () => ipcRenderer.invoke('accounts:snapshot'),
  importAccounts: (content, format) => ipcRenderer.invoke('accounts:import', { content, format }),
  setAccountStatus: (payload) => ipcRenderer.invoke('accounts:status', payload),
  // Agreed contract for the renderer: setAccountExpiry(id, date) where `date`
  // is YYYY-MM-DD, or '' to clear the stored date.
  setAccountExpiry: (id, date) => ipcRenderer.invoke('accounts:expiry', { id, expires_at: date }),
  accountsTemplate: () => ipcRenderer.invoke('accounts:template'),
  // Logs in to pooled accounts to learn their membership date and retires the
  // lapsed / non-member rows. Returns the worker's outcome counts.
  refreshAccountExpiry: (payload) => ipcRenderer.invoke('accounts:refresh-expiry', payload),
  runPipeline: (options) => ipcRenderer.invoke('pipeline:run', options),
  stopPipeline: () => ipcRenderer.invoke('pipeline:stop'),
  openUrl: (url) => ipcRenderer.invoke('external:open-url', url),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),
  generateQr: (text) => ipcRenderer.invoke('qr:generate', text),
  previewArtifact: (artifactDir) => ipcRenderer.invoke('artifact:preview', artifactDir),
  latestArtifact: () => ipcRenderer.invoke('artifact:latest'),
  artifactList: () => ipcRenderer.invoke('artifact:list'),
  retryStage: (payload) => ipcRenderer.invoke('pipeline:retry-stage', payload),
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  exportLogs: (content) => ipcRenderer.invoke('logs:export', content),
  onPipelineEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('pipeline:event', listener);
    return () => ipcRenderer.removeListener('pipeline:event', listener);
  }
});
