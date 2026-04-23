#!/usr/bin/env bash
set -euo pipefail

once=0
interval=5
repo_root=""

while (($# > 0)); do
  case "$1" in
    --once)
      once=1
      shift
      ;;
    --interval)
      interval="${2:?missing interval value}"
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

artifacts_dir="${VPN_AUTOMATION_ARTIFACTS_DIR:-$repo_root/artifacts}"

while true; do
  if [[ "$once" -eq 0 ]]; then
    printf '\033[2J\033[H'
  fi

  python3 - "$artifacts_dir" <<'PY'
import re
import sqlite3
import sys
from pathlib import Path

artifacts_dir = Path(sys.argv[1])
stage_order = [
    "doctor",
    "extract",
    "dedupe",
    "speedtest",
    "availability",
    "postprocess",
    "render",
    "obfuscate",
    "deploy",
    "verify",
]


def latest_artifact_dir(root: Path) -> Path | None:
    if not root.exists():
        return None
    candidates = [path for path in root.iterdir() if path.is_dir() and re.fullmatch(r"\d{8}-\d{6}", path.name)]
    if not candidates:
        return None
    return sorted(candidates, key=lambda path: path.stat().st_mtime, reverse=True)[0]


artifact_dir = latest_artifact_dir(artifacts_dir)
db_path = artifact_dir / "run.db" if artifact_dir else None

print(f"Latest db: {db_path if db_path and db_path.exists() else 'N/A'}")
print(f"Latest artifact dir: {artifact_dir if artifact_dir else 'N/A'}")

stage_status = {name: "pending" for name in stage_order}
source_progress = {}
recent_attempts = []
counts = {
    "raw": 0,
    "speedtest": 0,
    "availability": 0,
    "final": 0,
}

if db_path and db_path.exists():
    with sqlite3.connect(db_path) as connection:
        for stage_name, status in connection.execute(
            "SELECT stage_name, status FROM stage_events ORDER BY rowid ASC"
        ):
            stage_status[stage_name] = status

        for row in connection.execute(
            """
            SELECT source_name, iteration, max_iterations, new_links, raw_links
            FROM source_progress
            ORDER BY source_name ASC
            """
        ):
            source_name, iteration, max_iterations, new_links, raw_links = row
            source_progress[source_name] = {
                "iteration": iteration,
                "max_iterations": max_iterations,
                "new_links": new_links,
                "raw_links": raw_links,
            }

        counts["raw"] = connection.execute("SELECT COUNT(*) FROM raw_links").fetchone()[0]
        counts["speedtest"] = connection.execute("SELECT COUNT(*) FROM speedtest_results").fetchone()[0]
        counts["availability"] = connection.execute("SELECT COUNT(*) FROM availability_results").fetchone()[0]
        counts["final"] = connection.execute("SELECT COUNT(*) FROM final_links").fetchone()[0]
        for row in connection.execute(
            """
            SELECT source_name, iteration, success, error_type, error_message,
                   returned_links, new_links, total_links
            FROM extract_attempts
            ORDER BY rowid DESC
            LIMIT 10
            """
        ):
            recent_attempts.append(row)

print()
print("Stage status:")
for stage in stage_order:
    print(f"  {stage}: {stage_status[stage]}")

print()
print("Source extract progress:")
if source_progress:
    for source_name in sorted(source_progress):
        row = source_progress[source_name]
        print(
            f"  {source_name}: iter {row['iteration']}/{row['max_iterations']} "
            f"raw={row['raw_links']} new={row['new_links']}"
        )
else:
    print("  no data")

print()
print("Stage counts:")
print(f"  raw={counts['raw']}")
print(f"  speedtest={counts['speedtest']}")
print(f"  availability={counts['availability']}")
print(f"  final={counts['final']}")

print()
print("Recent extract attempts:")
if recent_attempts:
    for source_name, iteration, success, error_type, error_message, returned_links, new_links, total_links in reversed(recent_attempts):
        if success:
            print(
                f"  {source_name} iter={iteration} ok "
                f"returned={returned_links} new={new_links} total={total_links}"
            )
        else:
            print(f"  {source_name} iter={iteration} fail {error_type}: {error_message}")
else:
    print("  no data")
PY

  if [[ "$once" -eq 1 ]]; then
    break
  fi

  sleep "$interval"
done
