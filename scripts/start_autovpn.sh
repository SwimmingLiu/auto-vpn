#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
autovpn_bin="$repo_root/.venv/bin/autovpn"
deploy=1
verify=1
logs_root="$repo_root/artifacts/start-runs"
run_id="$(date '+%Y%m%d-%H%M%S')"

usage() {
  cat <<'EOF'
Usage: scripts/start_autovpn.sh [options]

Checks AutoVPN first, then starts a run while streaming output to the terminal
and saving complete logs under artifacts/start-runs/<run-id>/.

Options:
  --local            Generate locally only; skip deploy and verify.
  --deploy           Run full deploy and verify flow. This is the default.
  --verify           Run full deploy and verify flow. This is the default.
  --logs-dir DIR     Write logs under DIR instead of artifacts/start-runs.
  --run-id ID        Use a fixed run id instead of the current timestamp.
  -h, --help         Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --deploy)
      deploy=1
      verify=1
      shift
      ;;
    --verify)
      deploy=1
      verify=1
      shift
      ;;
    --local)
      deploy=0
      verify=0
      shift
      ;;
    --logs-dir)
      logs_root="${2:?missing logs dir}"
      shift 2
      ;;
    --run-id)
      run_id="${2:?missing run id}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$autovpn_bin" ]]; then
  printf 'autovpn local CLI not found: %s\n' "$autovpn_bin" >&2
  printf 'Create the local environment first, then run this script again.\n' >&2
  exit 127
fi

export PATH="$HOME/.local/bin:$repo_root/node_modules/.bin:$PATH"
cd "$repo_root"

run_dir="$logs_root/$run_id"
mkdir -p "$run_dir"

doctor_log="$run_dir/doctor.json"
deploy_doctor_log="$run_dir/deploy-doctor.json"
profile_log="$run_dir/profile-summary.json"
jobs_log="$run_dir/jobs-before.json"
run_log="$run_dir/run.jsonl"
summary_log="$run_dir/summary.txt"

run_and_log() {
  local log_path="$1"
  shift
  "$@" 2>&1 | tee "$log_path"
  return "${PIPESTATUS[0]}"
}

printf 'AutoVPN start run\n' | tee "$summary_log"
printf 'Run id: %s\n' "$run_id" | tee -a "$summary_log"
printf 'Run dir: %s\n' "$run_dir" | tee -a "$summary_log"
printf 'Mode: %s\n' "$([[ "$deploy" -eq 1 ]] && printf 'deploy' || printf 'local')" | tee -a "$summary_log"
printf 'Project root: %s\n\n' "$repo_root" | tee -a "$summary_log"

printf '[1/4] Running normal preflight...\n'
if ! run_and_log "$doctor_log" "$autovpn_bin" doctor --project-root "$repo_root" --output json; then
  printf 'Normal preflight failed. See: %s\n' "$doctor_log" >&2
  exit 1
fi

if ((deploy)); then
  printf '\n[2/4] Running strict deploy preflight...\n'
  if ! run_and_log "$deploy_doctor_log" "$autovpn_bin" doctor --project-root "$repo_root" --deploy --strict --output json; then
    printf 'Deploy preflight failed. See: %s\n' "$deploy_doctor_log" >&2
    printf 'Tip: run with --local to generate locally without Cloudflare deployment.\n' >&2
    exit 1
  fi
else
  printf '\n[2/4] Skipping strict deploy preflight for local generation mode.\n'
fi

printf '\n[3/4] Capturing safe profile and job summaries...\n'
run_and_log "$profile_log" "$autovpn_bin" profile summary --project-root "$repo_root" --json
run_and_log "$jobs_log" "$autovpn_bin" jobs list --project-root "$repo_root" --json

run_cmd=("$autovpn_bin" run --project-root "$repo_root")
if ((!deploy)); then
  run_cmd+=(--skip-deploy --skip-verify)
elif ((!verify)); then
  run_cmd+=(--skip-verify)
fi
run_cmd+=(--output jsonl)

printf '\n[4/4] Starting AutoVPN. Streaming full output and saving logs...\n'
printf 'Run log: %s\n' "$run_log"
printf 'Profile summary: %s\n' "$profile_log"
printf 'Jobs before run: %s\n' "$jobs_log"
printf 'Command:' | tee -a "$summary_log"
printf ' %q' "${run_cmd[@]}" | tee -a "$summary_log"
printf '\n\n' | tee -a "$summary_log"

set +e
"${run_cmd[@]}" 2>&1 | tee "$run_log"
run_status="${PIPESTATUS[0]}"
set -e

printf '\nExit status: %s\n' "$run_status" | tee -a "$summary_log"
printf 'Finished at: %s\n' "$(date -Is)" | tee -a "$summary_log"
printf 'Logs saved in: %s\n' "$run_dir" | tee -a "$summary_log"

exit "$run_status"
