import argparse
import subprocess
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from vpn_automation.config.models import resolve_repo_anchor
from vpn_automation.integrations.packaging import package_application


def resolve_app_version() -> str:
    try:
        return version("vpn-subscription-automation")
    except PackageNotFoundError:
        return "0.0.0"


def build_app_metadata() -> dict[str, str]:
    return {
        "name": "vpn-subscription-automation",
        "display_name": "AutoVPN",
        "version": resolve_app_version(),
    }


def resolve_source_root(candidate: Path) -> Path:
    resolved = candidate.resolve()
    current = resolved if resolved.is_dir() else resolved.parent
    for path in [current, *current.parents]:
        if (path / "pyproject.toml").exists():
            return path
    return current


def run_gui(project_root: Path) -> None:
    subprocess.run(["npm", "run", "electron:dev"], cwd=str(project_root), check=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="VPN subscription automation Electron launcher")
    parser.add_argument("--package", action="store_true", help="Build the Electron desktop app")
    args = parser.parse_args(argv)

    project_root = resolve_repo_anchor(Path(__file__))
    source_root = resolve_source_root(Path(__file__))

    if args.package:
        package_application(project_root)
        return 0

    run_gui(source_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
