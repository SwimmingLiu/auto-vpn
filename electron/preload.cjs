const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vpnAutomation', {
  loadProfile: () => ipcRenderer.invoke('profile:load'),
  saveProfile: (payload) => ipcRenderer.invoke('profile:save', payload),
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
