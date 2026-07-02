import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from vpn_automation.integrations.commands import build_command_env


Runner = Callable[
    [list[str], Path | None, dict[str, str] | None, int],
    tuple[int, str, str],
]


@dataclass(frozen=True)
class ManagedToolSpec:
    package: str
    binary: str
    version: str


@dataclass(frozen=True)
class ResolvedManagedTool:
    executable: Path
    source: str
    version: str
    install_dir: Path


class ManagedToolError(RuntimeError):
    pass


def default_tools_root() -> Path:
    from vpn_automation.config.runtime import resolve_user_runtime_root

    return resolve_user_runtime_root() / "tools"


def _truncate(value: str, limit: int = 1200) -> str:
    normalized = value.strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit] + "...<truncated>"


def _default_runner(
    command: list[str],
    cwd: Path | None,
    env: dict[str, str] | None,
    timeout_seconds: int,
) -> tuple[int, str, str]:
    completed = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        env=build_command_env(env),
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout_seconds or None,
    )
    return completed.returncode, completed.stdout, completed.stderr


def _bin_path(install_dir: Path, binary: str) -> Path:
    suffix = ".cmd" if os.name == "nt" else ""
    return install_dir / "node_modules" / ".bin" / f"{binary}{suffix}"


def _verify(executable: Path, runner: Runner, timeout_seconds: int) -> str:
    code, stdout, stderr = runner(
        [str(executable), "--version"],
        None,
        None,
        timeout_seconds,
    )
    output = stdout or stderr
    if code != 0:
        raise ManagedToolError(
            f"Managed tool verification failed for {executable}: {_truncate(output)}"
        )
    normalized = output.strip()
    return normalized.splitlines()[0] if normalized else ""


def resolve_managed_npm_tool(
    spec: ManagedToolSpec,
    *,
    tools_root: Path | None = None,
    project_root: Path | None = None,
    install_missing: bool = True,
    allow_project_fallback: bool = True,
    runner: Runner = _default_runner,
    timeout_seconds: int = 120,
) -> ResolvedManagedTool:
    root = tools_root or default_tools_root()
    install_dir = root / "npm" / spec.package / spec.version
    managed_exe = _bin_path(install_dir, spec.binary)
    if managed_exe.exists():
        version = _verify(managed_exe, runner, timeout_seconds)
        return ResolvedManagedTool(managed_exe, "managed", version, install_dir)

    if install_missing:
        if not shutil.which("npm"):
            raise ManagedToolError(
                f"npm is required to install {spec.package} but was not found"
            )
        install_dir.mkdir(parents=True, exist_ok=True)
        package_spec = f"{spec.package}@{spec.version}"
        env = {"NPM_CONFIG_YES": "true", "npm_config_yes": "true"}
        code, stdout, stderr = runner(
            ["npm", "install", "--no-save", "--no-audit", "--no-fund", package_spec],
            install_dir,
            env,
            timeout_seconds,
        )
        if code != 0:
            raise ManagedToolError(
                f"Failed to install {spec.package} into {install_dir}: "
                f"{_truncate(stderr or stdout)}"
            )
        if not managed_exe.exists():
            raise ManagedToolError(
                f"Installed {spec.package} but executable {managed_exe} was not created"
            )
        version = _verify(managed_exe, runner, timeout_seconds)
        return ResolvedManagedTool(managed_exe, "managed", version, install_dir)

    if allow_project_fallback and project_root:
        project_exe = _bin_path(project_root, spec.binary)
        if project_exe.exists():
            version = _verify(project_exe, runner, timeout_seconds)
            return ResolvedManagedTool(project_exe, "project", version, project_root)

    raise ManagedToolError(f"{spec.package} is not available")
