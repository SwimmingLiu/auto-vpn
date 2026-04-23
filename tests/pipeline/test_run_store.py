import sqlite3
from pathlib import Path

from vpn_automation.pipeline.run_store import RunStore


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
