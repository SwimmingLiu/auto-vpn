const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vpnAutomation', {
  loadProfile: () => ipcRenderer.invoke('profile:load'),
  saveProfile: (payload) => ipcRenderer.invoke('profile:save', payload),
  runPipeline: () => ipcRenderer.invoke('pipeline:run'),
  onPipelineEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('pipeline:event', listener);
    return () => ipcRenderer.removeListener('pipeline:event', listener);
  }
});
