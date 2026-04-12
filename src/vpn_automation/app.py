import argparse
from pathlib import Path

from vpn_automation.config.models import resolve_repo_anchor
from vpn_automation.config.store import ProfileStore
from vpn_automation.integrations.packaging import package_application
from vpn_automation.pipeline.controller import PipelineController


def build_app_metadata() -> dict[str, str]:
    return {
        "name": "vpn-subscription-automation",
        "version": "0.1.0",
    }


def build_profile_store(project_root: Path) -> ProfileStore:
    return ProfileStore(project_root / "state" / "profiles" / "default.json")


def resolve_source_root(candidate: Path) -> Path:
    resolved = candidate.resolve()
    current = resolved if resolved.is_dir() else resolved.parent
    for path in [current, *current.parents]:
        if (path / "pyproject.toml").exists():
            return path
    return current


def run_gui(project_root: Path) -> None:
    from vpn_automation.gui.main_window import create_main_window

    store = build_profile_store(project_root)
    controller = PipelineController()
    window = create_main_window(project_root=project_root, store=store, controller=controller)
    window.root.mainloop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="VPN subscription automation GUI")
    parser.add_argument("--package", action="store_true", help="Build a runnable GUI application with PyInstaller")
    args = parser.parse_args(argv)

    project_root = resolve_repo_anchor(Path(__file__))
    source_root = resolve_source_root(Path(__file__))

    if args.package:
        package_application(source_root)
        return 0

    run_gui(project_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
