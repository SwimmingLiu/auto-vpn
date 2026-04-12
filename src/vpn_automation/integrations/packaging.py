import importlib.util
from pathlib import Path

from vpn_automation.integrations.commands import run_command


def build_pyinstaller_command(project_root: Path) -> list[str]:
    return [
        "python3",
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--name",
        "VPNSubscriptionAutomation",
        "--paths",
        str(project_root / "src"),
        str(project_root / "src" / "vpn_automation" / "app.py"),
    ]


def ensure_pyinstaller() -> None:
    if importlib.util.find_spec("PyInstaller") is not None:
        return
    result = run_command(["python3", "-m", "pip", "install", "pyinstaller"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)


def package_application(project_root: Path) -> dict[str, str | int]:
    ensure_pyinstaller()
    result = run_command(build_pyinstaller_command(project_root), cwd=str(project_root))
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)
    return {
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }
