/**
 * Cross-check the profile against the Worker template it will be built from.
 *
 * `buildWorkerArtifacts` replaces two exact sentinels in the template:
 *
 *     searchParams.get("__SUBSCRIPTION_PARAM__")
 *     === "__SUBSCRIPTION_KEY__"
 *
 * with the parameter name and value from the profile's `secret_query`, and it
 * throws if a sentinel survives. That makes a *missing* rewrite loud. What is
 * still silent is the profile carrying no usable key at all: the bundle would
 * then guard whatever `secret_query` says, the deploy returns 0, and the verify
 * stage passes because it checks a URL built from `pages_project_url`.
 *
 * Since the key moved out of the repository, `secret_query` is the sentinel
 * `{{SUBSCRIPTION_KEY}}` and the value arrives from the environment. This
 * module's job is to say whether that resolution will succeed, before the run
 * spends an hour measuring.
 */

/** The sentinel a profile uses to defer its key to the environment. */
export const SECRET_QUERY_SENTINEL = '{{SUBSCRIPTION_KEY}}';
export const SECRET_QUERY_ENV = 'VPN_AUTOMATION_SUBSCRIPTION_KEY';

/** The `secret_query = "..."` from a TOML profile, or ''. */
export function parseSecretQuery(profileToml) {
  const match = /^\s*secret_query\s*=\s*"([^"]*)"/m.exec(String(profileToml ?? ''));
  return match ? match[1] : '';
}

/** The `=== "<literal>"` guard value in the Worker template, or ''. */
export function parseTemplateSecret(templateSource) {
  const match = /===\s*"([^"]*)"/.exec(String(templateSource ?? ''));
  return match ? match[1] : '';
}

/**
 * The key the deploy will actually use, mirroring `resolveSecretQuery` in the
 * CLI: the environment wins when the profile defers, and a literal in the
 * profile still works (the VPS profile uses one).
 */
export function resolveKeyFromEnv(profileToml, env = {}) {
  const configured = parseSecretQuery(profileToml);
  const fromEnv = String(env[SECRET_QUERY_ENV] ?? '').trim();
  if (configured === SECRET_QUERY_SENTINEL || !configured) {
    return fromEnv;
  }
  return configured;
}

/**
 * Why the profile and template cannot be built together, or '' when they can.
 *
 * Returns a sentence rather than a boolean: this runs inside `/run`, and the
 * reply is what the Durable Object records as the run's error.
 */
export function secretQueryMismatch(profileToml, templateSource, env = {}) {
  const configured = parseSecretQuery(profileToml);
  if (!configured) {
    return 'profile has no secret_query; the Worker bundle would guard an empty key';
  }
  const templateSecret = parseTemplateSecret(templateSource);
  if (!templateSecret) {
    return 'the Worker template has no `=== "..."` secret guard to rewrite';
  }

  const resolved = resolveKeyFromEnv(profileToml, env);
  if (!resolved) {
    // The one case that used to publish a broken subscription: the profile
    // defers, the variable is unset, and the bundle ends up guarding the
    // sentinel itself — which is written in the public profile.
    return `the profile defers its key to ${SECRET_QUERY_ENV}, which is unset; `
      + 'refusing to publish a subscription keyed by the sentinel';
  }

  const separator = resolved.indexOf('=');
  if (separator <= 0) {
    return `the subscription key "${resolved}" is not key=value, so the template guard cannot be rewritten`;
  }

  if (configured !== SECRET_QUERY_SENTINEL) {
    // A literal profile: the template sentinel must be replaced by that value,
    // and a template carrying a *different* literal means the pair was edited
    // apart.
    const value = configured.slice(configured.indexOf('=') + 1);
    if (templateSecret !== value && templateSecret !== '__SUBSCRIPTION_KEY__') {
      return `profile secret_query value (${value.length} chars) does not match the template guard (${templateSecret.length} chars); `
        + 'the published Worker would keep serving the template key and reject the URL the profile advertises';
    }
  }

  if (templateSecret !== '__SUBSCRIPTION_KEY__') {
    return 'the Worker template guard is not the sentinel, so the build cannot rewrite it from the resolved key';
  }
  return '';
}
