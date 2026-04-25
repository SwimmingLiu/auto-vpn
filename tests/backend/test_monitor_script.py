import os
import subprocess
import time
from pathlib import Path
import json


def test_monitor_run_once_reports_latest_session_and_extract_counters(tmp_path: Path) -> None:
    repo_root = tmp_path / "vpn-subscription-automation"
    sessions_dir = repo_root / "artifacts" / "manual-runs"
    session_dir = sessions_dir / "20260423-010101"
    artifact_dir = repo_root / "artifacts" / "20260423-010101"
    script_path = Path("/Users/swimmingliu/data/VPN/vpn-subscription-automation/scripts/monitor_run.sh")

    session_dir.mkdir(parents=True)
    artifact_dir.mkdir(parents=True)

    (session_dir / "session.json").write_text(
        json.dumps(
            {
                "repo_root": str(repo_root),
                "artifact_dir": str(artifact_dir),
                "event_log": str(session_dir / "events.jsonl"),
                "human_log": str(session_dir / "human.log"),
                "skip_deploy": True,
                "skip_verify": True,
                "mode": "real",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (session_dir / "events.jsonl").write_text(
        "\n".join(
            [
                json.dumps({"type": "run_started", "artifact_dir": str(artifact_dir)}, ensure_ascii=False),
                json.dumps({"type": "stage", "stage": "doctor", "status": "success"}, ensure_ascii=False),
                json.dumps({"type": "stage", "stage": "extract", "status": "running"}, ensure_ascii=False),
                json.dumps({"type": "extract_request_result", "source_name": "leiting", "iteration": 12, "success": True, "via": "direct"}, ensure_ascii=False),
                json.dumps({"type": "extract_decrypt_result", "source_name": "leiting", "iteration": 12, "success": True}, ensure_ascii=False),
                json.dumps({"type": "extract_iteration", "source_name": "leiting", "iteration": 12, "requested_iterations": 100000, "new_items": 0, "total_links": 2}, ensure_ascii=False),
                json.dumps({"type": "extract_request_result", "source_name": "xuanfeng-area", "iteration": 40, "success": False, "via": "direct", "error": "timeout"}, ensure_ascii=False),
                json.dumps({"type": "extract_request_result", "source_name": "xuanfeng-area", "iteration": 40, "success": True, "via": "upstream_proxy"}, ensure_ascii=False),
                json.dumps({"type": "extract_decrypt_result", "source_name": "xuanfeng-area", "iteration": 40, "success": True}, ensure_ascii=False),
                json.dumps({"type": "extract_iteration", "source_name": "xuanfeng-area", "iteration": 40, "requested_iterations": 100000, "new_items": 1, "total_links": 15}, ensure_ascii=False),
            ]
        ),
        encoding="utf-8",
    )

    (artifact_dir / "vpn_node_raw.txt").write_text("a\nb\nc\n", encoding="utf-8")
    (artifact_dir / "vpn_node_deduped.txt").write_text("a\nb\n", encoding="utf-8")
    (artifact_dir / "vpn_node_speedtest.txt").write_text("a\n", encoding="utf-8")
    (artifact_dir / "vpn_node_availability.txt").write_text("", encoding="utf-8")
    (artifact_dir / "vpn_node_emoji.txt").write_text("", encoding="utf-8")

    result = subprocess.run(
        [str(script_path), "--once", str(repo_root)],
        env={**os.environ, "TERM": "dumb"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Latest session:" in result.stdout
    assert "20260423-010101" in result.stdout
    assert "Artifact dir:" in result.stdout
    assert "20260423-010101" in result.stdout
    assert "extract: running" in result.stdout
    assert "leiting: iter 12/100000 raw=2 new=0 req_ok=1 req_fail=0 dec_ok=1 dec_fail=0" in result.stdout
    assert "xuanfeng-area: iter 40/100000 raw=15 new=1 req_ok=1 req_fail=1 dec_ok=1 dec_fail=0" in result.stdout
    assert "raw=3" in result.stdout
    assert "deduped=2" in result.stdout
    assert "speedtest=1" in result.stdout
    assert "Latest increase: xuanfeng-area iter 40/100000 raw=15 (+1)" in result.stdout


def test_monitor_run_once_warns_when_running_stage_looks_stale(tmp_path: Path) -> None:
    repo_root = tmp_path / "vpn-subscription-automation"
    sessions_dir = repo_root / "artifacts" / "manual-runs"
    session_dir = sessions_dir / "20260423-020202"
    script_path = Path("/Users/swimmingliu/data/VPN/vpn-subscription-automation/scripts/monitor_run.sh")

    session_dir.mkdir(parents=True)
    event_log = session_dir / "events.jsonl"
    (session_dir / "session.json").write_text(
        json.dumps(
            {
                "repo_root": str(repo_root),
                "artifact_dir": "",
                "event_log": str(event_log),
                "human_log": str(session_dir / "human.log"),
                "skip_deploy": True,
                "skip_verify": True,
                "mode": "real",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    event_log.write_text(
        "\n".join(
            [
                json.dumps({"type": "stage", "stage": "doctor", "status": "success"}, ensure_ascii=False),
                json.dumps({"type": "stage", "stage": "extract", "status": "running"}, ensure_ascii=False),
                json.dumps({"type": "extract_iteration", "source_name": "leiting", "iteration": 12, "requested_iterations": 100000, "new_items": 0, "total_links": 2}, ensure_ascii=False),
            ]
        ),
        encoding="utf-8",
    )
    stale_time = time.time() - 700
    os.utime(event_log, (stale_time, stale_time))

    result = subprocess.run(
        [str(script_path), "--once", str(repo_root)],
        env={**os.environ, "TERM": "dumb", "VPN_AUTOMATION_STUCK_SECONDS": "600"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Warnings:" in result.stdout
    assert "stage extract looks stale" in result.stdout
