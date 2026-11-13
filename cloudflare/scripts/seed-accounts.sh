#!/usr/bin/env bash
# Push the account pool into the deployed Worker.
#
# The crawl leases one pooled account per vendor request. A deployment with an
# empty pool does not fail loudly: every source reports
# "account pool has no active <brand> account", the run finishes with zero
# final links, and the gate holds — so the subscription is never replaced and
# the schedule looks healthy while publishing nothing.
#
# The pool is the one piece of state that cannot live in the image (it is
# credentials) and cannot live on the container disk (it is ephemeral), so the
# Durable Object stores the CSV and replays it into every fresh container.
#
# Usage:
#   cloudflare/scripts/seed-accounts.sh <account-file> [base-url]
#   AUTOVPN_API_TOKEN=... cloudflare/scripts/seed-accounts.sh ~/account-info.txt
#
# The file may be the legacy `[brand]` block format the CLI's own
# `accounts import` accepts, or a CSV. Which one it is gets decided by the
# container, not here.
set -euo pipefail

FILE="${1:-}"
BASE="${2:-${AUTOVPN_BASE_URL:-}}"
: "${AUTOVPN_API_TOKEN:?AUTOVPN_API_TOKEN must be set (it is in ~/.autovpn-api-token)}"
: "${FILE:?usage: seed-accounts.sh <account-file> [base-url]}"
: "${BASE:?set AUTOVPN_BASE_URL or pass it as the second argument}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }

# The body is JSON, and the account file is large and full of characters that
# a shell-quoted heredoc would mangle, so it is encoded by node rather than by
# string interpolation.
BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/autovpn-seed.XXXXXX")"
trap 'rm -f "$BODY_FILE"' EXIT
node -e '
const fs = require("node:fs");
const [file, out] = process.argv.slice(1);
fs.writeFileSync(out, JSON.stringify({ csv: fs.readFileSync(file, "utf8"), format: "auto" }));
' "$FILE" "$BODY_FILE"

echo "importing $FILE ($(wc -c < "$FILE" | tr -d ' ') bytes) into $BASE"
# `--data-binary @-` keeps the payload off the command line.
RESPONSE="$(curl -fsS --max-time 300 \
  -X POST "$BASE/api/accounts/import" \
  -H "authorization: Bearer $AUTOVPN_API_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary @"$BODY_FILE")"

# Report counts only; the response carries no rows, but a raw body is still
# not something to paste into a terminal that a screen recording may capture.
node -e '
const payload = JSON.parse(process.argv[1]);
const container = payload.accounts ?? {};
console.log("stored rows:   ", payload.rows ?? "?");
console.log("imported:      ", payload.imported ?? "?");
console.log("container pool:", container.present ? `${container.active}/${container.total} active` : "not started yet");
if (payload.deferred) console.log("note: the container was not reachable; the pool is stored and will be replayed on the next boot");
// A stored file is not an imported pool. The whole point of this script is to
// leave the deployment with usable credentials, so anything that did not put
// rows into rotation exits non-zero — otherwise the schedule stays green for
// days while every source logs "no active account".
if (payload.failed || (payload.exitCode && payload.exitCode !== 0)) {
  console.error("import rejected:", payload.reason ?? payload.stderr ?? `exit ${payload.exitCode}`);
  process.exit(1);
}
if (!payload.deferred && !(Number(payload.imported) > 0)) {
  console.error("the file parsed to zero importable rows; check brand/account/password columns");
  process.exit(1);
}
' "$RESPONSE"

echo
echo "verify with: curl -sS $BASE/api/accounts -H \"authorization: Bearer \$AUTOVPN_API_TOKEN\""
