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


def _validate_part(value: str, field: str) -> str:
    normalized = str(value or "").strip()
    if (
        not normalized
        or normalized in {".", ".."}
        or "/" in normalized
        or "\\" in normalized
        or Path(normalized).is_absolute()
    ):
        raise ManagedToolError(f"{field} contains unsafe path characters")
    return normalized


def _validate_package(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized or "\\" in normalized or Path(normalized).is_absolute():
        raise ManagedToolError("package contains unsafe path characters")
    parts = normalized.split("/")
    if normalized.startswith("@"):
        if len(parts) != 2:
            raise ManagedToolError("package contains unsafe path segments")
    elif len(parts) != 1:
        raise ManagedToolError("package contains unsafe path segments")
    for part in parts:
        _validate_part(part, "package")
    return normalized


def _validate_spec(spec: ManagedToolSpec) -> ManagedToolSpec:
    return ManagedToolSpec(
        package=_validate_package(spec.package),
        binary=_validate_part(spec.binary, "binary"),
        version=_validate_part(spec.version, "version"),
    )


def _npm_available() -> bool:
    command_path = build_command_env().get("PATH")
    return shutil.which("npm", path=command_path) is not None


def _verify(executable: Path, runner: Runner, timeout_seconds: int) -> str:
    try:
        code, stdout, stderr = runner(
            [str(executable), "--version"],
            None,
            None,
            timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise ManagedToolError(
            f"Managed tool verification timed out for {executable} after {exc.timeout} seconds"
        ) from exc
    except Exception as exc:
        raise ManagedToolError(
            f"Managed tool verification failed for {executable}: {exc.__class__.__name__}: {_truncate(str(exc))}"
        ) from exc
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
    spec = _validate_spec(spec)
    root = tools_root or default_tools_root()
    install_dir = root / "npm" / spec.package / spec.version
    managed_exe = _bin_path(install_dir, spec.binary)
    if managed_exe.exists():
        version = _verify(managed_exe, runner, timeout_seconds)
        return ResolvedManagedTool(managed_exe, "managed", version, install_dir)

    if allow_project_fallback and project_root:
        project_exe = _bin_path(project_root, spec.binary)
        if project_exe.exists():
            version = _verify(project_exe, runner, timeout_seconds)
            return ResolvedManagedTool(project_exe, "project", version, project_root)

    if install_missing:
        if not _npm_available():
            raise ManagedToolError(
                f"npm is required to install {spec.package} but was not found"
            )
        install_dir.mkdir(parents=True, exist_ok=True)
        package_spec = f"{spec.package}@{spec.version}"
        env = {"NPM_CONFIG_YES": "true", "npm_config_yes": "true"}
        install_command = ["npm", "install", "--no-save", "--no-audit", "--no-fund", package_spec]
        try:
            code, stdout, stderr = runner(
                install_command,
                install_dir,
                env,
                timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise ManagedToolError(
                f"Failed to install {spec.package} into {install_dir}: npm install timed out after {exc.timeout} seconds"
            ) from exc
        except Exception as exc:
            raise ManagedToolError(
                f"Failed to install {spec.package} into {install_dir}: {exc.__class__.__name__}: {_truncate(str(exc))}"
            ) from exc
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

    raise ManagedToolError(f"{spec.package} is not available")
