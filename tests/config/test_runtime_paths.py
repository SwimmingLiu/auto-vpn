from pathlib import Path

from vpn_automation.app import resolve_source_root
from vpn_automation.config.models import create_default_profile, resolve_repo_anchor
from vpn_automation.config.runtime import resolve_env_file


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
    assert profile.deploy.project_name == "vmessnodes"
    assert profile.sources["leiting"].enabled is True


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


def test_resolve_source_root_keeps_active_worktree_root(tmp_path: Path) -> None:
    root = tmp_path / "vpn-subscription-automation"
    worktree_root = root / ".worktrees" / "feature-x"
    module_file = worktree_root / "src" / "vpn_automation" / "app.py"

    (worktree_root / "pyproject.toml").parent.mkdir(parents=True, exist_ok=True)
    (worktree_root / "pyproject.toml").write_text("", encoding="utf-8")
    module_file.parent.mkdir(parents=True, exist_ok=True)
    module_file.write_text("", encoding="utf-8")

    resolved = resolve_source_root(module_file)

    assert resolved == worktree_root
