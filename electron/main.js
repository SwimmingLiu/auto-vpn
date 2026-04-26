import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, screen } from 'electron';

import { registerIpcHandlers } from './ipc.js';
import { resolveBundledProfilePath, resolveProjectRoot, resolveStateProfilePath } from './paths.js';
import { buildWindowOptions } from './window-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow() {
  const workAreaSize = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow(buildWindowOptions(path.join(__dirname, 'preload.cjs'), workAreaSize));

  const projectRoot = resolveProjectRoot();
  const runtimeProfilePath = resolveStateProfilePath(projectRoot, {
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData')
  });
  const bundledProfilePath = resolveBundledProfilePath(projectRoot);
  registerIpcHandlers({ mainWindow: win, projectRoot, runtimeProfilePath, bundledProfilePath });
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
