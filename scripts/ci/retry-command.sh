#!/usr/bin/env bash
set -euo pipefail

label="${1:-}"
if [[ -z "${label}" || "${2:-}" != "--" ]]; then
  echo "Usage: $0 <label> -- <command> [args...]" >&2
  exit 2
fi
shift 2

attempts="${AUTOVPN_CI_RETRIES:-5}"
base_sleep="${AUTOVPN_CI_RETRY_BASE_SECONDS:-20}"
max_sleep="${AUTOVPN_CI_RETRY_MAX_SECONDS:-180}"

if [[ "${attempts}" -lt 1 ]]; then
  echo "AUTOVPN_CI_RETRIES must be at least 1." >&2
  exit 2
fi

status=0
for attempt in $(seq 1 "${attempts}"); do
  echo "::group::${label} attempt ${attempt}/${attempts}"
  set +e
  "$@"
  status=$?
  set -e
  echo "::endgroup::"

  if [[ "${status}" -eq 0 ]]; then
    exit 0
  fi

  if [[ "${attempt}" -eq "${attempts}" ]]; then
    echo "${label} failed after ${attempts} attempts." >&2
    exit "${status}"
  fi

  if [[ "${1:-}" == "npm" ]]; then
    npm cache verify || true
  fi

  sleep_seconds=$(( base_sleep * (2 ** (attempt - 1)) ))
  if [[ "${sleep_seconds}" -gt "${max_sleep}" ]]; then
    sleep_seconds="${max_sleep}"
  fi
  jitter=$(( RANDOM % 10 ))
  sleep_seconds=$(( sleep_seconds + jitter ))
  echo "${label} failed with exit code ${status}; retrying in ${sleep_seconds} seconds."
  sleep "${sleep_seconds}"
done
