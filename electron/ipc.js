import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ipcMain } from 'electron';

import { buildBackendInvocation, parseBackendEventLine } from './lib/backend.js';
import { resolveStateProfilePath } from './paths.js';

function profilePath(projectRoot) {
  return resolveStateProfilePath(projectRoot);
}

export function registerIpcHandlers({ mainWindow, projectRoot }) {
  ipcMain.handle('profile:load', async () => {
    const invocation = buildBackendInvocation(projectRoot, 'profile');
    const output = await runCommand(invocation.command, invocation.args, projectRoot);
    return JSON.parse(output.stdout);
  });

  ipcMain.handle('profile:save', async (_event, payload) => {
    const target = profilePath(projectRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf-8');
    return { ok: true };
  });

  ipcMain.handle('pipeline:run', async () => {
    const invocation = buildBackendInvocation(projectRoot, 'run');
    const child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONPATH: path.join(projectRoot, 'src')
      }
    });

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        const event = parseBackendEventLine(line);
        if (event) {
          mainWindow.webContents.send('pipeline:event', event);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        mainWindow.webContents.send('pipeline:event', { type: 'log', message });
      }
    });

    return new Promise((resolve) => {
      child.on('close', (code) => resolve({ ok: code === 0, code }));
    });
  });
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        PYTHONPATH: path.join(cwd, 'src')
      }
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Command failed: ${command}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}
