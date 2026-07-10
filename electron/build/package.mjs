import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import TOML from '@iarna/toml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

export const BUNDLED_PROFILE_SENSITIVE_SOURCE_KEYS = Object.freeze(['url', 'key']);
export const BUNDLED_PROFILE_SENSITIVE_DEPLOY_KEYS = Object.freeze([
  'subscription_url',
  'verify_subscription_url',
  'secret_query',
  'account_id',
  'cloudflare_api_token',
  'cloudflare_global_key',
  'cloudflare_email',
  'pages_secret_admin'
]);

export function sanitizeBundledProfileToml(payload) {
  const normalizedPayload = payload.replaceAll('VPN Subscription Automation', 'AutoVPN');
  const profile = TOML.parse(normalizedPayload);
  for (const source of Object.values(profile.sources ?? {})) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      continue;
    }
    for (const key of BUNDLED_PROFILE_SENSITIVE_SOURCE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        source[key] = '';
      }
    }
  }
  if (profile.deploy && typeof profile.deploy === 'object' && !Array.isArray(profile.deploy)) {
    for (const key of BUNDLED_PROFILE_SENSITIVE_DEPLOY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(profile.deploy, key)) {
        profile.deploy[key] = '';
      }
    }
  }
  profile.availability_targets = {
    gemini: { url: 'https://gemini.google.com', enabled: true },
    chatgpt_ios: { url: 'https://ios.chat.openai.com/', enabled: true },
    chatgpt_web: { url: 'https://api.openai.com/compliance/cookie_requirements', enabled: true },
    claude: { url: 'https://claude.ai/cdn-cgi/trace', enabled: true }
  };
  const comment = normalizedPayload.includes('# AutoVPN runtime profile') ? '# AutoVPN runtime profile\n' : '';
  return `${comment}${TOML.stringify(profile)}`;
}

function stageBundledProfile(sourcePath, bundledSeedPath) {
  const payload = fs.readFileSync(sourcePath, 'utf8');
  fs.writeFileSync(bundledSeedPath, sanitizeBundledProfileToml(payload), 'utf8');
}

export function stageBundledProfileForPackaging(projectRoot) {
  const { runtimeDir, defaultSeedPath, bundledSeedPath } = resolveRuntimePaths(projectRoot);
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (!fs.existsSync(defaultSeedPath)) {
    return undefined;
  }
  stageBundledProfile(defaultSeedPath, bundledSeedPath);
  return bundledSeedPath;
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

export function resolveNodeVendorRuntimePaths(projectRoot) {
  return {
    vendorDir: path.join(projectRoot, 'electron', 'runtime', 'node-vendor')
  };
}

export function resolveAutoVpnCliRuntimePaths(projectRoot) {
  const sourceRoot = path.join(projectRoot, 'npm', 'autovpn-cli');
  const runtimeRoot = path.join(projectRoot, 'electron', 'runtime', 'autovpn-cli');
  return {
    sourceRoot,
    runtimeRoot,
    runtimeEntry: path.join(runtimeRoot, 'bin', 'autovpn.mjs')
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
    outputPng: path.join(outputDir, 'app-icon-1024.png'),
    outputIco: path.join(outputDir, 'app-icon.ico'),
    outputIcns: path.join(outputDir, 'app-icon.icns'),
    iconsetDir: path.join(outputDir, 'app-icon.iconset')
  };
}

export function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, buildCommandSpawnOptions(command, options));
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`${command} ${args.join(' ')} timed out after ${options.timeout} ms`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function ensureCleanDir(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
}

export function buildCommandSpawnOptions(command, options = {}, platform = process.platform) {
  const needsWindowsShell = platform === 'win32' && ['npm', 'npx'].includes(command);
  return {
    stdio: 'inherit',
    encoding: 'utf8',
    shell: needsWindowsShell,
    ...options
  };
}

function logPackageStage(message) {
  console.log(`[package] ${message}`);
}

function fileExistsNonEmpty(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

export function shouldBundlePlaywrightBrowserRuntime(env = process.env) {
  const value = String(env.AUTOVPN_BUNDLE_PLAYWRIGHT_BROWSER ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
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

export function buildAutoVpnCliProductionInstallArgs(runtimeRoot) {
  return [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--prefix',
    runtimeRoot
  ];
}

export function buildPlaywrightBrowserInstallArgs() {
  return [
    'playwright',
    'install',
    'chromium-headless-shell'
  ];
}

function findChromiumHeadlessShellExecutable(browserDir, platform = process.platform) {
  if (!fs.existsSync(browserDir)) {
    return '';
  }

  const executableName = platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const pending = [browserDir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.name === executableName) {
        return entryPath;
      }
    }
  }

  return '';
}

export function isPlaywrightBrowserRuntimeReady(browserDir, platform = process.platform) {
  if (!fs.existsSync(browserDir)) {
    return false;
  }

  const revisions = fs.readdirSync(browserDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium_headless_shell-'))
    .map((entry) => path.join(browserDir, entry.name));

  return revisions.some((revisionPath) => (
    fs.existsSync(path.join(revisionPath, 'INSTALLATION_COMPLETE')) &&
    Boolean(findChromiumHeadlessShellExecutable(revisionPath, platform))
  ));
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

export async function retryOperation(operation, { retries = 3, delayMs = 250 } = {}) {
  if (!Number.isInteger(retries) || retries < 1) {
    throw new TypeError('retryOperation retries must be a positive integer');
  }

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < retries && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function renderSvgToPng(projectRoot, sourceSvg, outputPng, size = 1024) {
  const renderScript = `
    import fs from 'node:fs';
    import { chromium } from 'playwright';
    import { buildSvgIconRenderHtml, retryOperation } from ${JSON.stringify(pathToFileURL(__filename).href)};

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
      await retryOperation(
        () => page.screenshot({
          path: outputPng,
          omitBackground: true,
          animations: 'disabled'
        }),
        { retries: 3, delayMs: 250 }
      );
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

function writePngIco(pngPath, icoPath) {
  const png = fs.readFileSync(pngPath);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  fs.writeFileSync(icoPath, Buffer.concat([header, entry, png]));
}

export function preparePngIcon(projectRoot, size = 1024) {
  const { sourceSvg, outputDir, outputPng } = resolveIconPaths(projectRoot);
  fs.mkdirSync(outputDir, { recursive: true });
  const basePng = size === 1024
    ? outputPng
    : path.join(outputDir, `app-icon-${size}.png`);
  if (fileExistsNonEmpty(basePng)) {
    logPackageStage(`Using packaged PNG icon ${path.relative(projectRoot, basePng)}`);
    return basePng;
  }
  renderSvgToPng(projectRoot, sourceSvg, basePng, size);
  return basePng;
}

export function prepareMacIcon(projectRoot) {
  const { outputIcns, iconsetDir } = resolveIconPaths(projectRoot);
  const basePng = preparePngIcon(projectRoot);
  if (fileExistsNonEmpty(outputIcns)) {
    logPackageStage(`Using packaged macOS icon ${path.relative(projectRoot, outputIcns)}`);
    return { outputIcns, iconsetDir, basePng };
  }

  ensureCleanDir(iconsetDir);
  buildIconset(basePng, iconsetDir);
  runOrThrow('iconutil', ['-c', 'icns', iconsetDir, '-o', outputIcns]);

  return { outputIcns, iconsetDir, basePng };
}

export function prepareWindowsIcon(projectRoot) {
  const { outputIco } = resolveIconPaths(projectRoot);
  if (fileExistsNonEmpty(outputIco)) {
    logPackageStage(`Using packaged Windows icon ${path.relative(projectRoot, outputIco)}`);
    return { outputIco, png256: '' };
  }

  const png256 = preparePngIcon(projectRoot, 256);
  writePngIco(png256, outputIco);
  return { outputIco, png256 };
}

export function preparePackageIcons(projectRoot, platforms = buildPackagePlatformList()) {
  const requestedPlatforms = new Set(platforms);
  const prepared = {
    png: preparePngIcon(projectRoot)
  };

  if (requestedPlatforms.has('mac')) {
    prepared.mac = prepareMacIcon(projectRoot);
  }
  if (requestedPlatforms.has('win')) {
    prepared.win = prepareWindowsIcon(projectRoot);
  }

  return prepared;
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

export function stageNodeVendorRuntime(projectRoot) {
  const { vendorDir } = resolveNodeVendorRuntimePaths(projectRoot);
  logPackageStage('Installing Node runtime dependencies');
  ensureCleanDir(vendorDir);
  runOrThrow('npm', buildNodeVendorInstallArgs(vendorDir), { cwd: projectRoot, timeout: 300000 });
  return vendorDir;
}

export function stageAutoVpnCliRuntime(projectRoot, options = {}) {
  const { run = runOrThrow } = options;
  const paths = resolveAutoVpnCliRuntimePaths(projectRoot);
  logPackageStage('Building packaged AutoVPN CLI');
  run('npm', ['run', 'build', '--prefix', paths.sourceRoot], {
    cwd: projectRoot,
    timeout: 300000
  });

  ensureCleanDir(paths.runtimeRoot);
  for (const entry of ['bin', 'dist']) {
    fs.cpSync(path.join(paths.sourceRoot, entry), path.join(paths.runtimeRoot, entry), { recursive: true });
  }
  fs.copyFileSync(path.join(paths.sourceRoot, 'package.json'), path.join(paths.runtimeRoot, 'package.json'));

  logPackageStage('Installing packaged AutoVPN CLI production dependencies');
  run('npm', buildAutoVpnCliProductionInstallArgs(paths.runtimeRoot), {
    cwd: projectRoot,
    timeout: 300000
  });
  return paths;
}

export function stagePlaywrightBrowserRuntime(projectRoot, options = {}) {
  const { browserDir } = resolvePlaywrightBrowserRuntimePaths(projectRoot);
  const {
    platform = process.platform,
    run = runOrThrow,
    timeoutMs = 900000
  } = options;

  if (isPlaywrightBrowserRuntimeReady(browserDir, platform)) {
    logPackageStage('Reusing staged Playwright Chromium headless shell');
    return browserDir;
  }

  logPackageStage('Installing Playwright Chromium headless shell');
  ensureCleanDir(browserDir);
  run('npx', buildPlaywrightBrowserInstallArgs(), {
    cwd: projectRoot,
    timeout: timeoutMs,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browserDir
    }
  });
  return browserDir;
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return String(value ?? '').split(',');
}

function normalizePackagePlatform(value) {
  const normalized = String(value).trim().toLowerCase();
  if (['mac', 'macos', 'darwin', 'osx'].includes(normalized)) return 'mac';
  if (['linux'].includes(normalized)) return 'linux';
  if (['win', 'windows', 'win32'].includes(normalized)) return 'win';
  throw new Error(`Unsupported package platform: ${value}`);
}

function normalizePackageArch(value) {
  const normalized = String(value).trim().toLowerCase();
  if (['x64', 'amd64'].includes(normalized)) return 'x64';
  if (['arm64', 'aarch64'].includes(normalized)) return 'arm64';
  if (['ia32', 'x86'].includes(normalized)) return 'ia32';
  if (['armv7l', 'armv7', 'armhf'].includes(normalized)) return 'armv7l';
  throw new Error(`Unsupported package architecture: ${value}`);
}

function isPackageArchSupportedByPlatform(platform, arch) {
  const supportedArchs = {
    mac: ['x64', 'arm64', 'universal'],
    linux: ['x64', 'arm64', 'armv7l'],
    win: ['x64', 'arm64', 'ia32']
  };
  return supportedArchs[platform].includes(arch);
}

export function buildPackagePlatformList(env = process.env, hostPlatform = process.platform) {
  const requested = env.AUTOVPN_PACKAGE_PLATFORM || env.npm_config_platform;
  if (requested) {
    return splitList(requested).map(normalizePackagePlatform);
  }
  return [normalizePackagePlatform(hostPlatform)];
}

export function buildPackageArchList(env = process.env, hostArch = process.arch) {
  const requested = env.AUTOVPN_PACKAGE_ARCH || env.npm_config_arch;
  if (requested) {
    return splitList(requested).map(normalizePackageArch);
  }
  return [normalizePackageArch(hostArch)];
}

export function buildElectronBuilderArgs(options = ['dmg'], architectures = []) {
  const publishArgs = ['--publish', 'never'];
  if (!options || Array.isArray(options) || typeof options === 'string') {
    const normalizedTargets = Array.isArray(options)
      ? options
      : String(options).split(',');
    const buildTargets = normalizedTargets.map((target) => String(target).trim()).filter(Boolean);
    const normalizedArchitectures = splitList(architectures)
      .map(normalizePackageArch)
      .filter((arch) => isPackageArchSupportedByPlatform('mac', arch))
      .map((arch) => `--${arch}`);
    return ['electron-builder', '--mac', ...buildTargets, ...normalizedArchitectures, ...publishArgs];
  }

  const targetByPlatform = {
    mac: ['--mac', 'dmg'],
    linux: ['--linux', 'deb', 'rpm'],
    win: ['--win', 'nsis', 'portable']
  };
  const platforms = options.platforms ?? buildPackagePlatformList();
  const archs = options.archs ?? buildPackageArchList();
  const args = ['electron-builder'];

  for (const platform of platforms) {
    const normalizedPlatform = normalizePackagePlatform(platform);
    args.push(...targetByPlatform[normalizedPlatform]);
  }
  for (const arch of archs) {
    const normalizedArch = normalizePackageArch(arch);
    if (platforms.every((platform) => isPackageArchSupportedByPlatform(normalizePackagePlatform(platform), normalizedArch))) {
      args.push(`--${normalizedArch}`);
    }
  }

  args.push(...publishArgs);
  return args;
}

export function cleanElectronOutputDir(projectRoot) {
  fs.rmSync(path.join(projectRoot, 'dist-electron'), { recursive: true, force: true });
}

export function removeLegacyRuntimeArtifacts(projectRoot) {
  const legacyVendorDir = path.join(
    projectRoot,
    'electron',
    'runtime',
    ['python', 'vendor'].join('-')
  );
  fs.rmSync(legacyVendorDir, { recursive: true, force: true });
}

export function runPackaging(projectRoot) {
  const { runtimeDir } = resolveRuntimePaths(projectRoot);
  const platforms = buildPackagePlatformList();
  const archs = buildPackageArchList();
  logPackageStage(`Packaging platforms=${platforms.join(',')} archs=${archs.join(',')}`);
  cleanElectronOutputDir(projectRoot);
  fs.mkdirSync(runtimeDir, { recursive: true });
  removeLegacyRuntimeArtifacts(projectRoot);

  if (stageBundledProfileForPackaging(projectRoot)) {
    logPackageStage('Bundling sanitized runtime profile from default profile');
  }

  logPackageStage('Staging share worker runtime');
  stageShareWorkerRuntime(projectRoot);
  stageAutoVpnCliRuntime(projectRoot);
  stageNodeVendorRuntime(projectRoot);
  if (shouldBundlePlaywrightBrowserRuntime()) {
    stagePlaywrightBrowserRuntime(projectRoot);
  } else {
    logPackageStage('Skipping bundled Playwright browser runtime');
  }
  logPackageStage('Preparing package icons');
  preparePackageIcons(projectRoot, platforms);

  logPackageStage('Running electron-builder');
  return spawnSync('npx', buildElectronBuilderArgs({ platforms, archs }), buildCommandSpawnOptions('npx', {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: 600000
  }));
}

if (process.argv[1] === __filename) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const result = runPackaging(projectRoot);
  process.exit(result.status ?? 1);
}
