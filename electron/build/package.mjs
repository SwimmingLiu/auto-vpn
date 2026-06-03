import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_PYTHON_DEPENDENCIES = [
  'cryptography>=45.0.0',
  'python-dotenv>=1.0.1',
  'requests>=2.32.0',
  'tomlkit>=0.13.2'
];
const RUNTIME_NODE_DEPENDENCIES = [
  'playwright@1.59.1'
];

export function resolveRepoAnchor(projectRoot) {
  const normalized = path.resolve(projectRoot);
  const marker = `${path.sep}.worktrees${path.sep}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) {
    return normalized;
  }
  return normalized.slice(0, markerIndex);
}

export function resolveLiveProfilePath(projectRoot) {
  return path.join(resolveRepoAnchor(projectRoot), 'state', 'profile.toml');
}

export function resolveRuntimePaths(projectRoot) {
  const runtimeDir = path.join(projectRoot, 'electron', 'runtime');
  return {
    runtimeDir,
    defaultSeedPath: path.join(runtimeDir, 'default-profile.toml'),
    bundledSeedPath: path.join(runtimeDir, 'bundled-profile.toml'),
    liveProfilePath: resolveLiveProfilePath(projectRoot)
  };
}

export function sanitizeBundledProfileToml(payload) {
  const normalizedPayload = payload.replaceAll('VPN Subscription Automation', 'AutoVPN');
  const availabilityBlock = `[availability_targets]
[availability_targets.gemini]
url = "https://gemini.google.com"
enabled = true

[availability_targets.chatgpt_ios]
url = "https://ios.chat.openai.com/"
enabled = true

[availability_targets.chatgpt_web]
url = "https://api.openai.com/compliance/cookie_requirements"
enabled = true

[availability_targets.claude]
url = "https://claude.ai/cdn-cgi/trace"
enabled = true`;
  const availabilityStart = normalizedPayload.indexOf('[availability_targets]');
  if (availabilityStart === -1) {
    return `${normalizedPayload.trimEnd()}\n\n${availabilityBlock}\n`;
  }

  const afterAvailability = normalizedPayload.slice(availabilityStart + '[availability_targets]'.length);
  const nextTopLevelMatch = afterAvailability.match(/\n\[[^\].\n]+]/);
  if (nextTopLevelMatch?.index === undefined) {
    return `${normalizedPayload.slice(0, availabilityStart).trimEnd()}\n\n${availabilityBlock}\n`;
  }

  const availabilityEnd = availabilityStart + '[availability_targets]'.length + nextTopLevelMatch.index;
  return `${normalizedPayload.slice(0, availabilityStart).trimEnd()}\n\n${availabilityBlock}\n\n${normalizedPayload.slice(availabilityEnd).trimStart()}`;
}

function stageBundledProfile(sourcePath, bundledSeedPath) {
  const payload = fs.readFileSync(sourcePath, 'utf8');
  fs.writeFileSync(bundledSeedPath, sanitizeBundledProfileToml(payload), 'utf8');
}

export function resolveShareWorkerPaths(projectRoot) {
  const repoAnchor = resolveRepoAnchor(projectRoot);
  const workspaceRoot = path.dirname(repoAnchor);
  const sourceCandidates = [
    path.join(projectRoot, 'templates', 'share-worker', 'vpn.js'),
    path.join(workspaceRoot, 'cloudflarevpn', 'edgetunnel', 'vpn.js')
  ];
  const runtimeDir = path.join(projectRoot, 'electron', 'runtime', 'share-worker');
  return {
    sourcePath: sourceCandidates[0],
    sourceCandidates,
    runtimeDir,
    runtimePath: path.join(runtimeDir, 'vpn.js')
  };
}

export function resolvePythonVendorRuntimePaths(projectRoot) {
  return {
    vendorDir: path.join(projectRoot, 'electron', 'runtime', 'python-vendor')
  };
}

export function resolveNodeVendorRuntimePaths(projectRoot) {
  return {
    vendorDir: path.join(projectRoot, 'electron', 'runtime', 'node-vendor')
  };
}

export function resolvePlaywrightBrowserRuntimePaths(projectRoot) {
  return {
    browserDir: path.join(projectRoot, 'electron', 'runtime', 'playwright-browsers')
  };
}

export function resolveIconPaths(projectRoot) {
  const outputDir = path.join(projectRoot, 'electron', 'build', 'assets');
  return {
    sourceSvg: path.join(projectRoot, 'electron', 'renderer', 'assets', 'vpn-auto-logo-v2-minimal.svg'),
    outputDir,
    outputIcns: path.join(outputDir, 'app-icon.icns'),
    iconsetDir: path.join(outputDir, 'app-icon.iconset')
  };
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function ensureCleanDir(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
}

function canRunCommand(command) {
  const result = spawnSync(command, ['-c', 'pass'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function selectRunnablePythonCandidate(candidates, canRun = canRunCommand) {
  for (const candidate of candidates) {
    if (candidate.startsWith('/') && !fs.existsSync(candidate)) {
      continue;
    }
    if (!candidate.startsWith('/') && !canRun(candidate)) {
      continue;
    }
    return candidate;
  }
  throw new Error(`No Python runtime found in candidates: ${candidates.join(', ')}`);
}

function selectPythonForVendorInstall(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.venv', 'bin', 'python'),
    path.join(projectRoot, '.venv', 'bin', 'python3'),
    '/opt/homebrew/bin/python3.14',
    '/opt/homebrew/bin/python3.12',
    '/usr/local/bin/python3.14',
    '/usr/local/bin/python3.12',
    'python3.12',
    'python3'
  ];

  return selectRunnablePythonCandidate(candidates);
}

export function buildPythonVendorInstallArgs(vendorDir) {
  return [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--target',
    vendorDir,
    ...RUNTIME_PYTHON_DEPENDENCIES
  ];
}

export function buildNodeVendorInstallArgs(vendorDir) {
  return [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--prefix',
    vendorDir,
    ...RUNTIME_NODE_DEPENDENCIES
  ];
}

export function buildPlaywrightBrowserInstallArgs() {
  return [
    'playwright',
    'install',
    'chromium-headless-shell'
  ];
}

export function buildSvgIconRenderHtml(svgMarkup, size = 1024) {
  const encodedSvg = Buffer.from(svgMarkup, 'utf8').toString('base64');
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html,
      body {
        margin: 0;
        width: ${size}px;
        height: ${size}px;
        overflow: hidden;
        background: transparent;
      }

      img {
        display: block;
        width: ${size}px;
        height: ${size}px;
      }
    </style>
  </head>
  <body>
    <img alt="" src="data:image/svg+xml;base64,${encodedSvg}">
  </body>
</html>`;
}

function renderSvgToPng(projectRoot, sourceSvg, outputPng, size = 1024) {
  const renderScript = `
    import fs from 'node:fs';
    import { chromium } from 'playwright';
    import { buildSvgIconRenderHtml } from ${JSON.stringify(pathToFileURL(__filename).href)};

    const sourceSvg = ${JSON.stringify(sourceSvg)};
    const outputPng = ${JSON.stringify(outputPng)};
    const size = ${JSON.stringify(size)};
    const svgMarkup = fs.readFileSync(sourceSvg, 'utf8');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1
      });
      await page.setContent(buildSvgIconRenderHtml(svgMarkup, size), { waitUntil: 'load' });
      await page.locator('img').evaluate(async (img) => {
        if (img.decode) {
          await img.decode();
        }
      });
      await page.screenshot({
        path: outputPng,
        omitBackground: true,
        animations: 'disabled'
      });
    } finally {
      await browser.close();
    }
  `;

  runOrThrow(
    process.execPath,
    ['--input-type=module', '--eval', renderScript],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: resolvePlaywrightBrowserRuntimePaths(projectRoot).browserDir
      }
    }
  );
}

function buildIconset(basePng, iconsetDir) {
  const iconSpecs = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];

  for (const [filename, size] of iconSpecs) {
    runOrThrow('sips', ['-z', String(size), String(size), basePng, '--out', path.join(iconsetDir, filename)]);
  }
}

export function prepareMacIcon(projectRoot) {
  const { sourceSvg, outputDir, outputIcns, iconsetDir } = resolveIconPaths(projectRoot);
  fs.mkdirSync(outputDir, { recursive: true });
  ensureCleanDir(iconsetDir);

  const basePng = path.join(outputDir, 'app-icon-1024.png');
  renderSvgToPng(projectRoot, sourceSvg, basePng);
  buildIconset(basePng, iconsetDir);
  runOrThrow('iconutil', ['-c', 'icns', iconsetDir, '-o', outputIcns]);

  return { outputIcns, iconsetDir, basePng };
}

export function stageShareWorkerRuntime(projectRoot) {
  const { sourceCandidates, runtimeDir, runtimePath } = resolveShareWorkerPaths(projectRoot);
  const sourcePath = sourceCandidates.find((candidate) => fs.existsSync(candidate));
  if (!sourcePath) {
    throw new Error(`share worker source not found; tried: ${sourceCandidates.join(', ')}`);
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(sourcePath, runtimePath);
  return runtimePath;
}

export function stagePythonVendorRuntime(projectRoot) {
  const { vendorDir } = resolvePythonVendorRuntimePaths(projectRoot);
  ensureCleanDir(vendorDir);
  runOrThrow(
    selectPythonForVendorInstall(projectRoot),
    buildPythonVendorInstallArgs(vendorDir),
    { cwd: projectRoot }
  );
  return vendorDir;
}

export function stageNodeVendorRuntime(projectRoot) {
  const { vendorDir } = resolveNodeVendorRuntimePaths(projectRoot);
  ensureCleanDir(vendorDir);
  runOrThrow('npm', buildNodeVendorInstallArgs(vendorDir), { cwd: projectRoot });
  return vendorDir;
}

export function stagePlaywrightBrowserRuntime(projectRoot) {
  const { browserDir } = resolvePlaywrightBrowserRuntimePaths(projectRoot);
  ensureCleanDir(browserDir);
  runOrThrow('npx', buildPlaywrightBrowserInstallArgs(), {
    cwd: projectRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browserDir
    }
  });
  return browserDir;
}

export function buildElectronBuilderArgs(targets = ['dmg']) {
  const normalizedTargets = Array.isArray(targets)
    ? targets
    : String(targets).split(',');
  const buildTargets = normalizedTargets.map((target) => String(target).trim()).filter(Boolean);
  return ['electron-builder', '--mac', ...buildTargets];
}

export function cleanElectronOutputDir(projectRoot) {
  fs.rmSync(path.join(projectRoot, 'dist-electron'), { recursive: true, force: true });
}

export function runPackaging(projectRoot) {
  const { runtimeDir, defaultSeedPath, bundledSeedPath, liveProfilePath } = resolveRuntimePaths(projectRoot);
  cleanElectronOutputDir(projectRoot);
  fs.mkdirSync(runtimeDir, { recursive: true });

  if (fs.existsSync(liveProfilePath)) {
    stageBundledProfile(liveProfilePath, bundledSeedPath);
  } else if (fs.existsSync(defaultSeedPath)) {
    stageBundledProfile(defaultSeedPath, bundledSeedPath);
  }

  stageShareWorkerRuntime(projectRoot);
  stagePythonVendorRuntime(projectRoot);
  stageNodeVendorRuntime(projectRoot);
  stagePlaywrightBrowserRuntime(projectRoot);
  prepareMacIcon(projectRoot);

  return spawnSync('npx', buildElectronBuilderArgs(), {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
}

if (process.argv[1] === __filename) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const result = runPackaging(projectRoot);
  process.exit(result.status ?? 1);
}
