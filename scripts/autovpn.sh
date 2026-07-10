#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
autovpn_bin="$repo_root/npm/autovpn-cli/bin/autovpn.mjs"

if [[ ! -f "$autovpn_bin" ]]; then
  printf 'autovpn local CLI not found: %s\n' "$autovpn_bin" >&2
  printf 'Install dependencies and build the npm CLI first.\n' >&2
  exit 127
fi

export PATH="$HOME/.local/bin:$repo_root/node_modules/.bin:$PATH"
cd "$repo_root"

args=("$@")
has_project_root=0
for arg in "${args[@]}"; do
  case "$arg" in
    --project-root|--project-root=*)
      has_project_root=1
      break
      ;;
  esac
done

if ((${#args[@]} > 0)) && ((has_project_root == 0)); then
  case "${args[0]}" in
    -h|--help|--version)
      ;;
    *)
      args+=(--project-root "$repo_root")
      ;;
  esac
fi

exec node "$autovpn_bin" "${args[@]}"
