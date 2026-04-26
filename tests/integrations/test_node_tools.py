from pathlib import Path

from vpn_automation.integrations.node_tools import build_obfuscate_command


def test_build_obfuscate_command_targets_expected_output() -> None:
    command = build_obfuscate_command(Path("/tmp/input.js"), Path("/tmp/output.js"))

    assert command[:3] == ["npx", "javascript-obfuscator", "/tmp/input.js"]
    assert "--output" in command
    assert "/tmp/output.js" in command
    assert command[command.index("--compact") + 1] == "true"
    assert command[command.index("--control-flow-flattening") + 1] == "true"
    assert command[command.index("--control-flow-flattening-threshold") + 1] == "1"
    assert command[command.index("--dead-code-injection") + 1] == "true"
    assert command[command.index("--dead-code-injection-threshold") + 1] == "1"
    assert command[command.index("--identifier-names-generator") + 1] == "hexadecimal"
    assert command[command.index("--rename-globals") + 1] == "true"
    assert command[command.index("--string-array") + 1] == "true"
    assert command[command.index("--string-array-encoding") + 1] == "rc4"
    assert command[command.index("--string-array-threshold") + 1] == "1"
    assert command[command.index("--transform-object-keys") + 1] == "true"
    assert command[command.index("--unicode-escape-sequence") + 1] == "true"
