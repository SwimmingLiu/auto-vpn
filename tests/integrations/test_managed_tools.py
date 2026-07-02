from pathlib import Path

import pytest

from vpn_automation.integrations.managed_tools import (
    ManagedToolError,
    ManagedToolSpec,
    resolve_managed_npm_tool,
)


def _fake_bin(path: Path, name: str) -> Path:
    bin_dir = path / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    exe = bin_dir / name
    exe.write_text("#!/bin/sh\nprintf 'ok\\n'\n", encoding="utf-8")
    exe.chmod(0o755)
    return exe


def test_resolve_uses_existing_user_managed_tool(tmp_path: Path) -> None:
    tool_root = tmp_path / "tools"
    exe = _fake_bin(
        tool_root / "npm" / "javascript-obfuscator" / "5.4.3",
        "javascript-obfuscator",
    )

    resolved = resolve_managed_npm_tool(
        ManagedToolSpec(
            package="javascript-obfuscator",
            binary="javascript-obfuscator",
            version="5.4.3",
        ),
        tools_root=tool_root,
        project_root=tmp_path / "project",
        install_missing=False,
        runner=lambda command, cwd=None, env=None, timeout_seconds=0: (0, "5.4.3", ""),
    )

    assert resolved.executable == exe
    assert resolved.source == "managed"
    assert resolved.version == "5.4.3"


def test_resolve_allows_project_fallback_for_development(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    exe = _fake_bin(project_root, "wrangler")

    resolved = resolve_managed_npm_tool(
        ManagedToolSpec(package="wrangler", binary="wrangler", version="4.106.0"),
        tools_root=tmp_path / "tools",
        project_root=project_root,
        install_missing=False,
        allow_project_fallback=True,
        runner=lambda command, cwd=None, env=None, timeout_seconds=0: (0, "4.106.0", ""),
    )

    assert resolved.executable == exe
    assert resolved.source == "project"


def test_resolve_installs_missing_tool_into_user_tool_dir(tmp_path: Path) -> None:
    tool_root = tmp_path / "tools"
    calls: list[tuple[list[str], Path | None]] = []

    def runner(command, cwd=None, env=None, timeout_seconds=0):
        calls.append((command, cwd))
        if command[:2] == ["npm", "install"]:
            assert cwd == tool_root / "npm" / "wrangler" / "4.106.0"
            _fake_bin(cwd, "wrangler")
            return (0, "installed", "")
        return (0, "4.106.0", "")

    resolved = resolve_managed_npm_tool(
        ManagedToolSpec(package="wrangler", binary="wrangler", version="4.106.0"),
        tools_root=tool_root,
        project_root=tmp_path / "project",
        install_missing=True,
        runner=runner,
    )

    assert resolved.source == "managed"
    assert resolved.executable.exists()
    assert any(command[:2] == ["npm", "install"] for command, _cwd in calls)


def test_resolve_reports_install_failure_without_prompting(tmp_path: Path) -> None:
    def runner(command, cwd=None, env=None, timeout_seconds=0):
        return (1, "", "network unavailable")

    with pytest.raises(ManagedToolError, match="Failed to install wrangler"):
        resolve_managed_npm_tool(
            ManagedToolSpec(package="wrangler", binary="wrangler", version="4.106.0"),
            tools_root=tmp_path / "tools",
            project_root=tmp_path / "project",
            install_missing=True,
            runner=runner,
        )
