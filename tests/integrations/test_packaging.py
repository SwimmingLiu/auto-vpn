from pathlib import Path

from vpn_automation.integrations.packaging import build_electron_package_command


def test_build_electron_package_command_uses_npm_package_script() -> None:
    command = build_electron_package_command(Path("/tmp/project"))

    assert command == ["npm", "run", "package:electron"]
