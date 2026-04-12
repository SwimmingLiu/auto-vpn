from pathlib import Path

from vpn_automation.integrations.packaging import build_pyinstaller_command


def test_build_pyinstaller_command_targets_windowed_app() -> None:
    command = build_pyinstaller_command(Path("/tmp/project"))

    assert command[:3] == ["python3", "-m", "PyInstaller"]
    assert "--windowed" in command
    assert "VPNSubscriptionAutomation" in command
