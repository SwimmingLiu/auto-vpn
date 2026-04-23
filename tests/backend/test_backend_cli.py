import json
from pathlib import Path

from vpn_automation.backend import build_event, ensure_profile_json, save_profile_payload
from vpn_automation.config.models import AppProfile, DeployConfig, SourceConfig, SpeedTestConfig
from vpn_automation.config.store import ProfileStore
from vpn_automation.pipeline.run_store import RunStore


def test_build_event_emits_json_line() -> None:
    line = build_event("log", {"message": "hello"})
    payload = json.loads(line)
    assert payload["type"] == "log"
    assert payload["message"] == "hello"


def test_ensure_profile_json_bootstraps_missing_profile(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    profile_json = ensure_profile_json(project_root)
    payload = json.loads(profile_json)
    assert payload["deploy"]["project_name"] == "vmessnodes"
    assert "workspace" not in payload


def test_save_profile_payload_persists_toml_backed_changes(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    payload = json.loads(ensure_profile_json(project_root))
    payload["sources"]["leiting"]["url"] = "https://example.com/api"
    payload["sources"]["leiting"]["key"] = "abcdabcdabcdabcd"

    save_profile_payload(project_root, payload)

    stored = (project_root / "state" / "profile.toml").read_text(encoding="utf-8")
    assert 'url = "https://example.com/api"' in stored
    assert 'key = "abcdabcdabcdabcd"' in stored


def test_ensure_profile_json_prefers_env_profile_path(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    profile_path = tmp_path / "runtime" / "profile.toml"
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile = AppProfile(
        sources={"leiting": SourceConfig(url="https://env.example", key="env-key", enabled=True)},
        speed_test=SpeedTestConfig(
            min_download_mb_s=1.0,
            timeout_seconds=20,
            concurrency=3,
            urls=[],
        ),
        deploy=DeployConfig(
            project_name="env-profile",
            subscription_url="https://env.example/sub",
        ),
    )
    ProfileStore(profile_path).save(profile)
    monkeypatch.setenv("VPN_AUTOMATION_PROFILE_PATH", str(profile_path))

    profile_json = ensure_profile_json(project_root)
    payload = json.loads(profile_json)

    assert payload["deploy"]["project_name"] == "env-profile"
    assert payload["sources"]["leiting"]["url"] == "https://env.example"


def test_find_resume_run_db_prefers_latest_incomplete_artifact(tmp_path: Path) -> None:
    from vpn_automation.backend import find_resume_run_db

    project_root = tmp_path / "vpn-subscription-automation"
    artifacts_root = project_root / "artifacts"
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

    resolved = find_resume_run_db(project_root)

    assert resolved == second_dir / "run.db"
