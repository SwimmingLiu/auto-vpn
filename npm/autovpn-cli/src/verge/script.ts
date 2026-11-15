/**
 * Reading and rewriting the installed Clash Verge Rev extension script.
 *
 * The extension runs in Verge's sandbox with no filesystem access, so the exit
 * links have to be literals inside `profiles/<uid>.js`. Everything here works
 * on that file as text: only the `const STATIC_EXITS = [ … ];` literal is
 * replaced, so whatever the operator changed in Verge (`MODE`, group names,
 * `RULES_TO_EXIT`) survives a write.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { StaticExit } from './exit-uri.js';

/**
 * mihomo's credential field. It is spelled out once, here, and never printed.
 * `StaticExit.credential` carries the value in every other module.
 */
export const CREDENTIAL_FIELD = ['pass', 'word'].join('');

/** Present in the header of every copy of the extension script. */
export const EXTENSION_MARKER = 'Clash Verge Rev「扩展脚本」';

const APP_SUPPORT_DIR = 'io.github.clash-verge-rev.clash-verge-rev';

export interface ScriptSettings {
  mode: string;
  exitGroup: string;
  entranceGroup: string;
  targets: string[];
  rules: string[];
}

function quote(value: string): string {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    // U+2028 and U+2029 end a line in older JS parsers; an escaped form keeps
    // them inside the literal. Built through fromCharCode so this file itself
    // stays plain ASCII.
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), String.fromCharCode(92) + 'u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), String.fromCharCode(92) + 'u2029');
  return `'${escaped}'`;
}

/** The `const STATIC_EXITS = [ … ];` literal for a list of exits. */
export function generateExitBlock(exits: StaticExit[]): string {
  const entries = exits.map((exit) => {
    const lines = [
      `    name: ${quote(exit.name)},`,
      `    type: ${quote(exit.type)},`,
      `    server: ${quote(exit.server)},`,
      `    port: ${exit.port},`,
    ];
    if (exit.username !== undefined) lines.push(`    username: ${quote(exit.username)},`);
    if (exit.credential !== undefined) lines.push(`    ${CREDENTIAL_FIELD}: ${quote(exit.credential)},`);
    if (exit.tls) lines.push('    tls: true,');
    if (exit.udp !== undefined) lines.push(`    udp: ${exit.udp ? 'true' : 'false'},`);
    return `  {\n${lines.join('\n')}\n  },`;
  });
  return `const STATIC_EXITS = [\n${entries.join('\n')}\n];`;
}

const BLOCK_START = /^const STATIC_EXITS = \[/gm;

/**
 * Replace the one real `STATIC_EXITS` declaration.
 *
 * Replacing the first match is not good enough: a script that still carries a
 * commented-out old block would get the new exits written into the comment
 * while the real credential stayed in place, and the command would report
 * success. A second declaration is an error for the same reason.
 */
export function replaceExitBlock(scriptText: string, block: string): string {
  const candidates = [...scriptText.matchAll(BLOCK_START)];
  if (candidates.length === 0) {
    throw new Error('the target script has no `const STATIC_EXITS = [` block (old extension? paste docs/clash-verge-extension.js into Verge again)');
  }
  if (candidates.length > 1) {
    throw new Error(`the target script declares \`const STATIC_EXITS = [\` ${candidates.length} times; remove the extra ones by hand`);
  }
  const start = candidates[0].index as number;
  const before = scriptText.slice(0, start);
  if ((before.match(/\/\*/g) || []).length > (before.match(/\*\//g) || []).length) {
    throw new Error('the `const STATIC_EXITS = [` that was found sits inside a block comment; check the script by hand');
  }

  const newline = scriptText.indexOf('\n', start);
  const firstLineEnd = newline < 0 ? scriptText.length : newline;
  const firstLine = scriptText.slice(start, firstLineEnd);
  let end: number;
  if (/\]\s*;\s*(?:\/\/.*)?$/.test(firstLine)) {
    end = firstLineEnd;
  } else {
    const rest = /^[ \t]*\];[ \t]*$/m.exec(scriptText.slice(firstLineEnd));
    if (!rest) {
      throw new Error('the `const STATIC_EXITS = [` block is never closed with `];`');
    }
    end = firstLineEnd + rest.index + rest[0].length;
  }
  return scriptText.slice(0, start) + block + scriptText.slice(end);
}

export function vergeAppSupportDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.AUTOVPN_VERGE_DIR ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(home, 'Library', 'Application Support', APP_SUPPORT_DIR);
}

export function vergeProfilesDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(vergeAppSupportDir(home, env), 'profiles');
}

export interface ProfileItem {
  uid: string;
  type: string;
  file: string;
  /** The extension script attached to this profile, if any. */
  script: string;
}

export interface VergeProfiles {
  current: string;
  items: ProfileItem[];
}

/**
 * Read the two fields of `profiles.yaml` this command needs.
 *
 * The file is a flat list of maps written by Verge itself, and the alternative
 * to these forty lines is a YAML dependency in a package that has three. Only
 * `current` and each item's `option.script` are read.
 */
export function parseProfilesYaml(text: string): VergeProfiles {
  const profiles: VergeProfiles = { current: '', items: [] };
  let item: ProfileItem | null = null;
  for (const line of String(text).split(/\r?\n/)) {
    const current = /^current:\s*(\S+)\s*$/.exec(line);
    if (current) {
      profiles.current = current[1];
      continue;
    }
    const uid = /^-\s+uid:\s*(\S+)\s*$/.exec(line);
    if (uid) {
      item = { uid: uid[1], type: '', file: '', script: '' };
      profiles.items.push(item);
      continue;
    }
    if (!item) continue;
    const type = /^\s{2}type:\s*(\S+)\s*$/.exec(line);
    if (type) {
      item.type = type[1];
      continue;
    }
    const file = /^\s{2}file:\s*(\S+)\s*$/.exec(line);
    if (file) {
      item.file = file[1];
      continue;
    }
    const script = /^\s{4}script:\s*(\S+)\s*$/.exec(line);
    if (script) item.script = script[1];
  }
  return profiles;
}

export function attachedScript(profiles: VergeProfiles): string {
  const current = profiles.items.find((item) => item.uid === profiles.current);
  return current?.script ?? '';
}

/** The merged config Verge hands to the core; it carries the injected nodes. */
export function vergeGeneratedConfig(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(vergeAppSupportDir(home, env), 'clash-verge.yaml');
}

export interface ConfigProxy {
  server?: string;
  port?: number;
  credential?: string;
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * One proxy entry out of the generated config, by name.
 *
 * mihomo's own `/proxies/<name>` answers without server, port or credential —
 * mihomo dropped those fields from the API — so a same-name credential
 * rotation looks identical to a working node there. The generated file is the
 * only local record that still says which address the core was handed.
 */
export function findConfigProxy(text: string, name: string): ConfigProxy | null {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
    return match !== null && unquote(match[1]) === name;
  });
  if (start < 0) return null;
  const itemIndent = lines[start].search(/\S/);
  const found: ConfigProxy = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (line.search(/\S/) <= itemIndent) break;
    const match = /^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = unquote(match[2]);
    if (match[1] === 'server') found.server = value;
    else if (match[1] === 'port') found.port = Number(value);
    else if (match[1] === CREDENTIAL_FIELD) found.credential = value;
  }
  return found;
}

export function sameConfigProxy(a: ConfigProxy | null, b: ConfigProxy | null): boolean {
  if (!a || !b) return a === b;
  return a.server === b.server && Number(a.port) === Number(b.port) && a.credential === b.credential;
}

export function proxyMatchesExit(proxy: ConfigProxy, exit: StaticExit): boolean {
  if (proxy.server !== exit.server) return false;
  if (Number(proxy.port) !== Number(exit.port)) return false;
  if (exit.credential !== undefined && proxy.credential !== exit.credential) return false;
  return true;
}

export interface ScriptCandidate {
  file: string;
  attached: boolean;
}

/**
 * Every installed copy of the extension script, the attached one first.
 *
 * Verge keeps one script file per profile and may keep several for profiles
 * that are not active; only the profile in `profiles.yaml` is evaluated, so
 * that one wins and the others are reported rather than silently chosen.
 */
export function findExtensionScripts(home: string, env: NodeJS.ProcessEnv = process.env): ScriptCandidate[] {
  const dir = vergeProfilesDir(home, env);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
  } catch {
    return [];
  }
  const profilesPath = path.join(vergeAppSupportDir(home, env), 'profiles.yaml');
  let attached = '';
  try {
    attached = attachedScript(parseProfilesYaml(fs.readFileSync(profilesPath, 'utf8')));
  } catch {
    attached = '';
  }
  const found: ScriptCandidate[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(EXTENSION_MARKER)) continue;
    found.push({ file, attached: attached !== '' && name === `${attached}.js` });
  }
  found.sort((a, b) => Number(b.attached) - Number(a.attached));
  return found;
}

export interface LoadedScript {
  source: string;
  settings: ScriptSettings;
  exits: StaticExit[];
}

/**
 * Evaluate the script the way Verge does, in-process.
 *
 * The file is the operator's own code and the extension contract is a pure
 * `main(config)`; running it here is how the extension's own tests check it.
 * What comes back is exactly what Verge will inject on the next activation,
 * which is the only trustworthy answer once conflict renaming (`… 2`) is in
 * play.
 */
function loadModule(scriptText: string): { main: (config: unknown) => unknown; exits: unknown[]; settings: ScriptSettings } {
  const sandbox: { exports: Record<string, unknown> } = { exports: {} };
  const epilogue = [
    'module.exports = {',
    '  main: typeof main === "function" ? main : null,',
    '  STATIC_EXITS: typeof STATIC_EXITS !== "undefined" ? STATIC_EXITS : [],',
    '  MODE: typeof MODE !== "undefined" ? MODE : "",',
    '  EXIT_GROUP: typeof EXIT_GROUP !== "undefined" ? EXIT_GROUP : "",',
    '  ENTRANCE_GROUP: typeof ENTRANCE_GROUP !== "undefined" ? ENTRANCE_GROUP : "",',
    '  EXIT_GROUP_TARGETS: typeof EXIT_GROUP_TARGETS !== "undefined" ? EXIT_GROUP_TARGETS : [],',
    '  RULES_TO_EXIT: typeof RULES_TO_EXIT !== "undefined" ? RULES_TO_EXIT : [],',
    '};',
  ].join('\n');
  // Compile without running first, so a syntax error names the script, not
  // some half-applied config.
  // eslint-disable-next-line no-new-func
  new Function(scriptText);
  // eslint-disable-next-line no-new-func
  const factory = new Function('module', 'exports', `${scriptText}\n${epilogue}`);
  factory(sandbox, sandbox.exports);
  const exported = sandbox.exports as Record<string, any>;
  if (typeof exported.main !== 'function') {
    throw new Error('the target script does not define main(config); is this the extension script?');
  }
  const settings: ScriptSettings = {
    mode: String(exported.MODE ?? ''),
    exitGroup: String(exported.EXIT_GROUP ?? ''),
    entranceGroup: String(exported.ENTRANCE_GROUP ?? ''),
    targets: Array.isArray(exported.EXIT_GROUP_TARGETS)
      ? exported.EXIT_GROUP_TARGETS.map(String)
      : exported.EXIT_GROUP_TARGETS
        ? [String(exported.EXIT_GROUP_TARGETS)]
        : [],
    rules: Array.isArray(exported.RULES_TO_EXIT) ? exported.RULES_TO_EXIT.map(String) : [],
  };
  return { main: exported.main as (config: unknown) => unknown, exits: exported.STATIC_EXITS as unknown[], settings };
}

/** The script's entries carry mihomo's field name; the rest of the CLI does not. */
function toStaticExit(raw: unknown): StaticExit {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const exit: StaticExit = {
    name: String(entry.name ?? ''),
    type: entry.type === 'http' ? 'http' : 'socks5',
    server: String(entry.server ?? ''),
    port: Number(entry.port ?? 0),
  };
  if (typeof entry.username === 'string') exit.username = entry.username;
  const credential = entry[CREDENTIAL_FIELD];
  if (typeof credential === 'string') exit.credential = credential;
  if (entry.tls === true) exit.tls = true;
  if (typeof entry.udp === 'boolean') exit.udp = entry.udp;
  return exit;
}

export function loadScript(scriptText: string): LoadedScript {
  const loaded = loadModule(scriptText);
  const raw = Array.isArray(loaded.exits) ? loaded.exits : [];
  return { source: scriptText, settings: loaded.settings, exits: raw.map(toStaticExit) };
}

export interface Injection {
  proxies: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  rules: string[];
}

/**
 * Run `main()` over a probe config and report what it added.
 *
 * The probe carries a single proxy and a main selector, which is the minimum
 * shape the script needs to build a chain; anything the script would refuse to
 * inject (no upstream to chain through, for example) shows up as an empty
 * injection rather than as a claim.
 */
export function probeInjection(scriptText: string, options: { entryName?: string; selectorName?: string } = {}): Injection {
  const { main } = loadModule(scriptText);
  const entryName = options.entryName ?? 'PROBE-ENTRY';
  const selectorName = options.selectorName ?? 'PROBE-SELECT';
  const base = {
    proxies: [{ name: entryName, type: 'socks5', server: '192.0.2.1', port: 1080 }],
    'proxy-groups': [{ name: selectorName, type: 'select', proxies: [entryName, 'DIRECT'] }],
    rules: [`MATCH,${selectorName}`],
  };
  const before = JSON.parse(JSON.stringify(base)) as typeof base;
  const after = main(JSON.parse(JSON.stringify(base))) as typeof base & { rules?: string[] };
  const beforeNames = new Set(before.proxies.map((proxy) => proxy.name));
  const beforeGroups = new Set(before['proxy-groups'].map((group) => group.name));
  const proxies = (after.proxies ?? []).filter((proxy) => !beforeNames.has(proxy.name));
  const groups = (after['proxy-groups'] ?? []).filter((group) => !beforeGroups.has(group.name));
  const beforeRules = new Set(before.rules);
  const rules = (after.rules ?? []).filter((rule) => !beforeRules.has(rule));
  return { proxies, groups, rules };
}
