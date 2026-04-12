from vpn_automation.app import build_app_metadata


def test_build_app_metadata_returns_name_and_version() -> None:
    metadata = build_app_metadata()
    assert metadata["name"] == "vpn-subscription-automation"
    assert metadata["version"]
