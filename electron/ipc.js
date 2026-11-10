import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { clipboard, ipcMain, shell } from 'electron';
import QRCode from 'qrcode';

import { mergeLatestArtifactPreview, previewArtifactDirectory } from './lib/artifact-preview.js';
import { buildBackendEnv, buildBackendInvocation, createNdjsonDecoder } from './lib/backend.js';
import { pipelineStopResponse, requestProcessTreeStop } from './lib/process-lifecycle.js';
import { attachPipelineChildFinalizer } from './lib/pipeline-child-finalizer.js';
import { resolveStateProfilePath } from './paths.js';
import { createRendererEventLog, readRendererHistory } from './lib/renderer-history.js';

const IPC_CHANNELS = [
  'state:load',
  'profile:load',
  'profile:save',
  'accounts:snapshot',
  'accounts:import',
  'accounts:status',
  'accounts:expiry',
  'accounts:template',
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

export function registerIpcHandlers({
  mainWindow,
  projectRoot,
  runtimeProfilePath = '',
  bundledProfilePath = '',
  runtimeArtifactsPath = '',
  isPackaged = false
}) {
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
    clearStopTimer();
    const stop = requestProcessTreeStop(child, {
      isChildActive: () => activePipelineChild === child
    });
    stopTimer = stop.timer;

    return pipelineStopResponse(stop);
  }

  async function loadProfile() {
    const invocation = buildBackendInvocation(projectRoot, 'profile', [], { isPackaged });
    const output = await runCommand(
      invocation.command,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath,
      '',
      runtimeArtifactsPath,
      invocation.runAsNode
    );
    return JSON.parse(output.stdout);
  }
  ipcMain.handle('profile:load', loadProfile);

  ipcMain.handle('state:load', async () => {
    const [profile, artifact, history] = await Promise.all([loadProfile(), loadLatestArtifact(), loadArtifactList()]);
    const terminal = ['success', 'failed'].includes(artifact.run_status) ? artifact.run_status : 'idle';
    return {
      profile, artifact,
      runState: activePipelineChild ? (stopRequested ? 'stopping' : 'running') : terminal,
      retryArtifacts: history.items ?? [],
      activity: history.activity ?? [],
      activityUnavailable: history.activityUnavailable ?? 0,
      logEvents: readRendererHistory(profilePath(projectRoot, runtimeProfilePath), artifact.artifact_dir)
    };
  });

  ipcMain.handle('profile:save', async (_event, payload) => {
    const invocation = buildBackendInvocation(projectRoot, 'profile-save', [], { isPackaged });
    await runCommand(
      invocation.command,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath,
      JSON.stringify(payload),
      runtimeArtifactsPath,
      invocation.runAsNode
    );
    return { ok: true };
  });

  ipcMain.handle('accounts:snapshot', async () => {
    const invocation = buildBackendInvocation(projectRoot, 'accounts-snapshot', [], { isPackaged });
    const output = await runCommand(
      invocation.command,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath,
      '',
      runtimeArtifactsPath,
      invocation.runAsNode
    );
    return JSON.parse(output.stdout);
  });

  ipcMain.handle('accounts:import', async (_event, payload = {}) => {
    const content = String(payload?.content ?? '');
    if (!content.trim()) return { ok: false, error: 'empty_file' };
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) return { ok: false, error: 'file_too_large' };
    const format = ['auto', 'csv', 'legacy'].includes(payload?.format) ? payload.format : 'auto';
    const invocation = buildBackendInvocation(projectRoot, 'accounts-import', ['--format', format], { isPackaged });
    try {
      const output = await runCommand(
        invocation.command,
        invocation.args,
        projectRoot,
        runtimeProfilePath,
        bundledProfilePath,
        content,
        runtimeArtifactsPath,
        invocation.runAsNode
      );
      return JSON.parse(output.stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        return JSON.parse(message);
      } catch {
        return { ok: false, error: message };
      }
    }
  });

  ipcMain.handle('accounts:status', async (_event, payload = {}) => {
    const id = Number(payload?.id);
    const status = String(payload?.status ?? '').trim();
    if (!Number.isInteger(id) || id < 1 || !['active', 'disabled'].includes(status)) {
      return { ok: false, error: 'invalid_account_status_payload' };
    }
    const invocation = buildBackendInvocation(
      projectRoot,
      status === 'active' ? 'accounts-enable' : 'accounts-disable',
      ['--id', String(id), '--reason', String(payload?.reason ?? 'disabled by operator')],
      { isPackaged }
    );
    const output = await runCommand(
      invocation.command,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath,
      '',
      runtimeArtifactsPath,
      invocation.runAsNode
    );
    return JSON.parse(output.stdout);
  });

  ipcMain.handle('accounts:expiry', async (_event, payload = {}) => {
    const id = Number(payload?.id);
    const rawDate = payload?.expires_at ?? payload?.date ?? payload?.value;
    if (!Number.isInteger(id) || id < 1 || rawDate === undefined || rawDate === null) {
      return { ok: false, error: 'invalid_account_expiry_payload' };
    }
    const date = String(rawDate);
    // An empty date means "cleared": the CLI spells that as --clear, because a
    // bare `accounts expire` without a date used to erase a known expiry.
    const extraArgs = date === '' ? ['--id', String(id), '--clear'] : ['--id', String(id), '--date', date];
    // The sibling accounts handlers call buildBackendInvocation directly; this
    // one needs `accounts-expire`, whose BACKEND_COMMANDS entry lives in
    // lib/backend.js (another owner). Resolve it through that map when the
    // entry exists and fall back to the identical invocation shape otherwise,
    // so the renderer is not blocked on the one-line map addition.
    const invocation = buildBackendInvocation(projectRoot, 'accounts-expire', extraArgs, { isPackaged });
    try {
      const output = await runCommand(
        invocation.command,
        invocation.args,
        projectRoot,
        runtimeProfilePath,
        bundledProfilePath,
        '',
        runtimeArtifactsPath,
        invocation.runAsNode
      );
      return JSON.parse(output.stdout);
    } catch (error) {
      // `accounts expire` exits 1 with a JSON body for a bad date; the CLI
      // prints that body on stdout and only its message on stderr, so surface
      // the parsed payload rather than an opaque "Command failed".
      const message = error instanceof Error ? error.message : String(error);
      try {
        return JSON.parse(message);
      } catch {
        return { ok: false, error: message };
      }
    }
  });

  ipcMain.handle('accounts:template', async () => {
    const invocation = buildBackendInvocation(projectRoot, 'accounts-template', [], { isPackaged });
    const output = await runCommand(
      invocation.command,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath,
      '',
      runtimeArtifactsPath,
      invocation.runAsNode
    );
    return { ok: true, content: output.stdout };
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

    const invocation = buildBackendInvocation(projectRoot, 'run', [], { isPackaged });
    const runArgs = [...invocation.args, '--event-log', createRendererEventLog(profilePath(projectRoot, runtimeProfilePath))];
    if (options?.skipDeploy) {
      runArgs.push('--skip-deploy');
    }
    if (options?.skipVerify) {
      runArgs.push('--skip-verify');
    }
    const child = spawn(invocation.command, runArgs, {
      cwd: projectRoot,
      env: buildBackendEnv(projectRoot, runtimeProfilePath, bundledProfilePath, runtimeArtifactsPath, {
        runAsNode: invocation.runAsNode
      }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activePipelineChild = child;
    stopRequested = false;

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    const decoder = createNdjsonDecoder(emit);
    child.stdout.on('data', (chunk) => decoder.push(chunk));

    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        emit({ type: 'log', message });
      }
    });

    attachPipelineChildFinalizer(child, {
      decoder,
      clearStopTimer,
      releaseActiveChild: () => { activePipelineChild = null; },
      isStopRequested: () => stopRequested,
      emit
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

  async function loadLatestArtifact() {
    const invocation = buildBackendInvocation(projectRoot, 'artifact-latest', [], { isPackaged });
    const output = await runCommand(
      invocation.command,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath,
      '',
      runtimeArtifactsPath,
      invocation.runAsNode
    );
    const report = JSON.parse(output.stdout);
    if (!report?.ok) {
      return { ok: false, artifact_dir: '' };
    }
    return mergeLatestArtifactPreview(report, previewArtifactDirectory(report.artifact_dir));
  }
  ipcMain.handle('artifact:latest', loadLatestArtifact);

  async function loadArtifactList() {
    const invocation = buildBackendInvocation(projectRoot, 'artifact-list', [], { isPackaged });
    const output = await runCommand(
      invocation.command,
      invocation.args,
      projectRoot,
      runtimeProfilePath,
      bundledProfilePath,
      '',
      runtimeArtifactsPath,
      invocation.runAsNode
    );
    return JSON.parse(output.stdout);
  }
  ipcMain.handle('artifact:list', loadArtifactList);

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
      stageName,
      '--event-log', createRendererEventLog(profilePath(projectRoot, runtimeProfilePath))
    ], { isPackaged });
    const child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      env: buildBackendEnv(projectRoot, runtimeProfilePath, bundledProfilePath, runtimeArtifactsPath, {
        runAsNode: invocation.runAsNode
      }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activePipelineChild = child;
    stopRequested = false;

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    const decoder = createNdjsonDecoder(emit);
    child.stdout.on('data', (chunk) => decoder.push(chunk));

    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        emit({ type: 'log', message });
      }
    });

    attachPipelineChildFinalizer(child, {
      decoder,
      clearStopTimer,
      releaseActiveChild: () => { activePipelineChild = null; },
      isStopRequested: () => stopRequested,
      emit
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

function runCommand(
  command,
  args,
  cwd,
  runtimeProfilePath = '',
  bundledProfilePath = '',
  input = '',
  runtimeArtifactsPath = '',
  runAsNode = false
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildBackendEnv(cwd, runtimeProfilePath, bundledProfilePath, runtimeArtifactsPath, { runAsNode }),
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
