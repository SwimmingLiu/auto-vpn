import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { ipcMain } from 'electron';

import { buildBackendInvocation, parseBackendEventLine } from './lib/backend.js';

export function registerIpcHandlers({ mainWindow, projectRoot }) {
  let activePipelineChild = null;
  let stopRequested = false;
  let stopTimer = null;

  function emit(payload) {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pipeline:event', payload);
    }
  }

  ipcMain.handle('profile:load', async () => {
    const invocation = buildBackendInvocation(projectRoot, 'profile');
    const output = await runCommand(invocation.commands, invocation.args, projectRoot);
    return JSON.parse(output.stdout);
  });

  ipcMain.handle('profile:save', async (_event, payload) => {
    const invocation = buildBackendInvocation(projectRoot, 'profile-save');
    await runCommand(invocation.commands, invocation.args, projectRoot, JSON.stringify(payload));
    return { ok: true };
  });

  ipcMain.handle('pipeline:run', async () => {
    if (activePipelineChild) {
      return { ok: false, code: null, signal: null, stopped: false, error: 'already_running' };
    }

    const invocation = buildBackendInvocation(projectRoot, 'run');
    const command = selectBackendCommand(invocation.commands);
    const child = spawn(command, invocation.args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONPATH: path.join(projectRoot, 'src')
      }
    });
    activePipelineChild = child;
    stopRequested = false;

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        const event = parseBackendEventLine(line);
        if (event) {
          emit(event);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        emit({ type: 'log', message });
      }
    });

    return new Promise((resolve) => {
      child.on('error', (error) => {
        if (stopTimer) {
          clearTimeout(stopTimer);
          stopTimer = null;
        }
        activePipelineChild = null;
        resolve({
          ok: false,
          code: null,
          signal: null,
          stopped: stopRequested,
          error: error.message
        });
      });

      child.on('close', (code, signal) => {
        if (stopTimer) {
          clearTimeout(stopTimer);
          stopTimer = null;
        }
        activePipelineChild = null;
        const stopped = stopRequested || signal === 'SIGTERM' || signal === 'SIGKILL';
        resolve({
          ok: code === 0 && !stopped,
          code,
          signal,
          stopped
        });
      });
    });
  });

  ipcMain.handle('pipeline:stop', async () => {
    if (!activePipelineChild) {
      return { ok: false, requested: false };
    }

    stopRequested = true;
    const child = activePipelineChild;
    const signaled = child.kill('SIGTERM');

    if (!signaled) {
      return { ok: false, requested: true };
    }

    if (stopTimer) {
      clearTimeout(stopTimer);
    }
    stopTimer = setTimeout(() => {
      if (activePipelineChild === child && !child.killed) {
        child.kill('SIGKILL');
      }
    }, 4000);

    return { ok: true, requested: true };
  });
}

function runCommand(commands, args, cwd, input = '') {
  return new Promise((resolve, reject) => {
    const command = selectBackendCommand(commands);
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
    if (input) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
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

function selectBackendCommand(commands) {
  for (const command of commands) {
    if (command.startsWith('/')) {
      if (fs.existsSync(command)) {
        return command;
      }
      continue;
    }

    const probe = spawnSync(command, ['-c', 'pass'], { stdio: 'ignore' });
    if (!probe.error) {
      return command;
    }
  }
  throw new Error(`No runnable backend python found in candidates: ${commands.join(', ')}`);
}
