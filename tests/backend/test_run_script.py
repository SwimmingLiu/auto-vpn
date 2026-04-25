import json
import os
import subprocess
from pathlib import Path


def test_run_backend_pipeline_dry_run_creates_session_metadata(tmp_path: Path) -> None:
    repo_root = tmp_path / "vpn-subscription-automation"
    (repo_root / "artifacts" / "manual-runs").mkdir(parents=True)
    script_path = Path("/Users/swimmingliu/data/VPN/vpn-subscription-automation/scripts/run_backend_pipeline.sh")

    result = subprocess.run(
        [str(script_path), "--dry-run", str(repo_root)],
        env={**os.environ, "TERM": "dumb"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Session dir:" in result.stdout
    assert "events.jsonl" in result.stdout
    assert "monitor_run.sh" in result.stdout

    sessions = list((repo_root / "artifacts" / "manual-runs").iterdir())
    assert len(sessions) == 1
    session_path = sessions[0]
    metadata = json.loads((session_path / "session.json").read_text(encoding="utf-8"))
    assert metadata["mode"] == "dry-run"
    assert metadata["skip_deploy"] is True
    assert metadata["skip_verify"] is True
    assert metadata["event_log"].endswith("events.jsonl")
