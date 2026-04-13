from pathlib import Path

from vpn_automation.integrations.commands import run_command


def build_electron_package_command(project_root: Path) -> list[str]:
    _ = project_root
    return ["npm", "run", "package:electron"]


def package_application(project_root: Path) -> dict[str, str | int]:
    result = run_command(build_electron_package_command(project_root), cwd=str(project_root))
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)
    return {
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }
