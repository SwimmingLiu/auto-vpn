import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { clipboard, ipcMain, shell } from 'electron';
import QRCode from 'qrcode';

import { mergeLatestArtifactPreview, previewArtifactDirectory } from './lib/artifact-preview.js';
import { buildBackendInvocation, parseBackendEventLine } from './lib/backend.js';
import { signalProcessTree } from './lib/process-lifecycle.js';
import { resolveStateProfilePath } from './paths.js';

const IPC_CHANNELS = [
  'profile:load',
  'profile:save',
  'shell:open-path',
  'clipboard:write-text',
  'logs:export',
  'pipeline:run',
  'pipeline:stop',
  'external:open-url',
  'external:open-path',
  'artifact:preview',
  'artifact:latest',
  'artifact:list',
  'pipeline:retry-stage',
  'qr:generate'
];

function profilePath(projectRoot, runtimeProfilePath) {
  return runtimeProfilePath || resolveStateProfilePath(projectRoot);
}

export function registerIpcHandlers({ mainWindow, projectRoot, runtimeProfilePath = '', bundledProfilePath = '' }) {
  for (const channel of IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }

  let activePipelineChild = null;
  let stopRequested = false;
  let stopTimer = null;

  function emit(payload) {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pipeline:event', payload);
    }
  }

  function clearStopTimer() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  }

  function stopActivePipeline() {
    if (!activePipelineChild) {
      return { ok: false, requested: false };
    }

    stopRequested = true;
    const child = activePipelineChild;
    const signaled = signalProcessTree(child, 'SIGTERM');

    if (!signaled) {
      return { ok: false, requested: true };
    }

    clearStopTimer();
    stopTimer = setTimeout(() => {
      if (activePipelineChild === child) {
        signalProcessTree(child, 'SIGKILL');
      }
    }, 4000);
    stopTimer.unref?.();

    return { ok: true, requested: true };
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
    return openPathWithShell(String(targetPath ?? '').trim(), { strictExists: false });
  });

  ipcMain.handle('clipboard:write-text', async (_event, text) => {
    const value = String(text ?? '');
    if (!value.trim()) {
      return { ok: false, error: 'empty_text' };
    }
    clipboard.writeText(value);
    return { ok: true };
  });

  ipcMain.handle('logs:export', async (_event, content) => {
    const baseProfilePath = profilePath(projectRoot, runtimeProfilePath);
    const logsRoot = path.join(path.dirname(path.dirname(baseProfilePath)), 'logs');
    fs.mkdirSync(logsRoot, { recursive: true });
    const outputPath = path.join(logsRoot, `session-${Date.now()}.log`);
    fs.writeFileSync(outputPath, String(content ?? ''), 'utf-8');
    return { ok: true, path: outputPath };
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
      env: buildBackendEnv(projectRoot, runtimeProfilePath, bundledProfilePath),
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
      clearStopTimer();
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
      clearStopTimer();
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
    return stopActivePipeline();
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
    return openPathWithShell(String(targetPath ?? ''), { strictExists: true });
  });

  ipcMain.handle('artifact:preview', async (_event, artifactDir) => {
    return previewArtifactDirectory(artifactDir);
  });

  ipcMain.handle('artifact:latest', async () => {
    const invocation = buildBackendInvocation(projectRoot, 'artifact-latest');
    const output = await runCommand(
      invocation.commands,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath
    );
    const report = JSON.parse(output.stdout);
    if (!report?.ok) {
      return { ok: false, artifact_dir: '' };
    }
    return mergeLatestArtifactPreview(report, previewArtifactDirectory(report.artifact_dir));
  });

  ipcMain.handle('artifact:list', async () => {
    const invocation = buildBackendInvocation(projectRoot, 'artifact-list');
    const output = await runCommand(
      invocation.commands,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath
    );
    return JSON.parse(output.stdout);
  });

  ipcMain.handle('pipeline:retry-stage', async (_event, payload = {}) => {
    if (activePipelineChild) {
      return { ok: false, code: null, signal: null, stopped: false, error: 'already_running' };
    }

    const artifactDir = String(payload?.artifactDir ?? '').trim();
    const stageName = String(payload?.stage ?? '').trim();
    if (!artifactDir || !stageName) {
      return { ok: false, code: null, signal: null, stopped: false, error: 'invalid_retry_payload' };
    }

    const invocation = buildBackendInvocation(projectRoot, 'retry-stage', [
      '--artifact-dir',
      artifactDir,
      '--stage',
      stageName
    ]);
    const command = selectBackendCommand(invocation.commands);
    const child = spawn(command, invocation.args, {
      cwd: projectRoot,
      env: buildBackendEnv(projectRoot, runtimeProfilePath, bundledProfilePath),
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
      clearStopTimer();
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
      clearStopTimer();
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

  ipcMain.handle('qr:generate', async (_event, text) => ({
    ok: true,
    dataUrl: await QRCode.toDataURL(String(text ?? ''), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 192,
      color: { dark: '#111826', light: '#ffffff' }
    })
  }));

  return {
    stopActivePipeline,
    dispose() {
      for (const channel of IPC_CHANNELS) {
        ipcMain.removeHandler(channel);
      }
    }
  };
}

function runCommand(commands, args, cwd, runtimeProfilePath = '', bundledProfilePath = '', input = '') {
  return new Promise((resolve, reject) => {
    const command = selectBackendCommand(commands);
    const child = spawn(command, args, {
      cwd,
      env: buildBackendEnv(cwd, runtimeProfilePath, bundledProfilePath),
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

function buildBackendEnv(projectRoot, runtimeProfilePath = '', bundledProfilePath = '') {
  return {
    ...process.env,
    PYTHONPATH: path.join(projectRoot, 'src'),
    VPN_AUTOMATION_PROFILE_PATH: runtimeProfilePath,
    VPN_AUTOMATION_BUNDLED_PROFILE_PATH: bundledProfilePath
  };
}

async function openPathWithShell(targetPath, { strictExists = false } = {}) {
  const normalized = String(targetPath ?? '').trim();
  if (!normalized) {
    return { ok: false, error: 'empty_path' };
  }

  const resolved = path.resolve(normalized);
  if (strictExists && !fs.existsSync(resolved)) {
    return { ok: false, error: 'path_not_found' };
  }

  const error = await shell.openPath(resolved);
  return error ? { ok: false, error } : { ok: true, path: resolved };
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
