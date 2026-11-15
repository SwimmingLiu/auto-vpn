/**
 * `autovpn verge …` — install a static exit into Clash Verge Rev.
 *
 * The extension script Verge evaluates has no filesystem access, so the link
 * has to be a literal inside `profiles/<uid>.js`. This command owns the trip
 * from "here is a socks link" to "the chain is live in mihomo": parse, write
 * only the `STATIC_EXITS` literal, restart Verge, and prove from the core's own
 * API that the new nodes are loaded.
 *
 * The link is never accepted on the command line. It comes from a 0600 file, a
 * pipe, or a hidden prompt, and every line this command prints is masked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import {
  curlProxyUrl,
  describeExit,
  readExitText,
  type StaticExit,
} from '../verge/exit-uri.js';
import {
  EXTENSION_MARKER,
  findConfigProxy,
  findExtensionScripts,
  generateExitBlock,
  loadScript,
  probeInjection,
  proxyMatchesExit,
  replaceExitBlock,
  sameConfigProxy,
  vergeGeneratedConfig,
  type ConfigProxy,
  type Injection,
  type ScriptSettings,
} from '../verge/script.js';
import {
  findSocketPath,
  probeDelay,
  readProxies,
  selectProxy,
  waitForProxies,
  waitForSocket,
  type ProxyMap,
} from '../verge/runtime.js';
import { CliUsageError } from './errors.js';
import { readOptionValue } from './global-options.js';
import type { CliIo } from './output.js';

export const VERGE_SUBCOMMANDS = ['exit', 'status', 'test'] as const;
export type VergeSubcommand = (typeof VERGE_SUBCOMMANDS)[number];

export const EXIT_CODES = {
  ok: 0,
  usage: 2,
  environment: 3,
  unsafeSource: 4,
  probeFailed: 5,
  applyFailed: 6,
} as const;

const DEFAULT_SOURCE = path.join('.auto-vpn', 'verge-exit.txt');

/** Every option this family reads. Anything else is refused. */
const OPTION_FLAGS = new Set([
  '--from', '--stdin', '--script', '--check', '--test', '--no-apply', '--use',
  '--backup', '--wait', '--output', '--allow-insecure-source',
]);

const VALUE_FLAGS = new Set(['--from', '--script', '--wait', '--output']);

/** The part of `child_process.spawn` this family uses, and no more. */
export type SpawnLike = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

export interface VergeContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  io: CliIo;
  readStdin: () => string | Promise<string>;
  readSecret?: () => Promise<string>;
  spawn?: SpawnLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  home?: string;
  /** Overridable so the apply path is testable on runners that are not macOS. */
  platform?: NodeJS.Platform;
}

function flagValue(argv: string[], name: string): string | undefined {
  return readOptionValue(argv, name);
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function optionArgs(argv: string[]): string[] {
  return argv.slice(2);
}

export function validateVergeCommand(argv: string[]): void {
  const subcommand = argv[1] ?? '';
  if (!VERGE_SUBCOMMANDS.includes(subcommand as VergeSubcommand)) {
    throw new CliUsageError(`verge subcommand must be one of: ${VERGE_SUBCOMMANDS.join(', ')}`);
  }

  const args = optionArgs(argv);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('-')) {
      throw new CliUsageError(`verge ${subcommand} takes no positional arguments`);
    }
    const name = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
    if (!OPTION_FLAGS.has(name)) {
      throw new CliUsageError(`unknown option for verge ${subcommand}: ${name}`);
    }
    if (VALUE_FLAGS.has(name) && !value.includes('=')) {
      const next = args[index + 1];
      if (next === undefined) {
        throw new CliUsageError(`${name} requires a value`);
      }
      index += 1;
    }
  }

  const output = flagValue(argv, '--output');
  if (output !== undefined && !['human', 'json'].includes(output)) {
    throw new CliUsageError('verge --output must be one of: human, json');
  }

  if (subcommand === 'status' || subcommand === 'test') {
    for (const name of ['--from', '--stdin', '--check', '--no-apply', '--use', '--backup', '--wait', '--allow-insecure-source']) {
      if (hasFlag(argv, name) || argv.some((value) => value.startsWith(`${name}=`))) {
        throw new CliUsageError(`verge ${subcommand} does not take ${name}`);
      }
    }
  }

  if (subcommand === 'test' && hasFlag(argv, '--test')) {
    throw new CliUsageError('verge test is the probe; drop --test');
  }

  if (hasFlag(argv, '--stdin') && flagValue(argv, '--from') !== undefined) {
    throw new CliUsageError('verge exit takes --from or --stdin, not both');
  }

  const wait = flagValue(argv, '--wait');
  if (wait !== undefined) {
    if (!/^\d+$/.test(wait) || Number(wait) > 300) {
      throw new CliUsageError('--wait must be a whole number of seconds between 0 and 300');
    }
    if (hasFlag(argv, '--no-apply')) {
      throw new CliUsageError('--wait has nothing to wait for with --no-apply');
    }
  }
}

function humanOutput(argv: string[]): boolean {
  return flagValue(argv, '--output') !== 'json';
}

interface Report {
  ok: boolean;
  [key: string]: unknown;
}

function emit(context: VergeContext, argv: string[], payload: Report, lines: string[]): void {
  if (humanOutput(argv)) {
    context.io.writeStdout(`${lines.join('\n')}\n`);
  } else {
    context.io.writeStdout(`${JSON.stringify(payload)}\n`);
  }
}

/**
 * Read the link without letting it reach the terminal, argv, or a log.
 *
 * Order: `--from`, `--stdin`, the default file when the terminal is
 * interactive and the file exists, piped stdin, then a hidden prompt.
 */
async function readSource(context: VergeContext, argv: string[]): Promise<{ text: string; origin: string }> {
  const from = flagValue(argv, '--from');
  if (from !== undefined) {
    // A link pasted into --from would land in shell history and in `ps`.
    if (from.includes('://') || from.includes('@')) {
      throw new CliUsageError('--from takes a file path, not the link itself; put the link in a 0600 file or pipe it in');
    }
    return { text: readPrivateFile(from, hasFlag(argv, '--allow-insecure-source')), origin: from };
  }

  if (hasFlag(argv, '--stdin')) {
    return { text: String(await context.readStdin()), origin: 'stdin' };
  }

  const stdinIsTty = Boolean(process.stdin.isTTY);
  if (!stdinIsTty) {
    const text = String(await context.readStdin());
    if (text.trim()) return { text, origin: 'stdin' };
  }

  const home = context.home ?? os.homedir();
  const fallback = path.join(home, DEFAULT_SOURCE);
  if (stdinIsTty && fs.existsSync(fallback)) {
    return { text: readPrivateFile(fallback, hasFlag(argv, '--allow-insecure-source')), origin: fallback };
  }

  if (!stdinIsTty) {
    throw new CliUsageError('no link on stdin; pipe one in or use --from FILE');
  }
  const ask = context.readSecret
    ?? (() => readHiddenLine('paste the proxy link (input is hidden), then press Enter:\n', context.io));
  return { text: await ask(), origin: 'prompt' };
}

/**
 * A source file has to be one the operator alone can read: another account
 * with read access to the link can use the exit too.
 */
function readPrivateFile(file: string, allowInsecure: boolean): string {
  const resolved = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new CliUsageError(`no such file: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new CliUsageError(`not a regular file: ${resolved}`);
  }
  if (!allowInsecure && process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      const error = new CliUsageError(`source file ${resolved} is readable by others (mode ${mode.toString(8)}); run chmod 600 on it`);
      (error as CliUsageError & { code?: number }).code = EXIT_CODES.unsafeSource;
      throw error;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (stat.uid !== uid) {
      const error = new CliUsageError(`source file ${resolved} belongs to uid ${stat.uid}, not ${uid}`);
      (error as CliUsageError & { code?: number }).code = EXIT_CODES.unsafeSource;
      throw error;
    }
  }
  return fs.readFileSync(resolved, 'utf8');
}

function runCommand(spawn: SpawnLike, command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

/**
 * Restart Verge so it rebuilds the profile through the extension script.
 *
 * Verge only re-evaluates the script when a profile is (re)activated, and
 * restarting the app is the one activation the CLI can trigger without the UI.
 */
async function restartVerge(context: VergeContext): Promise<void> {
  const spawn = context.spawn ?? nodeSpawn;
  if ((context.platform ?? process.platform) !== 'darwin') {
    throw new Error('restarting Clash Verge is only implemented on macOS; write with --no-apply and reactivate the profile in the app');
  }
  context.io.writeStderr('restarting Clash Verge (connections drop for a few seconds)…\n');
  await runCommand(spawn, 'osascript', ['-e', 'quit app "Clash Verge"']);
  if (context.sleep) {
    await context.sleep(2_000);
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  }
  await runCommand(spawn, 'open', ['-a', 'Clash Verge']);
}

async function sleepFor(context: VergeContext, ms: number): Promise<void> {
  if (context.sleep) {
    await context.sleep(ms);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** `name`, `name 2`, … — the suffix the extension adds when the name is taken. */
function sameFamily(name: unknown, base: string): boolean {
  if (typeof name !== 'string') return false;
  if (name === base) return true;
  return name.startsWith(`${base} `) && /^\d+$/.test(name.slice(base.length + 1));
}

function readGeneratedProxy(file: string, name: string): ConfigProxy | null {
  try {
    return findConfigProxy(fs.readFileSync(file, 'utf8'), name);
  } catch {
    return null;
  }
}

async function readProxiesIfRunning(env: NodeJS.ProcessEnv): Promise<ProxyMap | null> {
  const socketPath = findSocketPath(env);
  if (!socketPath) return null;
  try {
    return await readProxies(socketPath);
  } catch {
    return null;
  }
}

/** The exit group and chain nodes the installed script will inject. */
function describeInjection(settings: ScriptSettings, injection: Injection, exits: StaticExit[]): {
  exitGroup: string;
  entranceGroup: string;
  chain: string[];
  direct: string[];
} {
  const groups = injection.groups.map((group) => String(group.name ?? ''));
  const exitGroup = groups[0] ?? settings.exitGroup;
  const entranceGroup = groups[1] ?? '';
  const direct = exits.map((exit) => exit.name);
  const chain = injection.proxies
    .map((proxy) => String(proxy.name ?? ''))
    .filter((name) => name !== '' && !direct.includes(name));
  return { exitGroup, entranceGroup, chain, direct };
}

function proxiedEnvironment(prefix: string, url: string): NodeJS.ProcessEnv {
  return { ...process.env, [`${prefix}_proxy`]: url, [`${prefix.toUpperCase()}_PROXY`]: url };
}

function probeExit(spawn: SpawnLike, exit: StaticExit): Promise<{ ok: boolean; address?: string }> {
  return new Promise((resolve) => {
    // The credential goes through the environment, not argv, so `ps` and the
    // shell history never see it.
    const child = spawn('curl', ['-sS', '--max-time', '20', 'https://api.ipify.org'], {
      env: { ...process.env, ALL_PROXY: curlProxyUrl(exit), all_proxy: curlProxyUrl(exit) },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => resolve({ ok: false }));
    child.on('exit', (code) => {
      const address = out.trim();
      resolve(code === 0 && address ? { ok: true, address } : { ok: false });
    });
  });
}

function writeScriptAtomically(file: string, text: string, backup: boolean): void {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}`);
  const descriptor = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (backup) {
    const copy = `${file}.bak`;
    if (!fs.existsSync(copy)) {
      fs.copyFileSync(file, copy);
      fs.chmodSync(copy, 0o600);
    }
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  // Rename is durable only after the directory entry is flushed.
  try {
    const dir = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    // A directory fsync is not supported everywhere; the rename already happened.
  }
}

function pickScript(context: VergeContext, argv: string[]): string {
  const explicit = flagValue(argv, '--script');
  if (explicit !== undefined) {
    const resolved = path.resolve(context.cwd, explicit);
    if (!fs.existsSync(resolved)) {
      throw new CliUsageError(`no such script: ${resolved}`);
    }
    return resolved;
  }
  const home = context.home ?? os.homedir();
  const candidates = findExtensionScripts(home, context.env);
  if (candidates.length === 0) {
    const error = new CliUsageError(
      'no Clash Verge extension script found. Open Verge → Profiles → the profile\'s ⋮ menu → Edit Script, paste docs/clash-verge-extension.js, save once, then run this again.',
    );
    (error as CliUsageError & { code?: number }).code = EXIT_CODES.environment;
    throw error;
  }
  const attached = candidates.filter((candidate) => candidate.attached);
  if (attached.length === 1) return attached[0].file;
  if (candidates.length === 1) return candidates[0].file;
  const error = new CliUsageError(
    `several extension scripts are installed and none is attached to the current profile; pick one with --script:\n${candidates.map((candidate) => `  ${candidate.file}`).join('\n')}`,
  );
  (error as CliUsageError & { code?: number }).code = EXIT_CODES.environment;
  throw error;
}

async function runExit(context: VergeContext, argv: string[]): Promise<number> {
  const source = await readSource(context, argv);
  const exits = readExitText(source.text);
  const checkOnly = hasFlag(argv, '--check');
  const script = pickScript(context, argv);
  const original = fs.readFileSync(script, 'utf8');
  if (!original.includes(EXTENSION_MARKER)) {
    throw new CliUsageError(`${script} does not look like the AutoVPN extension script`);
  }

  const block = generateExitBlock(exits);
  const next = replaceExitBlock(original, block);
  // Compile both the literal and the whole script: a syntax error has to stop
  // here, not surface as a silent no-op inside Verge.
  // eslint-disable-next-line no-new-func
  new Function(next);

  const lines = [`source: ${source.origin}`];
  for (const exit of exits) lines.push(`  ${exit.name}  ${describeExit(exit)}`);

  if (hasFlag(argv, '--test')) {
    const spawn = context.spawn ?? nodeSpawn;
    for (const exit of exits) {
      const probe = await probeExit(spawn, exit);
      if (!probe.ok) {
        lines.push(`  ${describeExit(exit)} unreachable`);
        emit(context, argv, { ok: false, reason: 'probe_failed', exits: exits.map(maskExit) }, lines);
        return EXIT_CODES.probeFailed;
      }
      lines.push(`  ${describeExit(exit)} reachable, egress ${probe.address}`);
    }
  }

  const loaded = loadScript(next);
  const injection = probeInjection(next);
  const injected = describeInjection(loaded.settings, injection, exits);
  lines.push(`script: ${script}`);
  lines.push(`exits: ${exits.length}, mode ${loaded.settings.mode || 'unknown'}`);

  if (checkOnly) {
    lines.push('--check: nothing was written');
    emit(context, argv, {
      ok: true,
      wrote: false,
      mode: loaded.settings.mode,
      exits: exits.map(maskExit),
      exit_group: injected.exitGroup,
      entrance_group: injected.entranceGroup,
      chain: injected.chain,
    }, lines);
    return EXIT_CODES.ok;
  }

  writeScriptAtomically(script, next, hasFlag(argv, '--backup'));
  lines.push('written');

  if (hasFlag(argv, '--no-apply')) {
    lines.push('not applied: reactivate the profile in Clash Verge, or rerun without --no-apply');
    emit(context, argv, {
      ok: true,
      wrote: true,
      applied: false,
      script,
      mode: loaded.settings.mode,
      exits: exits.map(maskExit),
      exit_group: injected.exitGroup,
      entrance_group: injected.entranceGroup,
      chain: injected.chain,
    }, lines);
    return EXIT_CODES.ok;
  }

  const waitSeconds = Number(flagValue(argv, '--wait') ?? '25');
  const deadline = Date.now() + waitSeconds * 1_000;
  // Restarting Verge resets group selections to the profile's own defaults, so
  // a chain the operator had selected comes back as "whatever the subscription
  // said" — traffic quietly leaves through a plain airport node. Remember
  // which selectors pointed at the exit group and put them back below.
  const before = await readProxiesIfRunning(context.env);
  const home = context.home ?? os.homedir();
  const generatedPath = vergeGeneratedConfig(home, context.env);
  const nodeName = injected.chain[0] ?? injected.direct[0] ?? '';
  const generatedBefore = nodeName ? readGeneratedProxy(generatedPath, nodeName) : null;
  const wasSelectedIn = before
    ? Object.entries(before)
      .filter(([, record]) => sameFamily(record?.now, injected.exitGroup))
      .map(([group]) => group)
    : [];
  await restartVerge(context);

  // The quit removes the socket and the relaunched app recreates it: wait for
  // the file itself before asking the core anything, or a healthy restart is
  // reported as an empty core.
  const socketPath = await waitForSocket(context.env, { timeoutMs: waitSeconds * 1_000, sleep: context.sleep });
  const expected = [...injected.chain, ...(loaded.settings.mode === 'direct' ? injected.direct : [])];
  const live = socketPath
    ? await waitForProxies(socketPath, (proxies) => expected.every((name) => Object.hasOwn(proxies, name)), {
      timeoutMs: Math.max(1_000, deadline - Date.now()),
      sleep: context.sleep,
    })
    : null;

  if (!live) {
    lines.push(`not live after ${waitSeconds}s: the new nodes are not in mihomo yet`);
    lines.push(socketPath ? `socket: ${socketPath}` : 'socket: not found (is the Clash Verge service running?)');
    emit(context, argv, {
      ok: false,
      wrote: true,
      applied: false,
      reason: 'not_live',
      script,
      exit_group: injected.exitGroup,
      chain: injected.chain,
    }, lines);
    return EXIT_CODES.applyFailed;
  }

  lines.push(`live: ${injected.exitGroup} → ${injected.chain.join(', ')}`);
  if (injected.entranceGroup) {
    lines.push(`entrance: pick the hop in ${injected.entranceGroup}`);
  }

  // Verge applies the profile's own selection right after the core answers;
  // putting the exit group back before that lands gets overwritten a second
  // later. Read the selectors again once activation has settled.
  await sleepFor(context, 3_000);
  const settled = socketPath ? await readProxies(socketPath).catch(() => live) : live;

  // mihomo's API does not expose server, port or the credential, so a rotated
  // link under the same name looks live. The generated config does carry them:
  // if it still holds exactly what it held before the restart, Verge never
  // rebuilt the profile and the old link is still in use.
  const generatedAfter = nodeName ? readGeneratedProxy(generatedPath, nodeName) : null;
  const identity = !generatedAfter
    ? 'unverified'
    : proxyMatchesExit(generatedAfter, exits[0])
      ? 'verified'
      : sameConfigProxy(generatedAfter, generatedBefore)
        ? 'stale'
        : 'unverified';

  if (identity === 'stale' && generatedAfter) {
    lines.push(`not applied: ${generatedPath} still carries the previous ${nodeName} → ${generatedAfter.server}:${generatedAfter.port}`);
    lines.push('the profile was not rebuilt; reactivate it in Verge, or rerun with --no-apply after doing so');
    emit(context, argv, {
      ok: false,
      wrote: true,
      applied: false,
      reason: 'stale_generated_config',
      script,
      exit_group: injected.exitGroup,
      chain: injected.chain,
      identity,
    }, lines);
    return EXIT_CODES.applyFailed;
  }
  if (identity === 'verified') {
    lines.push(`verified: ${generatedPath} carries ${nodeName} → ${exits[0].server}:${exits[0].port}`);
  } else if (nodeName) {
    lines.push(`identity unverified: ${generatedPath} has no readable ${nodeName} entry`);
  }

  const selected: Record<string, string> = {};
  for (const target of wasSelectedIn) {
    if (!Object.hasOwn(settled, target) || sameFamily(settled[target]?.now, injected.exitGroup)) continue;
    await selectProxy(socketPath, target, injected.exitGroup);
    selected[target] = injected.exitGroup;
    lines.push(`restored ${injected.exitGroup} in ${target}`);
  }
  if (hasFlag(argv, '--use')) {
    const targets = loaded.settings.targets.length > 0 ? loaded.settings.targets : [];
    if (targets.length === 0) {
      lines.push('--use skipped: EXIT_GROUP_TARGETS is empty, so every selector is a target; pick one by hand');
    }
    for (const target of targets) {
      if (selected[target]) continue;
      if (!Object.hasOwn(settled, target)) {
        lines.push(`--use skipped: ${target} is not in the live config`);
        continue;
      }
      await selectProxy(socketPath, target, injected.exitGroup);
      selected[target] = injected.exitGroup;
      lines.push(`selected ${injected.exitGroup} in ${target}`);
    }
  }

  emit(context, argv, {
    ok: true,
    wrote: true,
    applied: true,
    script,
    mode: loaded.settings.mode,
    exits: exits.map(maskExit),
    exit_group: injected.exitGroup,
    entrance_group: injected.entranceGroup,
    chain: injected.chain,
    identity,
    selected,
  }, lines);
  return EXIT_CODES.ok;
}

function maskExit(exit: StaticExit): Record<string, unknown> {
  return {
    name: exit.name,
    type: exit.type,
    server: exit.server,
    port: exit.port,
    credential: exit.credential !== undefined || exit.username !== undefined ? 'set' : 'none',
  };
}

async function runStatus(context: VergeContext, argv: string[]): Promise<number> {
  const script = pickScript(context, argv);
  const source = fs.readFileSync(script, 'utf8');
  const loaded = loadScript(source);
  const injection = probeInjection(source);
  const injected = describeInjection(loaded.settings, injection, loaded.exits);
  const stat = fs.statSync(script);

  const socketPath = findSocketPath(context.env);
  const live = socketPath ? await readProxies(socketPath) : null;

  const lines = [`script: ${script} (mode ${(stat.mode & 0o777).toString(8)})`];
  lines.push(`mode: ${loaded.settings.mode || 'unknown'}`);
  lines.push(`exits: ${loaded.exits.length}`);
  for (const exit of loaded.exits) lines.push(`  ${exit.name}  ${describeExit(exit)}`);
  lines.push(`exit group: ${injected.exitGroup}${injected.entranceGroup ? `, entrance ${injected.entranceGroup}` : ''}`);
  lines.push(`chain: ${injected.chain.length > 0 ? injected.chain.join(', ') : '(none)'}`);

  let exitCode: number = EXIT_CODES.ok;
  const liveGroup = live?.[injected.exitGroup];
  if (!socketPath) {
    lines.push('runtime: mihomo socket not found (is the Clash Verge service running?)');
    exitCode = EXIT_CODES.applyFailed;
  } else {
    lines.push(`socket: ${socketPath}`);
    if (!liveGroup) {
      lines.push(`runtime: ${injected.exitGroup} is not loaded; the profile has not been rebuilt since the last write`);
      exitCode = EXIT_CODES.applyFailed;
    } else {
      const members = Array.isArray(liveGroup.all) ? liveGroup.all : [];
      lines.push(`runtime: ${injected.exitGroup} → ${members.join(', ') || '(empty)'}`);
      const target = loaded.settings.targets[0] ?? '';
      if (target && live) {
        const now = live[target]?.now;
        lines.push(`selected in ${target}: ${now ?? '(unknown)'}`);
      }
      if (hasFlag(argv, '--test') && members.length > 0) {
        try {
          const probe = await probeDelay(socketPath, members[0]);
          lines.push(`probe ${members[0]}: ${probe.delay} ms`);
        } catch (error) {
          lines.push(`probe ${members[0]}: failed (${error instanceof Error ? error.message : String(error)})`);
          exitCode = EXIT_CODES.probeFailed;
        }
      }
    }
  }

  emit(context, argv, {
    ok: exitCode === EXIT_CODES.ok,
    script,
    mode: loaded.settings.mode,
    exits: loaded.exits.map(maskExit),
    exit_group: injected.exitGroup,
    entrance_group: injected.entranceGroup,
    chain: injected.chain,
    live: Boolean(liveGroup),
  }, lines);
  return exitCode;
}

async function runTest(context: VergeContext, argv: string[]): Promise<number> {
  const script = pickScript(context, argv);
  const source = fs.readFileSync(script, 'utf8');
  const loaded = loadScript(source);
  const socketPath = findSocketPath(context.env);
  if (!socketPath) {
    context.io.writeStderr('autovpn: mihomo socket not found; start Clash Verge first\n');
    return EXIT_CODES.applyFailed;
  }
  const injection = probeInjection(source);
  const injected = describeInjection(loaded.settings, injection, loaded.exits);
  const lines: string[] = [];
  let exitCode: number = EXIT_CODES.ok;
  for (const name of injected.chain) {
    try {
      const probe = await probeDelay(socketPath, name);
      lines.push(`${name}: ${probe.delay} ms`);
    } catch (error) {
      lines.push(`${name}: failed (${error instanceof Error ? error.message : String(error)})`);
      exitCode = EXIT_CODES.probeFailed;
    }
  }
  if (injected.chain.length === 0) {
    lines.push('nothing to probe: the script injects no exit');
    exitCode = EXIT_CODES.environment;
  }
  emit(context, argv, { ok: exitCode === EXIT_CODES.ok, chain: injected.chain }, lines);
  return exitCode;
}

export async function runVergeCommand(argv: string[], context: VergeContext): Promise<number> {
  const subcommand = argv[1] as VergeSubcommand;
  try {
    if (subcommand === 'exit') return await runExit(context, argv);
    if (subcommand === 'status') return await runStatus(context, argv);
    if (subcommand === 'test') return await runTest(context, argv);
    throw new CliUsageError(`verge subcommand must be one of: ${VERGE_SUBCOMMANDS.join(', ')}`);
  } catch (error) {
    if (error instanceof CliUsageError) {
      context.io.writeStderr(`autovpn: ${error.message}\n`);
      return (error as CliUsageError & { code?: number }).code ?? EXIT_CODES.usage;
    }
    const message = error instanceof Error ? error.message : String(error);
    context.io.writeStderr(`autovpn: verge ${subcommand} failed: ${message}\n`);
    return EXIT_CODES.environment;
  }
}

/** Kept for callers that need to know a file is a plausible script. */
export function isExtensionScript(text: string): boolean {
  return text.includes(EXTENSION_MARKER) && text.includes('function main(config)');
}

/**
 * Read one line from the terminal with no echo.
 *
 * The link is typed or pasted straight into the terminal — not into a shell
 * command — so it never reaches argv, history, or the scrollback above the
 * cursor.
 */
export function readHiddenLine(prompt: string, io: CliIo): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new CliUsageError('no interactive terminal; pipe the link in or use --from FILE'));
  }
  io.writeStderr(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const wasRaw = Boolean(stdin.isRaw);
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const finish = () => {
      cleanup();
      io.writeStderr('\n');
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          finish();
          return;
        }
        if (character === '\u0003') {
          cleanup();
          io.writeStderr('\n');
          reject(new CliUsageError('cancelled'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}
