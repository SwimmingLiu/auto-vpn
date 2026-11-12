#!/usr/bin/env bash
# Deploy the Cloudflare side.
#
# Everything here is idempotent: re-running it after a code change rebuilds the
# image and rolls the Worker, and re-running it after a profile change only
# updates the secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "$ROOT/.." && pwd)"
WRANGLER="${WRANGLER:-npx wrangler}"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID must be set}"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "toolchain"
node --version
${WRANGLER} --version

step "container image dependencies"
"$ROOT/scripts/fetch-mihomo.sh"

step "worker secrets"
# Secrets are the only thing that differs between a working deployment and a
# broken one, so they are checked rather than assumed.
if [ ! -f "$PROJECT_ROOT/state/profile.toml" ]; then
  echo "state/profile.toml not found — copy an existing profile there first" >&2
  exit 1
fi
if ! grep -q 'secret_query' "$PROJECT_ROOT/state/profile.toml"; then
  echo "profile has no [deploy].secret_query; the container cannot build a subscription URL" >&2
  exit 1
fi

# `wrangler secret put` reads stdin, which keeps the value out of the process
# table and out of shell history.
if [ -n "${AUTOVPN_PROFILE_TOML:-}" ]; then
  printf '%s' "$AUTOVPN_PROFILE_TOML" | ${WRANGLER} secret put AUTOVPN_PROFILE_TOML --cwd "$ROOT"
else
  ${WRANGLER} secret put AUTOVPN_PROFILE_TOML --cwd "$ROOT" < "$PROJECT_ROOT/state/profile.toml"
fi

if [ -z "${AUTOVPN_API_TOKEN:-}" ]; then
  AUTOVPN_API_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  echo "generated a new AUTOVPN_API_TOKEN:"
  echo "  $AUTOVPN_API_TOKEN"
  echo "store it now; it is not recoverable from Cloudflare."
fi
printf '%s' "$AUTOVPN_API_TOKEN" | ${WRANGLER} secret put AUTOVPN_API_TOKEN --cwd "$ROOT"

step "subscription URL"
# The published worker answers `btoa(randomBytes)` unless the query carries the
# right key, so a URL without it silently feeds the egress supervisor noise.
SECRET_QUERY="$(grep -E '^[[:space:]]*secret_query[[:space:]]*=' "$PROJECT_ROOT/state/profile.toml" \
  | head -n1 | sed -E 's/^[^=]*=[[:space:]]*"(.*)"/\1/')"
PROJECT_NAME="$(grep -E '^[[:space:]]*project_name[[:space:]]*=' "$PROJECT_ROOT/state/profile.toml" \
  | head -n1 | sed -E 's/^[^=]*=[[:space:]]*"(.*)"/\1/')"
if [ -n "$SECRET_QUERY" ] && [ -n "$PROJECT_NAME" ]; then
  SUBSCRIPTION_URL="https://${PROJECT_NAME}.pages.dev/?${SECRET_QUERY}"
  printf '%s' "$SUBSCRIPTION_URL" | ${WRANGLER} secret put SUBSCRIPTION_URL --cwd "$ROOT"
else
  echo "could not derive SUBSCRIPTION_URL from the profile; set it manually:" >&2
  echo "  wrangler secret put SUBSCRIPTION_URL --cwd $ROOT" >&2
fi

step "deploy"
${WRANGLER} deploy --cwd "$ROOT"

step "smoke"
BASE="${AUTOVPN_BASE_URL:-}"
if [ -n "$BASE" ]; then
  curl -fsS "$BASE/health" && echo
  curl -fsS "$BASE/api/status" -H "authorization: Bearer $AUTOVPN_API_TOKEN" | head -c 600 && echo
else
  echo "set AUTOVPN_BASE_URL to the deployed workers.dev URL to smoke-test it here."
fi
