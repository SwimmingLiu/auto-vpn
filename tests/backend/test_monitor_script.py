import os
import subprocess
from pathlib import Path

from vpn_automation.pipeline.run_store import RunStore


def test_monitor_run_once_reads_latest_sqlite_checkpoint(tmp_path: Path) -> None:
    repo_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = repo_root / "artifacts" / "20260423-010101"
    script_path = Path(
        "/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/sqlite-checkpoints-proxy/scripts/monitor_run.sh"
    )

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

    result = subprocess.run(
        [str(script_path), "--once", str(repo_root)],
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
