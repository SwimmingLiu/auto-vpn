#!/usr/bin/env bash
set -euo pipefail

repo_root=""
session_ref=""

while (($# > 0)); do
  case "$1" in
    --session)
      session_ref="${2:?missing session value}"
      shift 2
      ;;
    *)
      repo_root="$1"
      shift
      ;;
  esac
done

if [[ -z "$session_ref" ]]; then
  echo "usage: $0 --session <session_dir_or_id> [repo_root]" >&2
  exit 1
fi

if [[ -z "$repo_root" ]]; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

sessions_root="${VPN_AUTOMATION_LOGS_DIR:-$repo_root/artifacts/manual-runs}"
if [[ -d "$session_ref" ]]; then
  session_dir="$session_ref"
else
  session_dir="$sessions_root/$session_ref"
fi

if [[ ! -d "$session_dir" ]]; then
  echo "session dir not found: $session_dir" >&2
  exit 1
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

cmd=(
  "$python_cmd"
  "-m"
  "vpn_automation.backend"
  "resume-speedtest"
  "--project-root"
  "$repo_root"
  "--session"
  "$session_dir"
  "--output"
  "human"
)

printf 'Resume session: %s\n' "$session_dir"
printf 'Command:'
printf ' %q' "${cmd[@]}"
printf '\n'

export PYTHONPATH="$repo_root/src${PYTHONPATH:+:$PYTHONPATH}"
cd "$repo_root"
"${cmd[@]}"
