import fs from 'node:fs';
import path from 'node:path';

export function buildPythonCandidates(projectRoot) {
  return [
    path.join(projectRoot, '.venv', 'bin', 'python'),
    path.join(projectRoot, '.venv', 'bin', 'python3'),
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.14',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.14',
    'python3.12',
    'python3',
    'python'
  ];
}

export function resolveBackendPython(projectRoot) {
  const candidates = buildPythonCandidates(projectRoot);

  return candidates.filter((candidate, index) => {
    if (candidate.startsWith('/')) {
      return fs.existsSync(candidate);
    }
    return candidates.indexOf(candidate) === index;
  });
}

export function resolvePythonVendorPath(projectRoot) {
  return path.join(projectRoot, 'electron', 'runtime', 'python-vendor');
}

export function resolveNodeVendorPath(projectRoot) {
  return path.join(projectRoot, 'electron', 'runtime', 'node-vendor', 'node_modules');
}

export function resolvePlaywrightBrowsersPath(projectRoot) {
  return path.join(projectRoot, 'electron', 'runtime', 'playwright-browsers');
}

function findBundledHeadlessShell(browserRoot) {
  if (!fs.existsSync(browserRoot)) {
    return '';
  }
  const revisions = fs.readdirSync(browserRoot)
    .filter((entry) => entry.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse();
  for (const revision of revisions) {
    const revisionPath = path.join(browserRoot, revision);
    for (const platformDir of fs.readdirSync(revisionPath)) {
      if (!platformDir.startsWith('chrome-headless-shell-')) {
        continue;
      }
      const executable = path.join(revisionPath, platformDir, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
      if (fs.existsSync(executable)) {
        return executable;
      }
    }
  }
  return '';
}

export function resolveBundledChromiumPath(projectRoot) {
  const browserRoot = resolvePlaywrightBrowsersPath(projectRoot);
  const headlessShell = findBundledHeadlessShell(browserRoot);
  if (headlessShell) {
    return headlessShell;
  }

  return path.join(
    browserRoot,
    'chromium-1217',
    'chrome-mac-arm64',
    'Google Chrome for Testing.app',
    'Contents',
    'MacOS',
    'Google Chrome for Testing'
  );
}

export function buildBackendEnv(
  projectRoot,
  runtimeProfilePath = '',
  bundledProfilePath = '',
  runtimeArtifactsPath = '',
  options = {}
) {
  const pythonPaths = [path.join(projectRoot, 'src')];
  const vendorPath = resolvePythonVendorPath(projectRoot);
  if (fs.existsSync(vendorPath)) {
    pythonPaths.push(vendorPath);
  }
  const nodeVendorPath = resolveNodeVendorPath(projectRoot);
  const playwrightBrowsersPath = resolvePlaywrightBrowsersPath(projectRoot);
  const bundledChromiumPath = resolveBundledChromiumPath(projectRoot);

  const env = {
    ...process.env,
    PYTHONPATH: pythonPaths.join(path.delimiter),
    VPN_AUTOMATION_PROFILE_PATH: runtimeProfilePath,
    VPN_AUTOMATION_BUNDLED_PROFILE_PATH: bundledProfilePath,
    VPN_AUTOMATION_ARTIFACTS_ROOT: runtimeArtifactsPath,
    VPN_AUTOMATION_NODE_MODULE_DIR: fs.existsSync(nodeVendorPath) ? nodeVendorPath : '',
    PLAYWRIGHT_BROWSERS_PATH: fs.existsSync(playwrightBrowsersPath) ? playwrightBrowsersPath : '',
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: fs.existsSync(bundledChromiumPath) ? bundledChromiumPath : ''
  };

  if (options.runAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  return env;
}

export function resolveNodeCliEntry(projectRoot) {
  return path.join(projectRoot, 'npm', 'autovpn-cli', 'bin', 'autovpn.mjs');
}

const BACKEND_COMMANDS = new Map([
  ['profile', ['profile', 'show']],
  ['profile-save', ['profile', 'save']],
  ['artifact-latest', ['artifacts', 'latest']],
  ['artifact-list', ['artifacts', 'list']],
  ['run', ['run']],
  ['retry-stage', ['retry-stage']]
]);

export function buildBackendInvocation(projectRoot, command, extraArgs = [], options = {}) {
  const mappedCommand = BACKEND_COMMANDS.get(command);
  if (!mappedCommand) {
    throw new Error(`Unsupported Electron backend command: ${command}`);
  }
  const isPackaged = Boolean(options.isPackaged);
  const nodeExecutable = options.nodeExecutable || process.env.npm_node_execpath || process.execPath;
  const electronExecutable = options.electronExecutable || process.execPath;
  const args = [
    resolveNodeCliEntry(projectRoot),
    ...mappedCommand,
    '--project-root',
    projectRoot,
    ...extraArgs
  ];
  if (command === 'run' || command === 'retry-stage') {
    args.push('--output', 'jsonl');
  }

  return {
    command: isPackaged ? electronExecutable : nodeExecutable,
    args,
    runAsNode: isPackaged
  };
}

export function parseBackendEventLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      type: 'log',
      message: trimmed
    };
  }
}

export function createNdjsonDecoder(onEvent) {
  let buffered = '';

  function decodeLine(line) {
    const event = parseBackendEventLine(line);
    if (event) {
      onEvent(event);
    }
  }

  return {
    push(chunk) {
      buffered += String(chunk ?? '');
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        decodeLine(line);
      }
    },
    flush() {
      if (buffered) {
        decodeLine(buffered);
        buffered = '';
      }
    }
  };
}
