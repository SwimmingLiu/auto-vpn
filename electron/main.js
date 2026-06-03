import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, screen } from 'electron';

import { registerIpcHandlers } from './ipc.js';
import {
  resolveBundledProfilePath,
  resolveProjectRoot,
  resolveRuntimeArtifactsPath,
  resolveStateProfilePath
} from './paths.js';
import { buildWindowOptions } from './window-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const activeLifecycles = new Set();

function stopAllBackendServices() {
  for (const lifecycle of activeLifecycles) {
    lifecycle.stopActivePipeline();
  }
}

function createWindow() {
  const workAreaSize = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow(buildWindowOptions(path.join(__dirname, 'preload.cjs'), workAreaSize));

  const projectRoot = resolveProjectRoot();
  const runtimeProfilePath = resolveStateProfilePath(projectRoot, {
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData')
  });
  const runtimeArtifactsPath = resolveRuntimeArtifactsPath(projectRoot, {
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData')
  });
  const bundledProfilePath = resolveBundledProfilePath(projectRoot);
  const lifecycle = registerIpcHandlers({
    mainWindow: win,
    projectRoot,
    runtimeProfilePath,
    bundledProfilePath,
    runtimeArtifactsPath
  });
  activeLifecycles.add(lifecycle);
  win.on('close', () => {
    lifecycle.stopActivePipeline();
  });
  win.on('closed', () => {
    lifecycle.dispose();
    activeLifecycles.delete(lifecycle);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopAllBackendServices();
});
