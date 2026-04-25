import json
import os
import subprocess
import time
from pathlib import Path

from vpn_automation.pipeline.run_store import RunStore


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "monitor_run.sh"


def test_monitor_run_once_reads_latest_sqlite_checkpoint(tmp_path: Path) -> None:
    repo_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = repo_root / "artifacts" / "20260423-010101"

    artifact_dir.mkdir(parents=True)
    store = RunStore(artifact_dir / "run.db")
    store.initialize(artifact_dir=str(artifact_dir))
    store.record_stage_event("doctor", "success")
    store.record_stage_event("extract", "running")
    store.record_source_progress(
        source_name="leiting",
        iteration=12,
        max_iterations=5000,
        new_links=1,
        raw_links=2,
        successful_iterations=12,
        failed_iterations=0,
    )
    store.record_raw_link("leiting", "vmess://first")
    store.record_raw_link("leiting", "vmess://second")
    store.record_speedtest_result(
        link="vmess://first",
        reachable=True,
        latency_ms=120.0,
        average_download_mb_s=3.2,
    )
    store.record_availability_result(
        link="vmess://first",
        provider="gemini",
        passed=True,
        reason="ok",
    )
    store.record_final_link(
        stage_name="postprocess",
        link="vmess://first",
        country_code="US",
    )
    store.record_extract_attempt(
        source_name="leiting",
        iteration=12,
        url="https://example.com/api?t=12",
        used_proxy=True,
        success=True,
        http_status=200,
        error_type="",
        error_message="",
        returned_links=1,
        new_links=1,
        total_links=2,
    )
    store.record_extract_attempt(
        source_name="heidong",
        iteration=13,
        url="https://example.com/api?t=13",
        used_proxy=True,
        success=False,
        http_status=0,
        error_type="SSLError",
        error_message="boom",
        returned_links=0,
        new_links=0,
        total_links=2,
    )

    result = subprocess.run(
        [str(SCRIPT_PATH), "--once", str(repo_root)],
        env={**os.environ, "TERM": "dumb"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Latest db:" in result.stdout
    assert "run.db" in result.stdout
    assert "Latest artifact dir:" in result.stdout
    assert "extract: running" in result.stdout
    assert "leiting: iter 12/5000 raw=2 new=1" in result.stdout
    assert "raw=2" in result.stdout
    assert "speedtest=1" in result.stdout
    assert "availability=1" in result.stdout
    assert "final=1" in result.stdout
    assert "Recent extract attempts:" in result.stdout
    assert "leiting iter=12 ok returned=1 new=1 total=2" in result.stdout
    assert "heidong iter=13 fail SSLError: boom" in result.stdout


def test_monitor_run_once_falls_back_to_session_event_log_and_warns_when_stale(tmp_path: Path) -> None:
    repo_root = tmp_path / "vpn-subscription-automation"
    sessions_dir = repo_root / "artifacts" / "manual-runs"
    session_dir = sessions_dir / "20260423-020202"
    artifact_dir = repo_root / "artifacts" / "20260423-020202"

    session_dir.mkdir(parents=True)
    artifact_dir.mkdir(parents=True)
    event_log = session_dir / "events.jsonl"
    (session_dir / "session.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(artifact_dir),
                "event_log": str(event_log),
                "human_log": str(session_dir / "human.log"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    event_log.write_text(
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

    stale_time = time.time() - 700
    os.utime(event_log, (stale_time, stale_time))

    result = subprocess.run(
        [str(SCRIPT_PATH), "--once", str(repo_root)],
        env={**os.environ, "TERM": "dumb", "VPN_AUTOMATION_STUCK_SECONDS": "600"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Latest session:" in result.stdout
    assert "20260423-020202" in result.stdout
    assert "leiting: iter 12/100000 raw=2 new=0 req_ok=1 req_fail=0 dec_ok=1 dec_fail=0" in result.stdout
    assert "xuanfeng-area: iter 40/100000 raw=15 new=1 req_ok=1 req_fail=1 dec_ok=1 dec_fail=0" in result.stdout
    assert "deduped=2" in result.stdout
    assert "Latest increase: xuanfeng-area iter 40/100000 raw=15 (+1)" in result.stdout
    assert "Warnings:" in result.stdout
    assert "stage extract looks stale" in result.stdout
