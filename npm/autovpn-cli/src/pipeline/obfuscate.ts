export interface WorkerBuildConfigInput {
  environment_name?: string;
  entry_filename?: string;
  bundle_subdir?: string;
  modules_subdir?: string;
  manifest_filename?: string;
  variable_prefix?: string;
  comment_template?: string;
  random_noise_min_length?: number;
  random_noise_max_length?: number;
  enable_keyword_fragmentation?: boolean;
  enable_identifier_randomization?: boolean;
  emit_sidecar_modules?: boolean;
}

export interface WorkerBuildConfigResolved {
  environment_name: string;
  entry_filename: string;
  bundle_subdir: string;
  modules_subdir: string;
  manifest_filename: string;
  variable_prefix: string;
  comment_template: string;
  random_noise_min_length: number;
  random_noise_max_length: number;
  enable_keyword_fragmentation: boolean;
  enable_identifier_randomization: boolean;
  emit_sidecar_modules: boolean;
}

export interface ObfuscateInput {
  rendered_source: string;
  config?: WorkerBuildConfigInput;
  secret_query: string;
}

export interface WorkerBuildArtifacts {
  transformed_source: string;
  modules: Record<string, string>;
  manifest: Record<string, unknown>;
}

export interface ObfuscateBackendOptions {}

const DEFAULT_WORKER_BUILD_CONFIG: WorkerBuildConfigResolved = {
  environment_name: 'production',
  entry_filename: '_worker.js',
  bundle_subdir: 'pages_bundle',
  modules_subdir: 'modules',
  manifest_filename: 'manifest.json',
  variable_prefix: 'sg',
  comment_template: 'subscription worker: returns encoded payload on secret match, random bytes otherwise',
  random_noise_min_length: 24,
  random_noise_max_length: 96,
  enable_keyword_fragmentation: true,
  enable_identifier_randomization: true,
  emit_sidecar_modules: true
};

function jsonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveWorkerBuildConfig(config: WorkerBuildConfigInput = {}): WorkerBuildConfigResolved {
  return {
    ...DEFAULT_WORKER_BUILD_CONFIG,
    ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
  };
}

export function stableIdentifierPrefix(prefix: string): string {
  const normalized = String(prefix || 'sg').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) {
    return 'sg';
  }
  if (/^\d/.test(normalized)) {
    return `sg_${normalized}`;
  }
  return normalized;
}

function splitLiteral(value: string): string[] {
  if (value.includes('_')) {
    const separator = value.indexOf('_');
    const head = value.slice(0, separator);
    const tail = value.slice(separator + 1);
    return [head.slice(0, 3), head.slice(3), `_${tail}`].filter((part) => part.length > 0);
  }
  if (value.length > 8) {
    return [value.slice(0, 4), value.slice(4, 8), value.slice(8)].filter((part) => part.length > 0);
  }
  if (value.length > 4) {
    return [value.slice(0, 4), value.slice(4)].filter((part) => part.length > 0);
  }
  return [value];
}

export function fragmentLiteral(value: string, enabled: boolean): string {
  if (!enabled) {
    return jsonStringLiteral(value);
  }
  const quoted = splitLiteral(value).map((part) => jsonStringLiteral(part).replaceAll('"', "'")).join(', ');
  return `[${quoted}].join('')`;
}

function formatComment(template: string, environmentName: string): string {
  return template
    .replaceAll('{{', '\u0000OPEN_BRACE\u0000')
    .replaceAll('}}', '\u0000CLOSE_BRACE\u0000')
    .replaceAll('{environment_name}', environmentName)
    .replaceAll('\u0000OPEN_BRACE\u0000', '{')
    .replaceAll('\u0000CLOSE_BRACE\u0000', '}');
}

function buildTransformedSource(renderedSource: string, config: WorkerBuildConfigResolved, secretKey: string, secretValue: string): string {
  let source = renderedSource;
  if (config.enable_identifier_randomization) {
    const prefix = stableIdentifierPrefix(config.variable_prefix);
    const replacements: Record<string, string> = {
      secretToken: `${prefix}_secret_token`,
      responsePayload: `${prefix}_response_payload`,
      randomBytes: `${prefix}_random_bytes`,
      error: `${prefix}_error`
    };
    for (const [oldName, newName] of Object.entries(replacements)) {
      source = source.replace(new RegExp(`\\b${escapeRegExp(oldName)}\\b`, 'g'), newName);
    }
  }

  source = source.replace(
    `searchParams.get("${secretKey}")`,
    `searchParams.get(${fragmentLiteral(secretKey, config.enable_keyword_fragmentation)})`
  );
  source = source.replace(
    `=== "${secretValue}"`,
    `=== ${fragmentLiteral(secretValue, config.enable_keyword_fragmentation)}`
  );
  return `// ${formatComment(config.comment_template, config.environment_name)}\n${source}`;
}

function extractMainData(renderedSource: string): string {
  const match = renderedSource.match(/const (?:MainData|SUBSCRIPTION_PAYLOAD) = `(?<payload>[\s\S]*?)`;/);
  return match?.groups?.payload ?? '';
}

export function buildWorkerArtifacts(
  renderedSource: string,
  configInput: WorkerBuildConfigInput = {},
  secretQuery: string
): WorkerBuildArtifacts {
  const config = resolveWorkerBuildConfig(configInput);
  const separator = secretQuery.indexOf('=');
  if (separator === -1) {
    throw new Error('secret_query must contain a key=value pair');
  }
  const secretKey = secretQuery.slice(0, separator);
  const secretValue = secretQuery.slice(separator + 1);
  const transformedSource = buildTransformedSource(renderedSource, config, secretKey, secretValue);
  const modulesSubdir = config.modules_subdir.replace(/^\/+|\/+$/g, '') || 'modules';
  const modules: Record<string, string> = {
    [`${modulesSubdir}/runtime.js`]: `export const workerSource = ${jsonStringLiteral(transformedSource)};\n`,
    [`${modulesSubdir}/guard.js`]: (
      `export const secretParam = ${fragmentLiteral(secretKey, config.enable_keyword_fragmentation)};\n` +
      `export const secretValue = ${fragmentLiteral(secretValue, config.enable_keyword_fragmentation)};\n`
    ),
    [`${modulesSubdir}/noise.js`]: `export const noiseLengthRange = [${config.random_noise_min_length}, ${config.random_noise_max_length}];\n`,
    [`${modulesSubdir}/payload.js`]: `export const mainData = ${jsonStringLiteral(extractMainData(renderedSource))};\n`
  };
  return {
    transformed_source: transformedSource,
    modules,
    manifest: {
      environment_name: config.environment_name,
      entry_filename: config.entry_filename,
      modules: Object.keys(modules).sort(),
      variable_prefix: config.variable_prefix,
      enable_keyword_fragmentation: config.enable_keyword_fragmentation,
      enable_identifier_randomization: config.enable_identifier_randomization
    }
  };
}

export async function buildWorkerArtifactsWithBackend(input: ObfuscateInput, options: ObfuscateBackendOptions = {}): Promise<WorkerBuildArtifacts> {
  void options;
  return buildWorkerArtifacts(input.rendered_source, input.config, input.secret_query);
}
