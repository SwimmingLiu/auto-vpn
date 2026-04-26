import os

from vpn_automation.integrations.commands import build_command_env


def test_build_command_env_appends_common_cli_paths(monkeypatch) -> None:
    monkeypatch.setenv("PATH", "/usr/bin:/bin")

    env = build_command_env({"CUSTOM_FLAG": "1"})
    path_entries = env["PATH"].split(os.pathsep)

    assert env["CUSTOM_FLAG"] == "1"
    assert "/usr/bin" in path_entries
    assert "/bin" in path_entries
    assert "/opt/homebrew/bin" in path_entries
    assert "/usr/local/bin" in path_entries
    assert path_entries.count("/opt/homebrew/bin") == 1


def test_build_command_env_seeds_system_paths_when_path_is_empty(monkeypatch) -> None:
    monkeypatch.setenv("PATH", "")

    env = build_command_env()
    path_entries = env["PATH"].split(os.pathsep)

    assert "/usr/bin" in path_entries
    assert "/bin" in path_entries
