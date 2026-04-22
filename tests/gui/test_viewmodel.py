from pathlib import Path

from vpn_automation.config.models import create_default_profile
from vpn_automation.gui.viewmodel import apply_form_state_to_profile, profile_to_form_state


def test_profile_to_form_state_exposes_source_and_deploy_fields(tmp_path: Path) -> None:
    profile = create_default_profile(tmp_path / "vpn-subscription-automation")

    state = profile_to_form_state(profile)

    assert "source.leiting.url" in state
    assert state["deploy.project_name"] == ""
    assert state["deploy.subscription_url"] == ""


def test_apply_form_state_to_profile_updates_threshold_and_url(tmp_path: Path) -> None:
    profile = create_default_profile(tmp_path / "vpn-subscription-automation")
    state = profile_to_form_state(profile)
    state["source.leiting.url"] = "https://example.com/api"
    state["speed.min_download_mb_s"] = "2.5"

    updated = apply_form_state_to_profile(profile, state)

    assert updated.sources["leiting"].url == "https://example.com/api"
    assert updated.speed_test.min_download_mb_s == 2.5
