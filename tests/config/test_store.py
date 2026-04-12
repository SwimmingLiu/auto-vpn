from pathlib import Path

from vpn_automation.config.models import AppProfile, DeployConfig, SourceConfig, SpeedTestConfig
from vpn_automation.config.store import ProfileStore


def test_profile_store_round_trip(tmp_path: Path) -> None:
    profile = AppProfile(
        sources={"leiting": SourceConfig(url="https://a.example", key="k1", enabled=True)},
        speed_test=SpeedTestConfig(
            min_download_mb_s=1.0,
            timeout_seconds=15,
            concurrency=4,
            urls=["https://example.com/file"],
        ),
        deploy=DeployConfig(project_name="vmessnodes", subscription_url="https://swimmingliu.xyz/test"),
    )
    store = ProfileStore(tmp_path / "default.json")
    store.save(profile)
    loaded = store.load()
    assert loaded.sources["leiting"].url == "https://a.example"
    assert loaded.deploy.project_name == "vmessnodes"
