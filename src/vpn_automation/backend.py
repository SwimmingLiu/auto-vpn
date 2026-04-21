import argparse
import json
from pathlib import Path
from typing import Any

from vpn_automation.config.models import resolve_repo_anchor
from vpn_automation.config.store import ProfileStore, resolve_profile_path
from vpn_automation.pipeline.controller import PipelineController


def build_event(event_type: str, payload: dict[str, Any]) -> str:
    return json.dumps({"type": event_type, **payload}, ensure_ascii=False)


def ensure_profile_json(project_root: Path) -> str:
    store = ProfileStore(resolve_profile_path(project_root))
    profile = store.load_or_create(project_root)
    return json.dumps(profile.to_dict(), ensure_ascii=False)


def run_pipeline(project_root: Path) -> int:
    store = ProfileStore(resolve_profile_path(project_root))
    profile = store.load_or_create(project_root)
    controller = PipelineController()

    def log(message: str) -> None:
        print(build_event("log", {"message": message}), flush=True)

    def stage(stage_name: str, status: str) -> None:
        print(build_event("stage", {"stage": stage_name, "status": status}), flush=True)

    summary = controller.run(profile, log_callback=log, stage_callback=stage)
    print(
        build_event(
            "summary",
            {
                "artifact_dir": summary.artifact_dir,
                "stage_status": summary.stage_status,
                "counts": summary.counts,
                "deployment": summary.deployment,
            },
        ),
        flush=True,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="VPN automation backend")
    subparsers = parser.add_subparsers(dest="command", required=True)

    profile_parser = subparsers.add_parser("profile")
    profile_parser.add_argument("--project-root", default="")

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--project-root", default="")

    args = parser.parse_args(argv)
    candidate = Path(args.project_root or __file__)
    project_root = resolve_repo_anchor(candidate)

    if args.command == "profile":
        print(ensure_profile_json(project_root))
        return 0
    if args.command == "run":
        return run_pipeline(project_root)
    raise SystemExit(1)


if __name__ == "__main__":
    raise SystemExit(main())
