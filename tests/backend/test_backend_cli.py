import json
import os
from pathlib import Path

from vpn_automation.backend import build_event, ensure_profile_json


def test_build_event_emits_json_line() -> None:
    line = build_event("log", {"message": "hello"})
    payload = json.loads(line)
    assert payload["type"] == "log"
    assert payload["message"] == "hello"


def test_ensure_profile_json_bootstraps_missing_profile(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    profile_json = ensure_profile_json(project_root)
    payload = json.loads(profile_json)
    assert payload["deploy"]["project_name"] == ""
    assert payload["workspace"]["project_root"] == str(project_root)


def test_ensure_profile_json_prefers_env_profile_path(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    profile_path = tmp_path / "runtime" / "default.json"
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile_path.write_text(
        json.dumps(
            {
                "sources": {
                    name: {
                        "url": "",
                        "key": "",
                        "enabled": True,
                        "max_iterations": 40,
                        "plateau_limit": 8,
                        "use_random_area": True,
                    }
                    for name in ["leiting", "heidong", "mifeng", "xuanfeng1", "xuanfeng2"]
                },
                "speed_test": {
                    "min_download_mb_s": 1.0,
                    "timeout_seconds": 20,
                    "concurrency": 3,
                    "urls": [],
                    "probe_url": "https://www.gstatic.com/generate_204",
                    "max_download_bytes": 5000000,
                    "startup_wait_seconds": 1.0,
                },
                "deploy": {
                    "project_name": "env-profile",
                    "subscription_url": "https://env.example/sub",
                    "pages_project_url": "",
                    "secret_query": "",
                    "account_id": "",
                    "use_wrangler": True,
                },
                "workspace": {
                    "project_root": "",
                    "workspace_root": "",
                    "vpn_catch_nodes_root": "",
                    "edgetunnel_root": "",
                    "artifacts_root": "",
                    "state_root": "",
                    "env_file": "",
                    "build_root": "",
                },
                "filters": {
                    "excluded_country_codes": ["CN"],
                    "per_country_limit": {"HK": 5, "TW": 5},
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("VPN_AUTOMATION_PROFILE_PATH", str(profile_path))

    profile_json = ensure_profile_json(project_root)
    payload = json.loads(profile_json)

    assert payload["deploy"]["project_name"] == "env-profile"
