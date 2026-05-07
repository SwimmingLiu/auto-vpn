import argparse
import json
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from vpn_automation.backend_resume import (
    continue_pipeline_session,
    list_artifacts_with_retry_stages,
    resume_speedtest_session,
    retry_pipeline_from_stage,
)
from vpn_automation.config.models import AppProfile, resolve_repo_anchor
from vpn_automation.config.runtime import resolve_artifacts_root, resolve_runtime_root
from vpn_automation.config.store import ProfileStore, resolve_profile_path
from vpn_automation.pipeline.controller import PipelineController
from vpn_automation.pipeline.run_store import RunStore
from vpn_automation.pipeline.tls_warnings import suppress_insecure_request_warnings


def build_event(event_type: str, payload: dict[str, Any]) -> str:
    return json.dumps({"type": event_type, **payload}, ensure_ascii=False)


def render_human_event(event: dict[str, Any]) -> str:
    event_type = str(event.get("type", ""))
    if event_type == "run_started":
        return (
            f"[run_started] artifact_dir={event.get('artifact_dir', '')} "
            f"skip_deploy={event.get('skip_deploy', False)} skip_verify={event.get('skip_verify', False)}"
        ).rstrip()
    if event_type == "log":
        return str(event.get("message", ""))
    if event_type == "stage":
        return f"[stage] {event.get('stage')}={event.get('status')}"
    if event_type == "summary":
        counts = " ".join(
            f"{name}={value}" for name, value in sorted((event.get("counts") or {}).items())
        )
        suffix = f" {counts}" if counts else ""
        return (
            f"[summary] run_status={event.get('run_status', 'unknown')} "
            f"artifact_dir={event.get('artifact_dir', '')}{suffix}"
        ).rstrip()
    if event_type == "run_failed":
        return f"[run_failed] {event.get('error', 'unknown error')}"
    return build_event(event_type, {key: value for key, value in event.items() if key != "type"})


def ensure_profile_json(project_root: Path) -> str:
    store = ProfileStore(resolve_profile_path(project_root))
    profile = store.load_or_create(project_root)
    return json.dumps(profile.to_dict(), ensure_ascii=False)


def artifact_latest_json(project_root: Path) -> str:
    runtime_root = resolve_runtime_root(project_root)
    latest_dir = RunStore.find_latest_artifact_dir(resolve_artifacts_root(runtime_root))
    if not latest_dir:
        return json.dumps({"ok": False, "artifact_dir": ""}, ensure_ascii=False)

    report_path = latest_dir / "pipeline_report.json"
    payload: dict[str, Any] = {"ok": True, "artifact_dir": str(latest_dir)}
    if report_path.exists():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        payload.update(
            {
                "run_status": report.get("run_status", ""),
                "stage_status": report.get("stage_status", {}),
                "counts": report.get("counts", {}),
                "source_counts": report.get("source_counts", {}),
                "deployment": report.get("deployment", {}),
                "error": report.get("error", ""),
            }
        )
    else:
        payload.update(
            {
                "run_status": "",
                "stage_status": {},
                "counts": {},
                "source_counts": {},
                "deployment": {},
                "error": "",
            }
        )
    return json.dumps(payload, ensure_ascii=False)


def artifact_list_json(project_root: Path) -> str:
    return json.dumps({"ok": True, "items": list_artifacts_with_retry_stages(project_root)}, ensure_ascii=False)


def save_profile_payload(project_root: Path, payload: dict[str, Any]) -> str:
    store = ProfileStore(resolve_profile_path(project_root))
    profile = AppProfile.from_dict(payload)
    store.save(profile)
    return json.dumps(profile.to_dict(), ensure_ascii=False)


def save_profile_json(project_root: Path, payload: str) -> str:
    return save_profile_payload(project_root, json.loads(payload))


@contextmanager
def open_event_streams(
    *,
    output_format: str,
    event_log_path: Path | None,
    human_log_path: Path | None,
) -> Iterator[Callable[[str, dict[str, Any]], None]]:
    event_handle = None
    human_handle = None
    if event_log_path:
        event_log_path.parent.mkdir(parents=True, exist_ok=True)
        event_handle = event_log_path.open("a", encoding="utf-8")
    if human_log_path:
        human_log_path.parent.mkdir(parents=True, exist_ok=True)
        human_handle = human_log_path.open("a", encoding="utf-8")

    def emit(event_type: str, payload: dict[str, Any]) -> None:
        line = build_event(event_type, payload)
        if event_handle:
            event_handle.write(line + "\n")
            event_handle.flush()

        event = json.loads(line)
        if output_format == "jsonl":
            print(line, flush=True)
        else:
            rendered = render_human_event(event)
            if rendered:
                print(rendered, flush=True)

        if human_handle:
            rendered = render_human_event(event)
            if rendered:
                human_handle.write(rendered + "\n")
                human_handle.flush()

    try:
        yield emit
    finally:
        if event_handle:
            event_handle.close()
        if human_handle:
            human_handle.close()


def load_session_paths(
    session_dir: Path,
    event_log_path: Path | None = None,
    human_log_path: Path | None = None,
) -> tuple[Path, Path]:
    session_payload = json.loads((session_dir / "session.json").read_text(encoding="utf-8"))
    resolved_event_log = event_log_path or Path(
        str(session_payload.get("event_log", session_dir / "events.jsonl"))
    ).resolve()
    resolved_human_log = human_log_path or Path(
        str(session_payload.get("human_log", session_dir / "human.log"))
    ).resolve()
    return resolved_event_log, resolved_human_log


def find_resume_run_db(runtime_candidate: Path) -> Path | None:
    runtime_root = resolve_runtime_root(runtime_candidate)
    return RunStore.find_latest_incomplete_run(resolve_artifacts_root(runtime_root))


def _emit_summary(emit: Callable[[str, dict[str, Any]], None], summary: Any) -> None:
    emit(
        "summary",
        {
            "artifact_dir": summary.artifact_dir,
            "stage_status": summary.stage_status,
            "counts": summary.counts,
            "source_counts": getattr(summary, "source_counts", {}),
            "deployment": summary.deployment,
            "run_status": getattr(summary, "run_status", "success"),
            "error": getattr(summary, "error", ""),
        },
    )


def _run_with_streams(
    *,
    output_format: str,
    event_log_path: Path | None,
    human_log_path: Path | None,
    runner: Callable[[Callable[[str, dict[str, Any]], None]], Any],
) -> int:
    with open_event_streams(
        output_format=output_format,
        event_log_path=event_log_path,
        human_log_path=human_log_path,
    ) as emit:
        try:
            summary = runner(emit)
            _emit_summary(emit, summary)
            if getattr(summary, "run_status", "success") != "success":
                emit("run_failed", {"error": getattr(summary, "error", "run failed")})
                return 1
            return 0
        except Exception as exc:
            emit("run_failed", {"error": f"{exc.__class__.__name__}: {exc}"})
            return 1


def run_pipeline(
    project_root: Path,
    runtime_candidate: Path | None = None,
    *,
    resume_from: Path | None = None,
    skip_deploy: bool = False,
    skip_verify: bool = False,
    output_format: str = "jsonl",
    event_log_path: Path | None = None,
    human_log_path: Path | None = None,
) -> int:
    store = ProfileStore(resolve_profile_path(project_root))
    profile = store.load_or_create(project_root)
    controller = PipelineController()

    def runner(emit: Callable[[str, dict[str, Any]], None]) -> Any:
        def log(message: str) -> None:
            emit("log", {"message": message})

        def stage(stage_name: str, status: str) -> None:
            emit("stage", {"stage": stage_name, "status": status})

        return controller.run(
            profile,
            log_callback=log,
            stage_callback=stage,
            resume_from=resume_from,
            skip_deploy=skip_deploy,
            skip_verify=skip_verify,
            event_callback=emit,
        )

    _ = runtime_candidate
    code = _run_with_streams(
        output_format=output_format,
        event_log_path=event_log_path,
        human_log_path=human_log_path,
        runner=runner,
    )
    if code == 0 and hasattr(store, "save"):
        store.save(profile)
    return code


def run_pipeline_resume_latest(
    project_root: Path,
    runtime_candidate: Path,
    *,
    skip_deploy: bool = False,
    skip_verify: bool = False,
    output_format: str = "jsonl",
    event_log_path: Path | None = None,
    human_log_path: Path | None = None,
) -> int:
    resume_db = find_resume_run_db(runtime_candidate)
    if not resume_db:
        raise RuntimeError("No incomplete run.db found to resume")
    return run_pipeline(
        project_root,
        runtime_candidate,
        resume_from=resume_db.parent,
        skip_deploy=skip_deploy,
        skip_verify=skip_verify,
        output_format=output_format,
        event_log_path=event_log_path,
        human_log_path=human_log_path,
    )


def resume_speedtest(
    project_root: Path,
    *,
    session_dir: Path,
    output_format: str = "jsonl",
    event_log_path: Path | None = None,
    human_log_path: Path | None = None,
) -> int:
    resolved_event_log, resolved_human_log = load_session_paths(
        session_dir,
        event_log_path=event_log_path,
        human_log_path=human_log_path,
    )

    def runner(emit: Callable[[str, dict[str, Any]], None]) -> Any:
        def log(message: str) -> None:
            emit("log", {"message": message})

        def stage(stage_name: str, status: str) -> None:
            emit("stage", {"stage": stage_name, "status": status})

        return resume_speedtest_session(
            session_dir,
            project_root=project_root,
            log_callback=log,
            stage_callback=stage,
            event_callback=emit,
        )

    return _run_with_streams(
        output_format=output_format,
        event_log_path=resolved_event_log,
        human_log_path=resolved_human_log,
        runner=runner,
    )


def resume_pipeline(
    project_root: Path,
    *,
    session_dir: Path,
    output_format: str = "jsonl",
    event_log_path: Path | None = None,
    human_log_path: Path | None = None,
) -> int:
    store = ProfileStore(resolve_profile_path(project_root))
    profile = store.load_or_create(project_root)
    resolved_event_log, resolved_human_log = load_session_paths(
        session_dir,
        event_log_path=event_log_path,
        human_log_path=human_log_path,
    )

    def runner(emit: Callable[[str, dict[str, Any]], None]) -> Any:
        def log(message: str) -> None:
            emit("log", {"message": message})

        def stage(stage_name: str, status: str) -> None:
            emit("stage", {"stage": stage_name, "status": status})

        return continue_pipeline_session(
            session_dir,
            project_root=project_root,
            log_callback=log,
            stage_callback=stage,
            event_callback=emit,
        )

    code = _run_with_streams(
        output_format=output_format,
        event_log_path=resolved_event_log,
        human_log_path=resolved_human_log,
        runner=runner,
    )
    if code == 0 and hasattr(store, "save"):
        store.save(profile)
    return code


def retry_stage(
    project_root: Path,
    *,
    artifact_dir: Path,
    stage_name: str,
    output_format: str = "jsonl",
    event_log_path: Path | None = None,
    human_log_path: Path | None = None,
) -> int:
    store = ProfileStore(resolve_profile_path(project_root))
    profile = store.load_or_create(project_root)
    def runner(emit: Callable[[str, dict[str, Any]], None]) -> Any:
        def log(message: str) -> None:
            emit("log", {"message": message})

        def stage(stage_key: str, status: str) -> None:
            emit("stage", {"stage": stage_key, "status": status})

        return retry_pipeline_from_stage(
            artifact_dir,
            stage_name=stage_name,
            project_root=project_root,
            log_callback=log,
            stage_callback=stage,
            event_callback=emit,
        )

    code = _run_with_streams(
        output_format=output_format,
        event_log_path=event_log_path,
        human_log_path=human_log_path,
        runner=runner,
    )
    if code == 0 and hasattr(store, "save"):
        store.save(profile)
    return code


def main(argv: list[str] | None = None) -> int:
    suppress_insecure_request_warnings()

    parser = argparse.ArgumentParser(description="VPN automation backend")
    subparsers = parser.add_subparsers(dest="command", required=True)

    profile_parser = subparsers.add_parser("profile")
    profile_parser.add_argument("--project-root", default="")

    profile_save_parser = subparsers.add_parser("profile-save")
    profile_save_parser.add_argument("--project-root", default="")

    artifact_latest_parser = subparsers.add_parser("artifact-latest")
    artifact_latest_parser.add_argument("--project-root", default="")

    artifact_list_parser = subparsers.add_parser("artifact-list")
    artifact_list_parser.add_argument("--project-root", default="")

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--project-root", default="")
    run_parser.add_argument("--resume-latest", action="store_true")
    run_parser.add_argument("--skip-deploy", action="store_true")
    run_parser.add_argument("--skip-verify", action="store_true")
    run_parser.add_argument("--output", choices=("jsonl", "human"), default="jsonl")
    run_parser.add_argument("--event-log", default="")
    run_parser.add_argument("--human-log", default="")

    resume_parser = subparsers.add_parser("resume-speedtest")
    resume_parser.add_argument("--project-root", default="")
    resume_parser.add_argument("--session", required=True)
    resume_parser.add_argument("--output", choices=("jsonl", "human"), default="jsonl")
    resume_parser.add_argument("--event-log", default="")
    resume_parser.add_argument("--human-log", default="")

    continue_parser = subparsers.add_parser("resume-pipeline")
    continue_parser.add_argument("--project-root", default="")
    continue_parser.add_argument("--session", required=True)
    continue_parser.add_argument("--output", choices=("jsonl", "human"), default="jsonl")
    continue_parser.add_argument("--event-log", default="")
    continue_parser.add_argument("--human-log", default="")

    retry_parser = subparsers.add_parser("retry-stage")
    retry_parser.add_argument("--project-root", default="")
    retry_parser.add_argument("--artifact-dir", required=True)
    retry_parser.add_argument("--stage", required=True)
    retry_parser.add_argument("--output", choices=("jsonl", "human"), default="jsonl")
    retry_parser.add_argument("--event-log", default="")
    retry_parser.add_argument("--human-log", default="")

    args = parser.parse_args(argv)
    candidate = Path(args.project_root or __file__)
    project_root = resolve_repo_anchor(candidate)

    if args.command == "profile":
        print(ensure_profile_json(project_root))
        return 0
    if args.command == "profile-save":
        print(save_profile_json(project_root, sys.stdin.read()))
        return 0
    if args.command == "artifact-latest":
        print(artifact_latest_json(project_root))
        return 0
    if args.command == "artifact-list":
        print(artifact_list_json(project_root))
        return 0
    if args.command == "run":
        if args.resume_latest:
            return run_pipeline_resume_latest(
                project_root,
                candidate,
                skip_deploy=bool(args.skip_deploy),
                skip_verify=bool(args.skip_verify),
                output_format=str(args.output),
                event_log_path=Path(args.event_log).resolve() if args.event_log else None,
                human_log_path=Path(args.human_log).resolve() if args.human_log else None,
            )
        return run_pipeline(
            project_root,
            candidate,
            skip_deploy=bool(args.skip_deploy),
            skip_verify=bool(args.skip_verify),
            output_format=str(args.output),
            event_log_path=Path(args.event_log).resolve() if args.event_log else None,
            human_log_path=Path(args.human_log).resolve() if args.human_log else None,
        )
    if args.command == "resume-speedtest":
        return resume_speedtest(
            project_root,
            session_dir=Path(str(args.session)).resolve(),
            output_format=str(args.output),
            event_log_path=Path(args.event_log).resolve() if args.event_log else None,
            human_log_path=Path(args.human_log).resolve() if args.human_log else None,
        )
    if args.command == "resume-pipeline":
        return resume_pipeline(
            project_root,
            session_dir=Path(str(args.session)).resolve(),
            output_format=str(args.output),
            event_log_path=Path(args.event_log).resolve() if args.event_log else None,
            human_log_path=Path(args.human_log).resolve() if args.human_log else None,
        )
    if args.command == "retry-stage":
        return retry_stage(
            project_root,
            artifact_dir=Path(str(args.artifact_dir)).resolve(),
            stage_name=str(args.stage),
            output_format=str(args.output),
            event_log_path=Path(args.event_log).resolve() if args.event_log else None,
            human_log_path=Path(args.human_log).resolve() if args.human_log else None,
        )
    raise SystemExit(1)


if __name__ == "__main__":
    raise SystemExit(main())
