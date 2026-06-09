from pathlib import Path

from vpn_automation.app import resolve_source_root
from vpn_automation.config.models import create_default_profile, resolve_repo_anchor
from vpn_automation.config.runtime import resolve_artifacts_root, resolve_env_file
from vpn_automation.config.store import ProfileStore


def test_resolve_repo_anchor_prefers_main_repo_root_for_worktrees(tmp_path: Path) -> None:
    root = tmp_path / "vpn-subscription-automation"
    worktree_root = root / ".worktrees" / "feature-x"
    package_file = worktree_root / "src" / "vpn_automation" / "config" / "models.py"
    package_file.parent.mkdir(parents=True)
    package_file.write_text("", encoding="utf-8")

    resolved = resolve_repo_anchor(package_file)

    assert resolved == root


def test_create_default_profile_omits_workspace_and_keeps_defaults(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    project_root.mkdir(parents=True)

    profile = create_default_profile(project_root)

    assert "workspace" not in profile.to_dict()
    assert profile.deploy.project_name == "sub-nodes"
    assert profile.deploy.pages_project_url == "https://sub-nodes.pages.dev"
    assert profile.deploy.subscription_url == "https://swimmingliu.online/179ba8dd-3854-4747-b853-fc1868ef3937"
    assert (
        profile.deploy.verify_subscription_url
        == "https://www.swimmingliu.online/sub?token=8410fb43eb2176497f5beafc0c39f5bc"
    )
    assert profile.sources["leiting"].enabled is True


def test_create_default_profile_uses_canonical_xuanfeng_sources(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    config_path = tmp_path / "vpn-catch-nodes" / "config" / "vpn_api.json"
    project_root.mkdir(parents=True)
    config_path.parent.mkdir(parents=True)
    config_path.write_text(
        (
            "{"
            '"xuanfeng-area":{"url":"https://example.com/area?area=2","key":"area-key"},'
            '"xuanfeng-all-area":{"url":"https://example.com/all?area=999","key":"all-area-key"}'
            "}"
        ),
        encoding="utf-8",
    )

    profile = create_default_profile(project_root)

    assert profile.sources["xuanfeng-area"].url == "https://example.com/area?area=2"
    assert profile.sources["xuanfeng-area"].key == "area-key"
    assert profile.sources["xuanfeng-area"].use_random_area is False
    assert profile.sources["xuanfeng-all-area"].url == "https://example.com/all?area=999"
    assert profile.sources["xuanfeng-all-area"].key == "all-area-key"
    assert profile.sources["xuanfeng-all-area"].use_random_area is True


def test_profile_store_loads_canonical_source_names_from_profile_toml(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path / "profile.toml")
    store.path.write_text(
        (
            "[sources.xuanfeng-area]\n"
            'url = "https://example.com/area?area=2"\n'
            'key = "area-key"\n'
            "enabled = false\n"
            "use_random_area = false\n\n"
            "[sources.xuanfeng-all-area]\n"
            'url = "https://example.com/all?area=999"\n'
            'key = "all-area-key"\n'
            "enabled = true\n"
            "use_random_area = true\n\n"
            "[speed_test]\n"
            "min_download_mb_s = 1.0\n"
            "timeout_seconds = 15\n"
            "concurrency = 2\n"
            "urls = []\n"
            'probe_url = "http://www.gstatic.com/generate_204"\n'
            "max_download_bytes = 1000\n"
            "startup_wait_seconds = 1.0\n"
            "max_download_candidates = 0\n\n"
            "[deploy]\n"
            'project_name = "sub-nodes"\n'
            'subscription_url = "https://example.com/sub"\n'
        ),
        encoding="utf-8",
    )

    profile = store.load()

    assert profile.sources["xuanfeng-area"].enabled is False
    assert profile.sources["xuanfeng-area"].use_random_area is False
    assert profile.sources["xuanfeng-all-area"].enabled is True
    assert profile.sources["xuanfeng-all-area"].use_random_area is True


def test_resolve_env_file_prefers_main_repo_env_from_worktree(tmp_path: Path) -> None:
    root = tmp_path / "vpn-subscription-automation"
    env_path = root / ".env"
    worktree_root = root / ".worktrees" / "feature-x"
    module_file = worktree_root / "src" / "vpn_automation" / "config" / "runtime.py"

    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text("CLOUDFLARE_API_TOKEN=test", encoding="utf-8")
    module_file.parent.mkdir(parents=True, exist_ok=True)
    module_file.write_text("", encoding="utf-8")

    resolved = resolve_env_file(module_file)

    assert resolved == env_path


def test_resolve_artifacts_root_prefers_runtime_override(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    app_support_root = tmp_path / "Application Support" / "vpn-subscription-automation"
    project_root.mkdir(parents=True)
    monkeypatch.setenv("VPN_AUTOMATION_ARTIFACTS_ROOT", str(app_support_root / "artifacts"))

    resolved = resolve_artifacts_root(project_root)

    assert resolved == app_support_root / "artifacts"


def test_resolve_source_root_keeps_active_worktree_root(tmp_path: Path) -> None:
    root = tmp_path / "vpn-subscription-automation"
    worktree_root = root / ".worktrees" / "feature-x"
    module_file = worktree_root / "src" / "vpn_automation" / "app.py"

    (worktree_root / "pyproject.toml").parent.mkdir(parents=True, exist_ok=True)
    (worktree_root / "pyproject.toml").write_text("", encoding="utf-8")
    module_file.parent.mkdir(parents=True)
    module_file.write_text("", encoding="utf-8")

    resolved = resolve_source_root(module_file)

    assert resolved == worktree_root
