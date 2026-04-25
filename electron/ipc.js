import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { ipcMain, shell } from 'electron';
import QRCode from 'qrcode';

import { previewArtifactDirectory } from './lib/artifact-preview.js';
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

  ipcMain.handle('pipeline:run', async (_event, options = {}) => {
    if (activePipelineChild) {
      return { ok: false, code: null, signal: null, stopped: false, error: 'already_running' };
    }

    const invocation = buildBackendInvocation(projectRoot, 'run');
    const command = selectBackendCommand(invocation.commands);
    const runArgs = [...invocation.args];
    if (options?.skipDeploy) {
      runArgs.push('--skip-deploy');
    }
    if (options?.skipVerify) {
      runArgs.push('--skip-verify');
    }
    const child = spawn(command, runArgs, {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONPATH: path.join(projectRoot, 'src')
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
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

    child.on('error', (error) => {
      if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
      activePipelineChild = null;
      emit({
        type: 'finished',
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
      emit({
        type: 'finished',
        ok: code === 0 && !stopped,
        code,
        signal,
        stopped
      });
    });

    child.unref();

    return { ok: true, pid: child.pid };
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

  ipcMain.handle('external:open-url', async (_event, url) => {
    const parsed = new URL(String(url ?? ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }
    await shell.openExternal(parsed.toString());
    return { ok: true };
  });

  ipcMain.handle('external:open-path', async (_event, targetPath) => {
    const resolved = path.resolve(String(targetPath ?? ''));
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: 'path_not_found' };
    }
    const error = await shell.openPath(resolved);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('artifact:preview', async (_event, artifactDir) => {
    return previewArtifactDirectory(artifactDir);
  });

  ipcMain.handle('qr:generate', async (_event, text) => ({
    ok: true,
    dataUrl: await QRCode.toDataURL(String(text ?? ''), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 192,
      color: { dark: '#111826', light: '#ffffff' }
    })
  }));
}

function runCommand(commands, args, cwd, input = '') {
  return new Promise((resolve, reject) => {
    const command = selectBackendCommand(commands);
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        PYTHONPATH: path.join(cwd, 'src')
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
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
