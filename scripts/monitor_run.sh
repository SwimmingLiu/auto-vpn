#!/usr/bin/env bash
set -euo pipefail

once=0
interval=5
repo_root=""
session_ref=""

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

if [[ -z "$repo_root" ]]; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

sessions_dir="${VPN_AUTOMATION_LOGS_DIR:-$repo_root/artifacts/manual-runs}"
artifacts_dir="${VPN_AUTOMATION_ARTIFACTS_DIR:-$repo_root/artifacts}"
stuck_seconds="${VPN_AUTOMATION_STUCK_SECONDS:-600}"

while true; do
  if [[ "$once" -eq 0 ]]; then
    printf '\033[2J\033[H'
  fi

  python3 - "$sessions_dir" "$artifacts_dir" "$stuck_seconds" "$session_ref" <<'PY'
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

sessions_dir = Path(sys.argv[1])
artifacts_dir = Path(sys.argv[2])
stuck_seconds = int(sys.argv[3])
session_ref = sys.argv[4]

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
source_order = ["leiting", "heidong", "mifeng", "xuanfeng-area", "xuanfeng-all-area"]


def count_non_empty(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8", errors="ignore").splitlines() if line.strip())


def resolve_session_dir() -> Path | None:
    if session_ref:
        candidate = Path(session_ref)
        if candidate.exists():
            return candidate
        named = sessions_dir / session_ref
        if named.exists():
            return named
        return None

    if not sessions_dir.exists():
        return None
    candidates = [path for path in sessions_dir.iterdir() if path.is_dir() and path.name != "latest"]
    if candidates:
        return sorted(candidates, key=lambda path: path.stat().st_mtime, reverse=True)[0]
    latest = sessions_dir / "latest"
    return latest.resolve() if latest.exists() else None


def latest_artifact_dir(root: Path) -> Path | None:
    if not root.exists():
        return None
    candidates = [path for path in root.iterdir() if path.is_dir() and re.fullmatch(r"\d{8}-\d{6}", path.name)]
    if not candidates:
        return None
    return sorted(candidates, key=lambda path: path.stat().st_mtime, reverse=True)[0]


session_dir = resolve_session_dir()
session_payload = {}
event_log_path = None
artifact_dir = None

if session_dir:
    session_json = session_dir / "session.json"
    if session_json.exists():
        session_payload = json.loads(session_json.read_text(encoding="utf-8"))
    event_log_path = Path(
        str(session_payload.get("event_log", session_dir / "events.jsonl"))
    ).resolve()
    artifact_value = str(session_payload.get("artifact_dir", "")).strip()
    if artifact_value:
        artifact_dir = Path(artifact_value).resolve()

if artifact_dir is None or not artifact_dir.exists():
    artifact_dir = latest_artifact_dir(artifacts_dir)

db_path = artifact_dir / "run.db" if artifact_dir else None
db_exists = bool(db_path and db_path.exists())

print(f"Latest db: {db_path if db_exists else 'N/A'}")
print(f"Latest session: {session_dir if session_dir else 'N/A'}")
print(f"Latest artifact dir: {artifact_dir if artifact_dir else 'N/A'}")

stage_status = {name: "pending" for name in stage_order}
source_progress: dict[str, dict[str, int]] = {}
source_stats: dict[str, dict[str, int]] = {}
recent_attempts: list[dict[str, object]] = []
counts = {
    "raw_links": 0,
    "deduped_links": 0,
    "speedtest_links": 0,
    "availability_links": 0,
    "postprocess_links": 0,
    "final_links": 0,
}
source_counts: dict[str, dict[str, int | str]] = {}
latest_increase: dict[str, int | str] | None = None
warnings: list[str] = []
recent_logs: list[str] = []
speedtest = {"probe_completed": 0, "probe_total": 0, "full_completed": 0, "full_total": 0, "passed": 0}
availability = {"completed": 0, "total": 0, "passed": 0}
run_status = "unknown"
run_error = ""

if artifact_dir:
    report_path = artifact_dir / "pipeline_report.json"
    if report_path.exists():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        run_status = str(report.get("run_status", run_status))
        run_error = str(report.get("error", run_error))
        stage_status.update(report.get("stage_status", {}))
        source_counts = dict(report.get("source_counts", {}))
        for key, value in (report.get("counts") or {}).items():
            counts[key] = int(value)

if db_exists:
    with sqlite3.connect(db_path) as connection:
        for stage_name, status in connection.execute(
            "SELECT stage_name, status FROM stage_events ORDER BY rowid ASC"
        ):
            stage_status[str(stage_name)] = str(status)

        for row in connection.execute(
            """
            SELECT source_name, iteration, max_iterations, new_links, raw_links,
                   successful_iterations, failed_iterations
            FROM source_progress
            ORDER BY source_name ASC
            """
        ):
            source_name, iteration, max_iterations, new_links, raw_links, successful_iterations, failed_iterations = row
            source_progress[str(source_name)] = {
                "iter": int(iteration),
                "max": int(max_iterations),
                "new": int(new_links),
                "raw": int(raw_links),
            }
            source_counts.setdefault(
                str(source_name),
                {
                    "raw_links": int(raw_links),
                    "successful_iterations": int(successful_iterations),
                    "failed_iterations": int(failed_iterations),
                    "requested_iterations": int(max_iterations),
                },
            )
            if int(new_links) > 0:
                latest_increase = {
                    "source": str(source_name),
                    "iter": int(iteration),
                    "max": int(max_iterations),
                    "new": int(new_links),
                    "raw": int(raw_links),
                }

        counts["raw_links"] = int(connection.execute("SELECT COUNT(*) FROM raw_links").fetchone()[0])
        counts["speedtest_links"] = int(connection.execute("SELECT COUNT(*) FROM speedtest_results").fetchone()[0])
        counts["availability_links"] = int(connection.execute("SELECT COUNT(*) FROM availability_results").fetchone()[0])
        counts["final_links"] = int(connection.execute("SELECT COUNT(*) FROM final_links").fetchone()[0])
        counts["postprocess_links"] = counts["final_links"]

        for source_name, success_count, fail_count in connection.execute(
            """
            SELECT source_name,
                   SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS req_ok,
                   SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS req_fail
            FROM extract_attempts
            GROUP BY source_name
            """
        ):
            source_stats[str(source_name)] = {
                "req_ok": int(success_count or 0),
                "req_fail": int(fail_count or 0),
                "dec_ok": 0,
                "dec_fail": 0,
            }

        for row in connection.execute(
            """
            SELECT source_name, iteration, success, error_type, error_message,
                   returned_links, new_links, total_links
            FROM extract_attempts
            ORDER BY rowid DESC
            LIMIT 10
            """
        ):
            source_name, iteration, success, error_type, error_message, returned_links, new_links, total_links = row
            recent_attempts.append(
                {
                    "source_name": str(source_name),
                    "iteration": int(iteration),
                    "success": bool(success),
                    "error_type": str(error_type),
                    "error_message": str(error_message),
                    "returned_links": int(returned_links),
                    "new_links": int(new_links),
                    "total_links": int(total_links),
                }
            )

if event_log_path and event_log_path.exists():
    for line in event_log_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        event_type = str(payload.get("type", ""))

        if event_type == "run_started" and (artifact_dir is None or not artifact_dir.exists()):
            artifact_value = str(payload.get("artifact_dir", "")).strip()
            if artifact_value:
                artifact_dir = Path(artifact_value)
        elif event_type == "stage" and not db_exists:
            stage_status[str(payload.get("stage", ""))] = str(payload.get("status", "pending"))
        elif event_type == "summary":
            run_status = str(payload.get("run_status", run_status))
            run_error = str(payload.get("error", run_error))
            if not db_exists:
                stage_status.update(payload.get("stage_status", {}))
            source_counts.update(payload.get("source_counts", {}))
            for key, value in (payload.get("counts") or {}).items():
                counts[key] = int(value)
        elif event_type == "run_failed":
            run_status = "failed"
            run_error = str(payload.get("error", run_error))
        elif event_type == "log":
            recent_logs.append(str(payload.get("message", "")))
            recent_logs = recent_logs[-6:]
        elif event_type == "extract_request_result":
            source = str(payload.get("source_name", "unknown"))
            stats = source_stats.setdefault(source, {"req_ok": 0, "req_fail": 0, "dec_ok": 0, "dec_fail": 0})
            if payload.get("success"):
                stats["req_ok"] += 1
            else:
                stats["req_fail"] += 1
        elif event_type == "extract_decrypt_result":
            source = str(payload.get("source_name", "unknown"))
            stats = source_stats.setdefault(source, {"req_ok": 0, "req_fail": 0, "dec_ok": 0, "dec_fail": 0})
            if payload.get("success"):
                stats["dec_ok"] += 1
            else:
                stats["dec_fail"] += 1
        elif event_type == "extract_iteration" and not db_exists:
            source = str(payload.get("source_name", "unknown"))
            item = {
                "iter": int(payload.get("iteration", 0)),
                "max": int(payload.get("requested_iterations", 0)),
                "new": int(payload.get("new_items", 0)),
                "raw": int(payload.get("total_links", 0)),
            }
            source_progress[source] = item
            if item["new"] > 0:
                latest_increase = {"source": source, **item}
        elif event_type == "speedtest_probe_result":
            speedtest["probe_completed"] = int(payload.get("completed", speedtest["probe_completed"]))
            speedtest["probe_total"] = int(payload.get("total", speedtest["probe_total"]))
        elif event_type == "speedtest_selected":
            speedtest["full_total"] = int(payload.get("candidate_count", speedtest["full_total"]))
        elif event_type == "speedtest_result":
            speedtest["full_completed"] = int(payload.get("completed", speedtest["full_completed"]))
            speedtest["full_total"] = int(payload.get("total", speedtest["full_total"]))
            if payload.get("passed_threshold"):
                speedtest["passed"] += 1
        elif event_type == "availability_link_result":
            availability["completed"] = int(payload.get("completed", availability["completed"]))
            availability["total"] = int(payload.get("total", availability["total"]))
            if payload.get("all_passed"):
                availability["passed"] += 1

if artifact_dir:
    counts["deduped_links"] = counts["deduped_links"] or count_non_empty(artifact_dir / "vpn_node_deduped.txt")
    counts["raw_links"] = counts["raw_links"] or count_non_empty(artifact_dir / "vpn_node_raw.txt")
    counts["speedtest_links"] = counts["speedtest_links"] or count_non_empty(artifact_dir / "vpn_node_speedtest.txt")
    counts["availability_links"] = counts["availability_links"] or count_non_empty(artifact_dir / "vpn_node_availability.txt")
    final_count = count_non_empty(artifact_dir / "vpn_node_emoji.txt")
    counts["postprocess_links"] = counts["postprocess_links"] or final_count
    counts["final_links"] = counts["final_links"] or final_count

running_stages = [stage for stage, status in stage_status.items() if status == "running"]
freshness_target = None
if event_log_path and event_log_path.exists():
    freshness_target = event_log_path
elif db_exists:
    freshness_target = db_path
if freshness_target and running_stages:
    age_seconds = max(0, int(time.time() - freshness_target.stat().st_mtime))
    if age_seconds >= stuck_seconds:
        warnings.append(f"stage {running_stages[-1]} looks stale ({age_seconds}s since latest update)")

print()
print(f"Run status: {run_status}")
if run_error:
    print(f"Run error: {run_error}")

print()
print("Stage status:")
for stage in stage_order:
    print(f"  {stage}: {stage_status.get(stage, 'pending')}")

print()
print("Source extract progress:")
for source in source_order:
    if source in source_progress:
        item = source_progress[source]
        stats = source_stats.setdefault(source, {"req_ok": 0, "req_fail": 0, "dec_ok": 0, "dec_fail": 0})
        suffix = (
            f" req_ok={stats['req_ok']} req_fail={stats['req_fail']}"
            f" dec_ok={stats['dec_ok']} dec_fail={stats['dec_fail']}"
        )
        print(
            f"  {source}: iter {item['iter']}/{item['max']} raw={item['raw']} new={item['new']}{suffix}"
        )
    elif source in source_counts:
        item = source_counts[source]
        stats = source_stats.setdefault(source, {"req_ok": 0, "req_fail": 0, "dec_ok": 0, "dec_fail": 0})
        extras = ""
        if any(stats.values()):
            extras = (
                f" req_ok={stats['req_ok']} req_fail={stats['req_fail']}"
                f" dec_ok={stats['dec_ok']} dec_fail={stats['dec_fail']}"
            )
        requested_iterations = int(item.get("requested_iterations", 0) or 0)
        if requested_iterations:
            print(
                f"  {source}: iter {int(item.get('successful_iterations', 0))}/{requested_iterations} "
                f"raw={int(item.get('raw_links', 0))} new={int(item.get('new_links', 0) or 0)}{extras}"
            )
        else:
            print(f"  {source}: raw={int(item.get('raw_links', 0))}{extras}")
    else:
        print(f"  {source}: no data")

if latest_increase:
    print()
    print(
        "Latest increase: "
        f"{latest_increase['source']} iter {latest_increase['iter']}/{latest_increase['max']} "
        f"raw={latest_increase['raw']} (+{latest_increase['new']})"
    )

print()
print("Stage counts:")
print(f"  raw={counts['raw_links']}")
print(f"  deduped={counts['deduped_links']}")
print(f"  speedtest={counts['speedtest_links']}")
print(f"  availability={counts['availability_links']}")
print(f"  postprocess={counts['postprocess_links']}")
print(f"  final={counts['final_links']}")

print()
print("Speedtest progress:")
print(
    f"  probe={speedtest['probe_completed']}/{speedtest['probe_total']} "
    f"full={speedtest['full_completed']}/{speedtest['full_total']} passed={speedtest['passed']}"
)

print()
print("Availability progress:")
print(
    f"  checked={availability['completed']}/{availability['total']} passed={availability['passed']}"
)

print()
print("Recent extract attempts:")
if recent_attempts:
    for item in reversed(recent_attempts):
        if item["success"]:
            print(
                f"  {item['source_name']} iter={item['iteration']} ok "
                f"returned={item['returned_links']} new={item['new_links']} total={item['total_links']}"
            )
        else:
            print(
                f"  {item['source_name']} iter={item['iteration']} fail "
                f"{item['error_type']}: {item['error_message']}"
            )
else:
    print("  no data")

if recent_logs:
    print()
    print("Recent logs:")
    for message in recent_logs[-6:]:
        print(f"  {message}")

if warnings:
    print()
    print("Warnings:")
    for warning in warnings:
        print(f"  - {warning}")
PY

  if [[ "$once" -eq 1 ]]; then
    break
  fi

  sleep "$interval"
done
