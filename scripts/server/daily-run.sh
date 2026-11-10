#!/usr/bin/env bash
# One daily end-to-end run with a final-node gate.
#
# The run always executes the full extract -> dedupe -> speedtest ->
# availability -> postprocess -> render -> obfuscate chain. Deployment only
# happens when the postprocessed node count clears `min_final_nodes` in
# `$RUNTIME_ROOT/daily-run.json` (default 50). The deploy path is
# `retry-stage --stage deploy` on the freshly built artifact, so the published
# bundle is the one this run measured, and the subscription is verified against
# it immediately.
#
# Exit status is 0 only when the run finished (deployed or deliberately held),
# so cron surfaces a genuine failure instead of a quiet skip.
#
# `source_runtime_seconds` in the config bounds each brand's extraction. The
# scheduled default is finite on purpose: an unbounded sweep has run for ten
# hours on this host, and a nightly job must not still be extracting when the
# next one starts.
set -euo pipefail

RUNTIME_ROOT="${AUTOVPN_RUNTIME_ROOT:-$HOME/.auto-vpn}"
PROJECT_ROOT="${AUTOVPN_PROJECT_ROOT:-$RUNTIME_ROOT/workspace}"
NODE_BIN="${AUTOVPN_NODE_BIN:-/www/server/nodejs/v22.20.0/bin/node}"
CLI_ENTRY="${AUTOVPN_CLI_ENTRY:-/www/server/nodejs/v22.20.0/lib/node_modules/@swimmingliu/autovpn/bin/autovpn.mjs}"
CONFIG_PATH="${AUTOVPN_DAILY_CONFIG:-$RUNTIME_ROOT/daily-run.json}"
LOG_DIR="$RUNTIME_ROOT/logs"
RESULT_DIR="$RUNTIME_ROOT/daily-run-results"
LOCK_FILE="$RUNTIME_ROOT/daily-run.lock"
PROFILE_PATH="$RUNTIME_ROOT/profile.toml"
DEFAULT_MIN_FINAL_NODES=50
DEFAULT_SOURCE_RUNTIME_SECONDS=900

mkdir -p "$LOG_DIR" "$RESULT_DIR"
chmod 700 "$LOG_DIR" "$RESULT_DIR" 2>/dev/null || true

stamp="$(date +%Y%m%d-%H%M%S)"
log_file="$LOG_DIR/daily-run-$stamp.log"
result_file="$RESULT_DIR/$stamp.json"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$log_file" >&2
}

# Serialize runs. A second cron tick while one is still extracting must not
# start a second sweep over the same account pool.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another daily run holds $LOCK_FILE; skipping this tick"
  exit 0
fi

if [ ! -f "$CLI_ENTRY" ]; then
  log "CLI entry not found: $CLI_ENTRY"
  exit 1
fi
if [ ! -f "$CONFIG_PATH" ]; then
  printf '{"min_final_nodes": %s, "source_runtime_seconds": %s}\n' \
    "$DEFAULT_MIN_FINAL_NODES" "$DEFAULT_SOURCE_RUNTIME_SECONDS" > "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
  log "wrote default config to $CONFIG_PATH (min_final_nodes=$DEFAULT_MIN_FINAL_NODES, source_runtime_seconds=$DEFAULT_SOURCE_RUNTIME_SECONDS)"
fi

read -r min_final_nodes source_runtime_seconds enabled <<<"$("$NODE_BIN" -e '
const fs = require("node:fs");
const defaults = { min_final_nodes: Number(process.argv[2]), source_runtime_seconds: Number(process.argv[3]), enabled: true };
let config = defaults;
try {
  config = { ...defaults, ...JSON.parse(fs.readFileSync(process.argv[1], "utf8")) };
} catch (error) {
  process.stderr.write(`daily-run config unreadable: ${error.message}\n`);
}
const min = Number(config.min_final_nodes);
const runtime = Number(config.source_runtime_seconds);
process.stdout.write([
  Number.isFinite(min) && min >= 0 ? Math.trunc(min) : defaults.min_final_nodes,
  Number.isFinite(runtime) && runtime >= 0 ? Math.trunc(runtime) : defaults.source_runtime_seconds,
  config.enabled === false ? "disabled" : "enabled"
].join(" ") + "\n");
' "$CONFIG_PATH" "$DEFAULT_MIN_FINAL_NODES" "$DEFAULT_SOURCE_RUNTIME_SECONDS")"

if [ "$enabled" = "disabled" ]; then
  log "daily run disabled in $CONFIG_PATH; skipping"
  exit 0
fi

# The live profile is never edited by this job. A copy carrying the runtime
# budget is written beside the logs and selected for the run and its deploy, so
# an operator's profile edit is not overwritten and the budget is visible.
run_env=(VPN_AUTOMATION_PROFILE_PATH="$PROFILE_PATH")
if [ "$source_runtime_seconds" -gt 0 ]; then
  if [ ! -f "$PROFILE_PATH" ]; then
    log "profile not found: $PROFILE_PATH"
    exit 1
  fi
  staged_profile="$RUNTIME_ROOT/daily-run-profile.toml"
  staging_note="$("$NODE_BIN" -e '
const fs = require("node:fs");
const [source, target, budget] = process.argv.slice(1);
const text = fs.readFileSync(source, "utf8");
// A TOML section ends at the next header; rewrite only the source tables so
// deploy, filters and worker settings pass through untouched.
let inSource = false;
let seen = 0;
const out = text.split("\n").map((line) => {
  const header = line.match(/^\s*\[([^\]]+)\]/);
  if (header) {
    inSource = /^sources\./.test(header[1].trim());
    return line;
  }
  if (inSource && /^\s*max_runtime_seconds\s*=/.test(line)) {
    seen += 1;
    return `max_runtime_seconds = ${budget}`;
  }
  return line;
});
if (!seen) {
  process.stderr.write("no max_runtime_seconds line found under [sources.*]; refusing to fake a budget\n");
  process.exit(1);
}
fs.writeFileSync(target, out.join("\n"), { mode: 0o600 });
process.stdout.write(`staged runtime budget ${budget}s across ${seen} sources`);
' "$PROFILE_PATH" "$staged_profile" "$source_runtime_seconds")"
  log "$staging_note"
  run_env=(VPN_AUTOMATION_PROFILE_PATH="$staged_profile")
fi

cli() {
  env "${run_env[@]}" "$NODE_BIN" "$CLI_ENTRY" "$@" --project-root "$PROJECT_ROOT"
}

total_started=$SECONDS
log "run start: min_final_nodes=$min_final_nodes source_runtime_seconds=$source_runtime_seconds runtime_root=$RUNTIME_ROOT"

set +e
cli run --skip-deploy --skip-verify --output jsonl 2>&1 | tee -a "$log_file" | grep --line-buffered -E '"(summary|run_failed|stage)"' >&2
run_status=${PIPESTATUS[0]}
set -e

summary_json="$(grep -a '"type":"summary"' "$log_file" | tail -n 1 || true)"
if [ -z "$summary_json" ]; then
  log "run produced no summary event (exit=$run_status); see $log_file"
  printf '{"stamp":"%s","status":"failed","error":"no summary event","run_exit":%s,"log":"%s"}\n' \
    "$stamp" "$run_status" "$log_file" > "$result_file"
  exit 1
fi

read -r artifact_dir final_links run_state <<<"$("$NODE_BIN" -e '
const line = process.argv[1];
let event = {};
try { event = JSON.parse(line); } catch (error) { process.stderr.write(`summary unparsable: ${error.message}\n`); }
const counts = event.counts ?? {};
const final = Number(counts.final_links ?? 0);
process.stdout.write(`${event.artifact_dir ?? ""} ${Number.isFinite(final) ? final : 0} ${event.run_status ?? "unknown"}\n`);
' "$summary_json")"

if [ -z "$artifact_dir" ]; then
  log "summary carried no artifact_dir; see $log_file"
  exit 1
fi
if [ "$run_state" != "success" ]; then
  log "run finished with status=$run_state; deploy skipped"
  printf '{"stamp":"%s","status":"failed","run_status":"%s","artifact_dir":"%s","final_links":%s,"log":"%s"}\n' \
    "$stamp" "$run_state" "$artifact_dir" "$final_links" "$log_file" > "$result_file"
  exit 1
fi

log "run finished: artifact=$artifact_dir final_links=$final_links min_final_nodes=$min_final_nodes"

if [ "$final_links" -le "$min_final_nodes" ]; then
  log "final node count $final_links does not exceed $min_final_nodes; holding the current deployment"
  printf '{"stamp":"%s","status":"held","artifact_dir":"%s","final_links":%s,"min_final_nodes":%s,"duration_seconds":%s,"log":"%s"}\n' \
    "$stamp" "$artifact_dir" "$final_links" "$min_final_nodes" "$((SECONDS - total_started))" "$log_file" > "$result_file"
  exit 0
fi

log "deploying artifact $artifact_dir (final_links=$final_links > $min_final_nodes)"
# Summaries from the measurement run are already in this log; only what the
# deploy appends may decide the deploy outcome.
deploy_log_offset=$(( $(wc -c < "$log_file") + 1 ))
set +e
cli retry-stage --artifact-dir "$artifact_dir" --stage deploy --output jsonl 2>&1 | tee -a "$log_file" | grep --line-buffered -E '"(summary|run_failed|stage)"' >&2
deploy_status=${PIPESTATUS[0]}
set -e

deploy_summary="$(tail -c "+$deploy_log_offset" "$log_file" | grep -a '"type":"summary"' | tail -n 1 || true)"
deploy_state="$("$NODE_BIN" -e '
try { process.stdout.write(String(JSON.parse(process.argv[1]).run_status ?? "unknown")); } catch { process.stdout.write("unknown"); }
' "$deploy_summary" 2>/dev/null || echo unknown)"

if [ "$deploy_status" -ne 0 ] || [ "$deploy_state" != "success" ]; then
  log "deploy failed (exit=$deploy_status status=$deploy_state); see $log_file"
  printf '{"stamp":"%s","status":"deploy_failed","artifact_dir":"%s","final_links":%s,"min_final_nodes":%s,"deploy_exit":%s,"deploy_status":"%s","log":"%s"}\n' \
    "$stamp" "$artifact_dir" "$final_links" "$min_final_nodes" "$deploy_status" "$deploy_state" "$log_file" > "$result_file"
  exit 1
fi

log "deploy and subscription verification finished"
printf '{"stamp":"%s","status":"deployed","artifact_dir":"%s","final_links":%s,"min_final_nodes":%s,"duration_seconds":%s,"log":"%s"}\n' \
  "$stamp" "$artifact_dir" "$final_links" "$min_final_nodes" "$((SECONDS - total_started))" "$log_file" > "$result_file"
exit 0
