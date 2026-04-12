from pathlib import Path

from vpn_automation.integrations.commands import run_command


def build_obfuscate_command(input_path: Path, output_path: Path) -> list[str]:
    return [
        "npx",
        "javascript-obfuscator",
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
