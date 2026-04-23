from pathlib import Path

from vpn_automation.config.models import AppProfile, DeployConfig, SourceConfig, SpeedTestConfig
from vpn_automation.config.store import ProfileStore, resolve_profile_path


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
    store = ProfileStore(tmp_path / "profile.toml")
    store.save(profile)
    loaded = store.load()
    payload = store.path.read_text(encoding="utf-8")
    assert loaded.sources["leiting"].url == "https://a.example"
    assert loaded.deploy.project_name == "vmessnodes"
    assert "[sources.leiting]" in payload


def test_profile_store_load_or_create_returns_default_profile(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    store = ProfileStore(project_root / "state" / "profile.toml")

    profile = store.load_or_create(project_root)

    assert "workspace" not in profile.to_dict()
    assert store.path.name == "profile.toml"
    assert profile.sources["leiting"].enabled is True
    assert store.path.exists()


def test_resolve_profile_path_prefers_repo_anchor_state_when_running_from_worktree(tmp_path: Path) -> None:
    repo_root = tmp_path / "vpn-subscription-automation"
    worktree_root = repo_root / ".worktrees" / "cleanup"
    anchor_profile = repo_root / "state" / "profile.toml"
    local_profile = worktree_root / "state" / "profile.toml"

    repo_root.mkdir(parents=True)
    worktree_root.mkdir(parents=True)
    (repo_root / "pyproject.toml").write_text("", encoding="utf-8")
    (repo_root / "src" / "vpn_automation").mkdir(parents=True)
    anchor_profile.parent.mkdir(parents=True, exist_ok=True)
    local_profile.parent.mkdir(parents=True, exist_ok=True)
    local_profile.write_text("{}", encoding="utf-8")
    anchor_profile.write_text("{}", encoding="utf-8")

    resolved = resolve_profile_path(worktree_root)

    assert resolved == anchor_profile
