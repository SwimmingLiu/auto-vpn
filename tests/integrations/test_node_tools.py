from pathlib import Path

from vpn_automation.integrations.node_tools import build_obfuscate_command


def test_build_obfuscate_command_targets_expected_output() -> None:
    command = build_obfuscate_command(Path("/tmp/input.js"), Path("/tmp/output.js"))

    assert command[:3] == ["npx", "javascript-obfuscator", "/tmp/input.js"]
    assert "--output" in command
    assert "/tmp/output.js" in command
