from pathlib import Path

import vpn_automation.integrations.node_tools as node_tools
from vpn_automation.integrations.managed_tools import ManagedToolSpec, ResolvedManagedTool
from vpn_automation.integrations.node_tools import build_obfuscate_command


def test_build_obfuscate_command_targets_expected_output() -> None:
    command = build_obfuscate_command(
        Path("/tmp/input.js"),
        Path("/tmp/output.js"),
        obfuscator_executable=Path("/opt/tools/javascript-obfuscator"),
    )

    assert command[:2] == ["/opt/tools/javascript-obfuscator", "/tmp/input.js"]
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


def test_build_obfuscate_command_resolves_managed_obfuscator(
    monkeypatch,
    tmp_path: Path,
) -> None:
    executable = tmp_path / "tools" / "javascript-obfuscator"
    captured_spec = None
    captured_project_root = None

    def fake_resolve_managed_npm_tool(
        spec: ManagedToolSpec,
        *,
        project_root: Path | None = None,
    ) -> ResolvedManagedTool:
        nonlocal captured_spec, captured_project_root
        assert project_root is not None
        captured_spec = spec
        captured_project_root = project_root
        return ResolvedManagedTool(
            executable=executable,
            source="managed",
            version="5.4.3",
            install_dir=tmp_path / "tools",
        )

    monkeypatch.setattr(
        node_tools,
        "resolve_managed_npm_tool",
        fake_resolve_managed_npm_tool,
    )

    command = build_obfuscate_command(Path("/tmp/input.js"), Path("/tmp/output.js"))

    assert captured_spec == ManagedToolSpec(
        package="javascript-obfuscator",
        binary="javascript-obfuscator",
        version="5.4.3",
    )
    assert captured_project_root is not None
    assert command[:2] == [str(executable), "/tmp/input.js"]
