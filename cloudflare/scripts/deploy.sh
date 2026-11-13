#!/usr/bin/env bash
# Deploy the Cloudflare side.
#
# Everything here is idempotent: re-running it after a code change rebuilds the
# image and rolls the Worker, and re-running it after a profile change only
# updates the secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "$ROOT/.." && pwd)"
# Prefer the pinned local install; fall back to npx only when it is absent.
if [ -x "$ROOT/worker/node_modules/.bin/wrangler" ]; then
  WRANGLER="$ROOT/worker/node_modules/.bin/wrangler"
else
  WRANGLER="${WRANGLER:-npx wrangler}"
fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID must be set}"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "toolchain"
node --version
# `wrangler.jsonc` uses `scheduling_policy: "durable_object"` and declarative
# `exports`. The CLI's own managed-tool path pins 4.106.0 for Pages deploys,
# which understands neither, so this subtree deploys with its own pinned
# version and refuses to run against anything older.
WRANGLER_VERSION="$(${WRANGLER} --version 2>/dev/null | tail -n1 | tr -d '[:space:]')"
echo "wrangler $WRANGLER_VERSION"
if [ "$(printf '%s\n%s\n' "4.160.1" "$WRANGLER_VERSION" | sort -V | head -n1)" != "4.160.1" ]; then
  echo "wrangler >= 4.160.1 is required (got $WRANGLER_VERSION)" >&2
  echo "run: npm --prefix $ROOT/worker install" >&2
  exit 1
fi

step "token permissions"
# `wrangler deploy` reports a bare "Authentication error" for a missing scope and
# does not say which one, so the check runs before the ten-minute image build.
if ! node "$ROOT/scripts/check-token.mjs"; then
  exit 1
fi

step "container image dependencies"
"$ROOT/scripts/fetch-mihomo.sh"

step "worker secrets"
# The profile the container reads must be the *Cloudflare* one. Taking
# `state/profile.toml` would ship the live VPS profile, whose `project_name`
# points at a real subscription — the first run would then publish over it.
CONTAINER_PROFILE="$ROOT/container/profile.cloudflare.toml"
if [ ! -f "$CONTAINER_PROFILE" ]; then
  echo "missing $CONTAINER_PROFILE" >&2
  exit 1
fi
PROFILE_PROJECT="$(grep -E '^[[:space:]]*project_name[[:space:]]*=' "$CONTAINER_PROFILE" \
  | head -n1 | sed -E 's/^[^=]*=[[:space:]]*"(.*)"/\1/')"
case "$PROFILE_PROJECT" in
  autovpn-cf-*)
    echo "deploy target: $PROFILE_PROJECT (scratch project)"
    ;;
  *)
    # Not a hard stop: publishing to a real project is the eventual goal. It
    # just must be a deliberate edit, not a default.
    echo "deploy target: $PROFILE_PROJECT"
    echo "  NOT a scratch project — this run will replace that project's production deployment."
    if [ "${AUTOVPN_ALLOW_LIVE_PROJECT:-}" != "1" ]; then
      echo "  set AUTOVPN_ALLOW_LIVE_PROJECT=1 to proceed" >&2
      exit 1
    fi
    ;;
esac

# The deploy stage inside the container publishes to this project. Wrangler
# refuses a missing project in a non-interactive shell and there is no recovery
# mid-run — the artifact lives on a volume the container loses when it sleeps —
# so the project is created here, before anything is built.
step "pages project"
node "$ROOT/scripts/ensure-pages-project.mjs" "$PROFILE_PROJECT"

# `wrangler secret put` reads stdin, which keeps the value out of the process
# table and out of shell history.
#
# A Worker secret is capped at 5 KB. The profile is kept under that with room
# to spare, and the size is asserted again below after stripping: wrangler does
# not check it locally, and the API rejects the upload, so the first symptom
# would be a deploy that fails after the image build. Comments and blank lines
# carry no meaning for the CLI, so they are stripped before the value is handed
# over. A full-line `#` inside a multi-line TOML string would be content, not a
# comment, so the profile is checked for those first.
SECRET_PROFILE="$CONTAINER_PROFILE"
if grep -q '"""' "$CONTAINER_PROFILE"; then
  echo "$CONTAINER_PROFILE uses a multi-line TOML string; comment stripping is unsafe" >&2
  exit 1
fi
if [ -z "${AUTOVPN_PROFILE_TOML:-}" ]; then
  SECRET_PROFILE="$(mktemp "${TMPDIR:-/tmp}/autovpn-profile.XXXXXX")"
  trap 'rm -f "$SECRET_PROFILE"' EXIT
  grep -v -E '^[[:space:]]*#' "$CONTAINER_PROFILE" | grep -v -E '^[[:space:]]*$' > "$SECRET_PROFILE"
fi
PROFILE_BYTES="$(wc -c < "$SECRET_PROFILE" | tr -d ' ')"
if [ "$PROFILE_BYTES" -gt 5120 ]; then
  echo "profile is $PROFILE_BYTES bytes; a Worker secret is capped at 5120" >&2
  exit 1
fi
echo "profile secret: $PROFILE_BYTES bytes"

if [ -n "${AUTOVPN_PROFILE_TOML:-}" ]; then
  printf '%s' "$AUTOVPN_PROFILE_TOML" | ${WRANGLER} secret put AUTOVPN_PROFILE_TOML --cwd "$ROOT"
else
  ${WRANGLER} secret put AUTOVPN_PROFILE_TOML --cwd "$ROOT" < "$SECRET_PROFILE"
fi

# The deploy *stage* inside the container publishes the subscription with
# wrangler, and `resolveCloudflareCredentials()` falls back to this env var, so
# the container needs it. Same token, narrower blast radius than the profile
# carrying it as plain text.
printf '%s' "$CLOUDFLARE_API_TOKEN" | ${WRANGLER} secret put CLOUDFLARE_API_TOKEN --cwd "$ROOT"

if [ -z "${AUTOVPN_API_TOKEN:-}" ]; then
  # In CI an unset token must fail, not mint a replacement: a new bearer would
  # be pushed to the Worker and every existing client would start getting 401.
  # A workstation can recover the generated value from the printed path; a
  # pipeline cannot recover anything, because the path is on the runner.
  if [ -n "${CI:-}" ]; then
    echo "AUTOVPN_API_TOKEN is unset and CI is set; refusing to rotate the bearer." >&2
    echo "  store it once: gh secret set AUTOVPN_API_TOKEN" >&2
    exit 1
  fi
  AUTOVPN_API_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  # Written to a 0600 file rather than echoed: a token in stdout also lands in
  # the terminal scrollback and, under some shells, in history.
  TOKEN_FILE="${TMPDIR:-/tmp}/autovpn-api-token.$$"
  (umask 077; printf '%s' "$AUTOVPN_API_TOKEN" > "$TOKEN_FILE")
  echo "generated a new AUTOVPN_API_TOKEN, written to $TOKEN_FILE (mode 0600)"
  echo "move it into your password manager; it is not recoverable from Cloudflare."
fi
printf '%s' "$AUTOVPN_API_TOKEN" | ${WRANGLER} secret put AUTOVPN_API_TOKEN --cwd "$ROOT"

step "subscription URL"
# The egress pool is built from a *published* subscription, which is not
# necessarily the project this deployment publishes to. Ask for it explicitly
# rather than deriving it from the deploy profile: deriving would point the pool
# at the scratch project before that project has ever served anything.
if [ -n "${AUTOVPN_SUBSCRIPTION_URL:-}" ]; then
  printf '%s' "$AUTOVPN_SUBSCRIPTION_URL" | ${WRANGLER} secret put SUBSCRIPTION_URL --cwd "$ROOT"
else
  echo "AUTOVPN_SUBSCRIPTION_URL is not set; the crawl will start with no egress pool" >&2
  echo "  (it degrades to direct and says so in /api/status)" >&2
  echo "  set it to a subscription URL that includes ?serect_key=..., then re-run." >&2
fi

step "deploy"
${WRANGLER} deploy --cwd "$ROOT"

step "smoke"
BASE="${AUTOVPN_BASE_URL:-}"
if [ -n "$BASE" ]; then
  # `/health` sits behind the bearer token, like every other route: an
  # unauthenticated probe answers 401 on a perfectly healthy deployment.
  #
  # A freshly deployed Worker can 404 or 5xx for a few seconds while the route
  # propagates, so this retries. Past the retries it fails the run on purpose:
  # `wrangler deploy` exiting zero means the bundle was accepted, not that the
  # thing answers.
  smoke() {
    curl -fsS --max-time 20 "$1" -H "authorization: Bearer $AUTOVPN_API_TOKEN"
  }
  ok=0
  for attempt in 1 2 3 4 5; do
    if smoke "$BASE/health" > /dev/null 2>&1; then ok=1; break; fi
    sleep $((attempt * 3))
  done
  if [ "$ok" != "1" ]; then
    echo "deployed, but $BASE/health never answered with the bearer token" >&2
    echo "  check: curl -i $BASE/health -H 'authorization: Bearer <token>'" >&2
    exit 1
  fi
  echo "health ok"
  # `| head -c 600` closes the pipe early, which kills curl with SIGPIPE and
  # would end the script under `set -e` — after the deploy already succeeded.
  # Truncate the captured body instead of the stream.
  status_body="$(smoke "$BASE/api/status" || true)"
  printf '%s\n' "${status_body:0:600}"
else
  echo "set AUTOVPN_BASE_URL to the deployed workers.dev URL to smoke-test it here."
fi
