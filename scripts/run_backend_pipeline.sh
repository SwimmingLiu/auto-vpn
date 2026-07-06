#!/usr/bin/env bash
set -euo pipefail

dry_run=0
skip_deploy=1
skip_verify=1
proxy=0
proxy_url=""
repo_root=""
session_id=""

while (($# > 0)); do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --with-deploy)
      skip_deploy=0
      shift
      ;;
    --with-verify)
      skip_verify=0
      shift
      ;;
    --proxy)
      proxy=1
      if [[ $# -gt 1 && "$2" != --* ]]; then
        proxy_url="$2"
        shift 2
      else
        shift
      fi
      ;;
    --session-id)
      session_id="${2:?missing session id}"
      shift 2
      ;;
    *)
      repo_root="$1"
      shift
      ;;
  esac
done

if [[ -z "$repo_root" ]]; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

manual_runs_root="${VPN_AUTOMATION_LOGS_DIR:-$repo_root/artifacts/manual-runs}"
mkdir -p "$manual_runs_root"

if [[ -z "$session_id" ]]; then
  session_id="$(date '+%Y%m%d-%H%M%S')"
fi

session_dir="$manual_runs_root/$session_id"
mkdir -p "$session_dir"

event_log="$session_dir/events.jsonl"
human_log="$session_dir/human.log"
session_json="$session_dir/session.json"
mode="real"

if ((dry_run)); then
  mode="dry-run"
fi

resolve_python() {
  local root="$1"
  local candidates=(
    "$root/.venv/bin/python"
    "$root/.venv/bin/python3"
    "python3.12"
    "python3"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ "$candidate" == /* ]]; then
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
      continue
    fi
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

python_cmd="$(resolve_python "$repo_root")"

printf '{\n' >"$session_json"
printf '  "repo_root": "%s",\n' "$repo_root" >>"$session_json"
printf '  "session_id": "%s",\n' "$session_id" >>"$session_json"
printf '  "artifact_dir": "",\n' >>"$session_json"
printf '  "event_log": "%s",\n' "$event_log" >>"$session_json"
printf '  "human_log": "%s",\n' "$human_log" >>"$session_json"
printf '  "skip_deploy": %s,\n' "$([[ "$skip_deploy" -eq 1 ]] && printf 'true' || printf 'false')" >>"$session_json"
printf '  "skip_verify": %s,\n' "$([[ "$skip_verify" -eq 1 ]] && printf 'true' || printf 'false')" >>"$session_json"
printf '  "mode": "%s"\n' "$mode" >>"$session_json"
printf '}\n' >>"$session_json"

cmd=(
  "$python_cmd"
  "-m"
  "vpn_automation.backend"
  "run"
  "--project-root"
  "$repo_root"
  "--output"
  "human"
  "--event-log"
  "$event_log"
  "--human-log"
  "$human_log"
)

if ((skip_deploy)); then
  cmd+=(--skip-deploy)
fi
if ((skip_verify)); then
  cmd+=(--skip-verify)
fi
if ((proxy)); then
  cmd+=(--proxy)
  if [[ -n "$proxy_url" ]]; then
    cmd+=("$proxy_url")
  fi
fi

printf 'Session dir: %s\n' "$session_dir"
printf 'Event log: %s\n' "$event_log"
printf 'Human log: %s\n' "$human_log"
printf 'Monitor command: %s --once %s\n' "$repo_root/scripts/monitor_run.sh" "$repo_root"
printf 'Command:'
printf ' %q' "${cmd[@]}"
printf '\n'

if ((dry_run)); then
  exit 0
fi

export PYTHONPATH="$repo_root/src${PYTHONPATH:+:$PYTHONPATH}"
cd "$repo_root"
"${cmd[@]}"
