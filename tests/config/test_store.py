from pathlib import Path

from vpn_automation.config.models import (
    AppProfile,
    DeployConfig,
    SourceConfig,
    SpeedTestConfig,
    create_default_profile,
)
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
    store = ProfileStore(tmp_path / "default.json")
    store.save(profile)
    loaded = store.load()
    assert loaded.sources["leiting"].url == "https://a.example"
    assert loaded.deploy.project_name == "vmessnodes"


def test_profile_store_load_or_create_returns_default_profile(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    store = ProfileStore(project_root / "state" / "profiles" / "default.json")

    profile = store.load_or_create(project_root)

    assert profile.workspace.project_root == str(project_root)
    assert store.path.exists()


def test_create_default_profile_starts_empty(tmp_path: Path) -> None:
    profile = create_default_profile(tmp_path / "vpn-subscription-automation")

    assert profile.sources["leiting"].url == ""
    assert profile.sources["leiting"].key == ""
    assert profile.deploy.project_name == ""
    assert profile.deploy.subscription_url == ""
    assert profile.speed_test.urls == []


def test_resolve_profile_path_prefers_repo_anchor_state_when_running_from_worktree(tmp_path: Path) -> None:
    repo_root = tmp_path / "vpn-subscription-automation"
    worktree_root = repo_root / ".worktrees" / "cleanup"
    anchor_profile = repo_root / "state" / "profiles" / "default.json"
    local_profile = worktree_root / "state" / "profiles" / "default.json"

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


def test_resolve_profile_path_prefers_env_override(tmp_path: Path, monkeypatch) -> None:
    override = tmp_path / "runtime" / "default.json"
    monkeypatch.setenv("VPN_AUTOMATION_PROFILE_PATH", str(override))

    resolved = resolve_profile_path(tmp_path / "vpn-subscription-automation")

    assert resolved == override


def test_profile_store_load_or_create_prefers_seed_profile(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    store = ProfileStore(tmp_path / "runtime" / "default.json")
    seed_profile = tmp_path / "seed" / "default.json"
    seed_profile.parent.mkdir(parents=True, exist_ok=True)
    seed_profile.write_text(
        """
{
  "sources": {
    "leiting": {"url": "https://seed.example", "key": "seed-key", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "heidong": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "mifeng": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "xuanfeng1": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "xuanfeng2": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true}
  },
  "speed_test": {
    "min_download_mb_s": 1.0,
    "timeout_seconds": 20,
    "concurrency": 3,
    "urls": [],
    "probe_url": "https://www.gstatic.com/generate_204",
    "max_download_bytes": 5000000,
    "startup_wait_seconds": 1.0
  },
  "deploy": {
    "project_name": "seed-project",
    "subscription_url": "https://seed.example/sub",
    "pages_project_url": "",
    "secret_query": "seed",
    "account_id": "",
    "use_wrangler": true
  },
  "workspace": {
    "project_root": "",
    "workspace_root": "",
    "vpn_catch_nodes_root": "",
    "edgetunnel_root": "",
    "artifacts_root": "",
    "state_root": "",
    "env_file": "",
    "build_root": ""
  },
  "filters": {
    "excluded_country_codes": ["CN"],
    "per_country_limit": {"HK": 5, "TW": 5}
  }
}
        """.strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("VPN_AUTOMATION_BUNDLED_PROFILE_PATH", str(seed_profile))

    profile = store.load_or_create(project_root)

    assert profile.deploy.project_name == "seed-project"
    assert profile.sources["leiting"].url == "https://seed.example"


def test_profile_store_migrates_blank_runtime_profile_from_seed(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    runtime_profile = tmp_path / "runtime" / "default.json"
    runtime_profile.parent.mkdir(parents=True, exist_ok=True)
    runtime_profile.write_text(
        """
{
  "sources": {
    "leiting": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "heidong": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "mifeng": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "xuanfeng1": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "xuanfeng2": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true}
  },
  "speed_test": {
    "min_download_mb_s": 1.0,
    "timeout_seconds": 20,
    "concurrency": 3,
    "urls": [],
    "probe_url": "https://www.gstatic.com/generate_204",
    "max_download_bytes": 5000000,
    "startup_wait_seconds": 1.0
  },
  "deploy": {
    "project_name": "",
    "subscription_url": "",
    "pages_project_url": "",
    "secret_query": "",
    "account_id": "",
    "use_wrangler": true
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
    "profile_path": ""
  },
  "filters": {
    "excluded_country_codes": ["CN"],
    "per_country_limit": {"HK": 5, "TW": 5}
  }
}
        """.strip(),
        encoding="utf-8",
    )

    seed_profile = tmp_path / "seed" / "default.json"
    seed_profile.parent.mkdir(parents=True, exist_ok=True)
    seed_profile.write_text(
        """
{
  "sources": {
    "leiting": {"url": "https://seed.example", "key": "seed-key", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "heidong": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "mifeng": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "xuanfeng1": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true},
    "xuanfeng2": {"url": "", "key": "", "enabled": true, "max_iterations": 40, "plateau_limit": 8, "use_random_area": true}
  },
  "speed_test": {
    "min_download_mb_s": 1.0,
    "timeout_seconds": 20,
    "concurrency": 3,
    "urls": [],
    "probe_url": "https://www.gstatic.com/generate_204",
    "max_download_bytes": 5000000,
    "startup_wait_seconds": 1.0
  },
  "deploy": {
    "project_name": "seed-project",
    "subscription_url": "https://seed.example/sub",
    "pages_project_url": "",
    "secret_query": "seed",
    "account_id": "",
    "use_wrangler": true
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
    "profile_path": ""
  },
  "filters": {
    "excluded_country_codes": ["CN"],
    "per_country_limit": {"HK": 5, "TW": 5}
  }
}
        """.strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("VPN_AUTOMATION_BUNDLED_PROFILE_PATH", str(seed_profile))

    store = ProfileStore(runtime_profile)
    profile = store.load_or_create(project_root)

    assert profile.deploy.project_name == "seed-project"
    assert profile.sources["leiting"].url == "https://seed.example"
