import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { ipcMain, shell } from 'electron';

import { buildBackendInvocation, parseBackendEventLine } from './lib/backend.js';
import { resolveStateProfilePath } from './paths.js';

function profilePath(projectRoot, runtimeProfilePath) {
  return runtimeProfilePath || resolveStateProfilePath(projectRoot);
}

export function registerIpcHandlers({ mainWindow, projectRoot, runtimeProfilePath = '', bundledProfilePath = '' }) {
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
    const output = await runCommand(
      invocation.commands,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath
    );
    return JSON.parse(output.stdout);
  });

  ipcMain.handle('profile:save', async (_event, payload) => {
    const invocation = buildBackendInvocation(projectRoot, 'profile-save');
    await runCommand(
      invocation.commands,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath,
      JSON.stringify(payload)
    );
    return { ok: true };
  });

  ipcMain.handle('shell:open-path', async (_event, targetPath) => {
    const normalized = String(targetPath ?? '').trim();
    if (!normalized) {
      return { ok: false, error: 'empty_path' };
    }
    const error = await shell.openPath(normalized);
    return { ok: !error, error };
  });

  ipcMain.handle('logs:export', async (_event, content) => {
    const baseProfilePath = profilePath(projectRoot, runtimeProfilePath);
    const logsRoot = path.join(path.dirname(path.dirname(baseProfilePath)), 'logs');
    fs.mkdirSync(logsRoot, { recursive: true });
    const outputPath = path.join(logsRoot, `session-${Date.now()}.log`);
    fs.writeFileSync(outputPath, String(content ?? ''), 'utf-8');
    return { ok: true, path: outputPath };
  });

  ipcMain.handle('pipeline:run', async () => {
    if (activePipelineChild) {
      return { ok: false, code: null, signal: null, stopped: false, error: 'already_running' };
    }

    const invocation = buildBackendInvocation(projectRoot, 'run');
    const command = selectBackendCommand(invocation.commands);
    const child = spawn(command, invocation.args, {
      cwd: projectRoot,
      env: buildBackendEnv(projectRoot, runtimeProfilePath, bundledProfilePath)
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

function runCommand(commands, args, cwd, runtimeProfilePath = '', bundledProfilePath = '', input = '') {
  return new Promise((resolve, reject) => {
    const command = selectBackendCommand(commands);
    const child = spawn(command, args, {
      cwd,
      env: buildBackendEnv(cwd, runtimeProfilePath, bundledProfilePath)
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

function buildBackendEnv(projectRoot, runtimeProfilePath = '', bundledProfilePath = '') {
  return {
    ...process.env,
    PYTHONPATH: path.join(projectRoot, 'src'),
    VPN_AUTOMATION_PROFILE_PATH: runtimeProfilePath,
    VPN_AUTOMATION_BUNDLED_PROFILE_PATH: bundledProfilePath
  };
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
