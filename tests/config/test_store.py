from pathlib import Path

from vpn_automation.config.models import AppProfile, DeployConfig, SourceConfig, SpeedTestConfig, create_default_profile
from vpn_automation.config.store import ProfileStore, resolve_profile_path


def make_profile(project_name: str = "vmessnodes", source_url: str = "https://a.example") -> AppProfile:
    return AppProfile(
        sources={
            "leiting": SourceConfig(url=source_url, key="k1", enabled=True),
            "heidong": SourceConfig(url="", key="", enabled=True),
            "mifeng": SourceConfig(url="", key="", enabled=True),
            "xuanfeng-area": SourceConfig(url="", key="", enabled=True, use_random_area=False),
            "xuanfeng-all-area": SourceConfig(url="", key="", enabled=True, use_random_area=True),
        },
        speed_test=SpeedTestConfig(
            min_download_mb_s=1.0,
            timeout_seconds=15,
            concurrency=4,
            urls=["https://example.com/file"],
        ),
        deploy=DeployConfig(project_name=project_name, subscription_url="https://swimmingliu.xyz/test"),
    )


def test_profile_store_round_trip(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path / "profile.toml")
    store.save(make_profile())

    loaded = store.load()
    payload = store.path.read_text(encoding="utf-8")

    assert loaded.sources["leiting"].url == "https://a.example"
    assert loaded.deploy.project_name == "vmessnodes"
    assert "[sources.leiting]" in payload
    assert "[sources.xuanfeng-area]" in payload


def test_profile_store_load_or_create_returns_default_profile(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    store = ProfileStore(project_root / "state" / "profile.toml")

    profile = store.load_or_create(project_root)

    assert "workspace" not in profile.to_dict()
    assert store.path.name == "profile.toml"
    assert profile.sources["leiting"].enabled is True
    assert profile.deploy.project_name == "vmessnodes"
    assert store.path.exists()


def test_create_default_profile_starts_with_editable_defaults(tmp_path: Path) -> None:
    profile = create_default_profile(tmp_path / "vpn-subscription-automation")

    assert profile.sources["leiting"].url == ""
    assert profile.sources["leiting"].key == ""
    assert all(source.max_iterations == 5000 for source in profile.sources.values())
    assert profile.deploy.project_name == "vmessnodes"
    assert profile.deploy.subscription_url == "https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937"
    assert len(profile.speed_test.urls) == 3


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
    local_profile.write_text("", encoding="utf-8")
    anchor_profile.write_text("", encoding="utf-8")

    resolved = resolve_profile_path(worktree_root)

    assert resolved == anchor_profile


def test_resolve_profile_path_prefers_env_override(tmp_path: Path, monkeypatch) -> None:
    override = tmp_path / "runtime" / "profile.toml"
    monkeypatch.setenv("VPN_AUTOMATION_PROFILE_PATH", str(override))

    resolved = resolve_profile_path(tmp_path / "vpn-subscription-automation")

    assert resolved == override


def test_profile_store_load_or_create_prefers_seed_profile(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    runtime_profile = tmp_path / "runtime" / "profile.toml"
    seed_profile = tmp_path / "seed" / "bundled-profile.toml"
    seed_profile.parent.mkdir(parents=True, exist_ok=True)
    ProfileStore(seed_profile).save(make_profile(project_name="seed-project", source_url="https://seed.example"))
    monkeypatch.setenv("VPN_AUTOMATION_BUNDLED_PROFILE_PATH", str(seed_profile))

    profile = ProfileStore(runtime_profile).load_or_create(project_root)

    assert profile.deploy.project_name == "seed-project"
    assert profile.sources["leiting"].url == "https://seed.example"


def test_profile_store_replaces_blank_runtime_profile_with_seed(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    runtime_profile = tmp_path / "runtime" / "profile.toml"
    runtime_profile.parent.mkdir(parents=True, exist_ok=True)
    blank_profile = make_profile(project_name="", source_url="")
    blank_profile.sources["leiting"].key = ""
    blank_profile.deploy.subscription_url = ""
    blank_profile.deploy.pages_project_url = ""
    blank_profile.deploy.secret_query = ""
    blank_profile.deploy.account_id = ""
    ProfileStore(runtime_profile).save(blank_profile)

    seed_profile = tmp_path / "seed" / "bundled-profile.toml"
    seed_profile.parent.mkdir(parents=True, exist_ok=True)
    ProfileStore(seed_profile).save(make_profile(project_name="seed-project", source_url="https://seed.example"))
    monkeypatch.setenv("VPN_AUTOMATION_BUNDLED_PROFILE_PATH", str(seed_profile))

    profile = ProfileStore(runtime_profile).load_or_create(project_root)

    assert profile.deploy.project_name == "seed-project"
    assert profile.sources["leiting"].url == "https://seed.example"


def test_profile_store_keeps_non_blank_runtime_profile(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    runtime_profile = tmp_path / "runtime" / "profile.toml"
    runtime_profile.parent.mkdir(parents=True, exist_ok=True)
    current_profile = make_profile(project_name="", source_url="")
    current_profile.deploy.secret_query = "keep-me"
    current_profile.deploy.subscription_url = ""
    current_profile.deploy.pages_project_url = ""
    current_profile.deploy.account_id = ""
    ProfileStore(runtime_profile).save(current_profile)

    seed_profile = tmp_path / "seed" / "bundled-profile.toml"
    seed_profile.parent.mkdir(parents=True, exist_ok=True)
    ProfileStore(seed_profile).save(make_profile(project_name="seed-project", source_url="https://seed.example"))
    monkeypatch.setenv("VPN_AUTOMATION_BUNDLED_PROFILE_PATH", str(seed_profile))

    profile = ProfileStore(runtime_profile).load_or_create(project_root)

    assert profile.deploy.secret_query == "keep-me"
    assert profile.deploy.project_name == ""
