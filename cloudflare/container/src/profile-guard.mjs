/**
 * Cross-check the profile against the Worker template it will be built from.
 *
 * `buildWorkerArtifacts` replaces two exact strings in the template:
 *
 *     searchParams.get("<key>")
 *     === "<value>"
 *
 * If the profile's `secret_query` disagrees with the template's literal, the
 * replacement silently does nothing — the published Worker then serves the
 * payload to whoever presents the *old* key and returns random bytes to the
 * URL the profile advertises. The deploy still returns 0 and the verify stage
 * still passes, because the secret-bearing URL it checks is built from
 * `pages_project_url`, not from the key the template actually guards.
 *
 * So the disagreement is checked before the run, where it costs nothing.
 */

/** The `secret_query = "key=value"` from a TOML profile, or ''. */
export function parseSecretQuery(profileToml) {
  const match = /^\s*secret_query\s*=\s*"([^"]*)"/m.exec(String(profileToml ?? ''));
  return match ? match[1] : '';
}

/** The `=== "<literal>"` guard value in the rendered Worker template, or ''. */
export function parseTemplateSecret(templateSource) {
  const match = /===\s*"([^"]*)"/.exec(String(templateSource ?? ''));
  return match ? match[1] : '';
}

/**
 * Why the profile and template cannot be built together, or '' when they can.
 *
 * Returns a sentence rather than a boolean: this runs inside `/run`, and the
 * reply is what the Durable Object records as the run's error.
 */
export function secretQueryMismatch(profileToml, templateSource) {
  const query = parseSecretQuery(profileToml);
  if (!query) {
    return 'profile has no secret_query; the Worker bundle would guard an empty key';
  }
  const separator = query.indexOf('=');
  if (separator <= 0) {
    return `secret_query "${query}" is not key=value, so the template guard cannot be rewritten`;
  }
  const value = query.slice(separator + 1);
  const templateSecret = parseTemplateSecret(templateSource);
  if (!templateSecret) {
    return 'the Worker template has no `=== "..."` secret guard to rewrite';
  }
  if (templateSecret !== value) {
    // The lengths are the whole diagnosis: equal lengths means a rotated key,
    // different lengths means the file pair is mismatched (a template from
    // another projects' profile), and both are silent publishes as the wrong
    // key today.
    return `profile secret_query value (${value.length} chars) does not match the template guard (${templateSecret.length} chars); `
      + 'the published Worker would keep serving the template key and reject the URL the profile advertises';
  }
  return '';
}
