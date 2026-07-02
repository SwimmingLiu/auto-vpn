from pathlib import Path

from vpn_automation.config.models import resolve_repo_anchor
from vpn_automation.integrations.commands import run_command
from vpn_automation.integrations.managed_tools import (
    ManagedToolSpec,
    resolve_managed_npm_tool,
)


def build_obfuscate_command(
    input_path: Path,
    output_path: Path,
    obfuscator_executable: Path | None = None,
) -> list[str]:
    executable = obfuscator_executable
    if executable is None:
        executable = resolve_managed_npm_tool(
            ManagedToolSpec(
                package="javascript-obfuscator",
                binary="javascript-obfuscator",
                version="5.4.3",
            ),
            project_root=resolve_repo_anchor(Path(__file__)),
        ).executable

    return [
        str(executable.resolve()),
        str(input_path),
        "--output",
        str(output_path),
        "--compact",
        "true",
        "--control-flow-flattening",
        "true",
        "--control-flow-flattening-threshold",
        "1",
        "--dead-code-injection",
        "true",
        "--dead-code-injection-threshold",
        "1",
        "--identifier-names-generator",
        "hexadecimal",
        "--rename-globals",
        "true",
        "--string-array",
        "true",
        "--string-array-encoding",
        "rc4",
        "--string-array-threshold",
        "1",
        "--transform-object-keys",
        "true",
        "--unicode-escape-sequence",
        "true",
    ]


def obfuscate_javascript(input_path: Path, output_path: Path) -> dict[str, str | int]:
    result = run_command(build_obfuscate_command(input_path, output_path), cwd=str(input_path.parent))
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)
    return {
        "stdout": result.stdout,
        "stderr": result.stderr,
        "returncode": result.returncode,
    }
