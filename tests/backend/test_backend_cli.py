import json
from pathlib import Path

from vpn_automation.backend import build_event, ensure_profile_json, save_profile_payload


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
