import os
import sqlite3
from pathlib import Path

from vpn_automation.pipeline.run_store import RunStore
from vpn_automation.pipeline.vmess import generate_vmess_link


def test_run_store_creates_schema(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "run.db")

    store.initialize(artifact_dir=str(tmp_path / "artifacts"))

    assert (tmp_path / "run.db").exists()
    assert store.fetch_stage_status()["doctor"] == "pending"

    with sqlite3.connect(tmp_path / "run.db") as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }

    assert {
        "runs",
        "stage_events",
        "source_progress",
        "raw_links",
        "extract_attempts",
        "speedtest_results",
        "availability_results",
        "final_links",
    } <= tables


def test_run_store_records_progress_and_raw_links(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "run.db")
    store.initialize(artifact_dir=str(tmp_path / "artifacts"))

    store.record_source_progress(
        source_name="leiting",
        iteration=3,
        max_iterations=5000,
        new_links=1,
        raw_links=2,
        successful_iterations=3,
        failed_iterations=0,
    )
    store.record_raw_link("leiting", "vmess://first")
    store.record_raw_link("leiting", "vmess://second")
    store.record_raw_link("leiting", "vmess://second")

    assert store.fetch_source_progress()["leiting"]["raw_links"] == 2
    assert store.count_links("raw_links") == 2


def test_record_raw_link_returns_false_for_duplicate(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "run.db")
    store.initialize(artifact_dir=str(tmp_path / "artifacts"))

    assert store.record_raw_link("leiting", "vmess://first") is True
    assert store.record_raw_link("leiting", "vmess://first") is False
    assert store.count_links("raw_links") == 1


def test_run_store_dedupes_raw_links_by_canonical_key_across_sources(tmp_path: Path) -> None:
    first = generate_vmess_link(
        {
            "v": "2",
            "ps": "US first",
            "add": "1.1.1.1",
            "port": "443",
            "id": "418048af-a293-4b99-9b0c-98ca3580dd24",
            "aid": "0",
            "scy": "auto",
            "net": "ws",
            "type": "dtls",
            "host": "example.com",
            "path": "/node",
            "tls": "tls",
            "sni": "example.com",
        }
    )
    duplicate = generate_vmess_link(
        {
            "v": "2",
            "ps": "US duplicate display name",
            "add": "1.1.1.1",
            "port": "443",
            "id": "418048af-a293-4b99-9b0c-98ca3580dd24",
            "aid": "0",
            "scy": "auto",
            "net": "ws",
            "type": "dtls",
            "host": "example.com",
            "path": "/node",
            "tls": "tls",
            "sni": "example.com",
        }
    )
    store = RunStore(tmp_path / "run.db")
    store.initialize(artifact_dir=str(tmp_path / "artifacts"))

    assert store.record_raw_link("leiting", first) is True
    assert store.record_raw_link("heidong", duplicate) is False

    assert store.count_links("raw_links") == 1


def test_run_store_records_extract_attempts(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "run.db")
    store.initialize(artifact_dir=str(tmp_path / "artifacts"))

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

    attempts = store.fetch_recent_extract_attempts(limit=5)

    assert attempts == [
        {
            "source_name": "leiting",
            "iteration": 12,
            "url": "https://example.com/api?t=12",
            "used_proxy": True,
            "success": True,
            "http_status": 200,
            "error_type": "",
            "error_message": "",
            "returned_links": 1,
            "new_links": 1,
            "total_links": 2,
        }
    ]


def test_run_store_finds_latest_incomplete_run(tmp_path: Path) -> None:
    artifacts_root = tmp_path / "artifacts"
    first_dir = artifacts_root / "20260423-010101"
    second_dir = artifacts_root / "20260423-020202"
    first_dir.mkdir(parents=True)
    second_dir.mkdir(parents=True)

    first = RunStore(first_dir / "run.db")
    first.initialize(artifact_dir=str(first_dir))
    first.record_stage_event("verify", "success")

    second = RunStore(second_dir / "run.db")
    second.initialize(artifact_dir=str(second_dir))
    second.record_stage_event("extract", "running")

    latest = RunStore.find_latest_incomplete_run(artifacts_root)

    assert latest == second_dir / "run.db"


def test_run_store_ignores_failed_runs_when_resuming_latest(tmp_path: Path) -> None:
    artifacts_root = tmp_path / "artifacts"
    failed_dir = artifacts_root / "20260423-010101"
    running_dir = artifacts_root / "20260423-020202"
    failed_dir.mkdir(parents=True)
    running_dir.mkdir(parents=True)

    failed = RunStore(failed_dir / "run.db")
    failed.initialize(artifact_dir=str(failed_dir))
    failed.mark_run_status("failed")

    running = RunStore(running_dir / "run.db")
    running.initialize(artifact_dir=str(running_dir))
    running.record_stage_event("availability", "running")

    latest = RunStore.find_latest_incomplete_run(artifacts_root)

    assert latest == running_dir / "run.db"


def test_find_latest_artifact_dir_breaks_mtime_ties_by_name(tmp_path: Path) -> None:
    artifacts_root = tmp_path / "artifacts"
    first_dir = artifacts_root / "20260423-010101"
    second_dir = artifacts_root / "20260423-020202"
    first_dir.mkdir(parents=True)
    second_dir.mkdir(parents=True)
    os.utime(first_dir, (1000, 1000))
    os.utime(second_dir, (1000, 1000))

    latest = RunStore.find_latest_artifact_dir(artifacts_root)

    assert latest == second_dir


def test_run_store_restores_source_resume_state(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "run.db")
    store.initialize(artifact_dir=str(tmp_path / "artifacts"))
    store.record_source_progress(
        source_name="leiting",
        iteration=12,
        max_iterations=5000,
        new_links=0,
        raw_links=2,
        successful_iterations=12,
        failed_iterations=0,
    )
    store.record_raw_link("leiting", "vmess://first")
    store.record_raw_link("leiting", "vmess://second")

    state = store.fetch_source_resume_state("leiting")

    assert state["iteration"] == 12
    assert state["raw_links"] == ["vmess://first", "vmess://second"]
