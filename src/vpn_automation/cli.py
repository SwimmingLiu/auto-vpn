import argparse
import json
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from vpn_automation import artifact_preview
from vpn_automation import backend
from vpn_automation import doctor
from vpn_automation import jobs
from vpn_automation.config.models import resolve_repo_anchor


def _package_version() -> str:
    try:
        return version("vpn-subscription-automation")
    except PackageNotFoundError:
        return "0.0.0"


def _project_root(value: str) -> Path:
    if value:
        return Path(value).resolve()
    return resolve_repo_anchor(Path(__file__))


def _optional_path(value: str) -> Path | None:
    return Path(value).resolve() if value else None


def _optional_proxy_url(value: str) -> str | None:
    return None if not value or value == "auto" else value


def _print_json(payload: str) -> int:
    print(payload)
    return 0


def _set_state(value: object) -> str:
    return "set" if str(value or "").strip() else "missing"


def _profile_summary_json(project_root: Path) -> str:
    payload = json.loads(backend.ensure_profile_json(project_root))
    sources = {
        name: {
            "enabled": bool(config.get("enabled", False)),
            "url": _set_state(config.get("url")),
            "key": _set_state(config.get("key")),
        }
        for name, config in (payload.get("sources") or {}).items()
        if isinstance(config, dict)
    }
    deploy = payload.get("deploy") or {}
    summary = {
        "ok": True,
        "sources": sources,
        "deploy": {
            "project_name": deploy.get("project_name", ""),
            "pages_project_url": deploy.get("pages_project_url", ""),
            "cloudflare_api_token": _set_state(deploy.get("cloudflare_api_token")),
            "cloudflare_global_key": _set_state(deploy.get("cloudflare_global_key")),
            "cloudflare_email": _set_state(deploy.get("cloudflare_email")),
            "account_id": _set_state(deploy.get("account_id")),
            "subscription_url": _set_state(deploy.get("subscription_url")),
            "verify_subscription_url": _set_state(deploy.get("verify_subscription_url")),
            "secret_query": _set_state(deploy.get("secret_query")),
        },
        "paths": payload.get("paths", {}),
    }
    return json.dumps(summary, ensure_ascii=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="autovpn",
        description="AutoVPN headless command line interface",
    )
    parser.add_argument("--version", action="version", version=f"autovpn {_package_version()}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    profile_parser = subparsers.add_parser("profile")
    profile_subparsers = profile_parser.add_subparsers(dest="profile_command", required=True)
    profile_show = profile_subparsers.add_parser("show")
    profile_show.add_argument("--project-root", default="")
    profile_save = profile_subparsers.add_parser("save")
    profile_save.add_argument("--project-root", default="")
    profile_summary = profile_subparsers.add_parser("summary")
    profile_summary.add_argument("--project-root", default="")
    profile_summary.add_argument("--json", action="store_true")

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--project-root", default="")
    run_parser.add_argument("--resume-latest", action="store_true")
    run_parser.add_argument("--skip-deploy", action="store_true")
    run_parser.add_argument("--skip-verify", action="store_true")
    run_parser.add_argument("--output", choices=("jsonl", "human"), default="jsonl")
    run_parser.add_argument("--event-log", default="")
    run_parser.add_argument("--human-log", default="")
    run_parser.add_argument("--detach", action="store_true")
    run_parser.add_argument("--json", action="store_true")
    run_parser.add_argument("--proxy", nargs="?", const="auto", default="")

    doctor_parser = subparsers.add_parser("doctor")
    doctor_parser.add_argument("--project-root", default="")
    doctor_parser.add_argument("--deploy", action="store_true")
    doctor_parser.add_argument("--strict", action="store_true")
    doctor_parser.add_argument("--output", choices=("human", "json"), default="human")

    artifacts_parser = subparsers.add_parser("artifacts")
    artifacts_subparsers = artifacts_parser.add_subparsers(dest="artifacts_command", required=True)
    artifacts_latest = artifacts_subparsers.add_parser("latest")
    artifacts_latest.add_argument("--project-root", default="")
    artifacts_list = artifacts_subparsers.add_parser("list")
    artifacts_list.add_argument("--project-root", default="")
    artifacts_preview = artifacts_subparsers.add_parser("preview")
    artifacts_preview.add_argument("artifact_dir")
    artifacts_preview.add_argument("--project-root", default="")
    artifacts_preview.add_argument("--json", action="store_true")

    retry_parser = subparsers.add_parser("retry-stage")
    retry_parser.add_argument("--project-root", default="")
    retry_parser.add_argument("--artifact-dir", required=True)
    retry_parser.add_argument("--stage", required=True)
    retry_parser.add_argument("--output", choices=("jsonl", "human"), default="jsonl")
    retry_parser.add_argument("--event-log", default="")
    retry_parser.add_argument("--human-log", default="")

    resume_parser = subparsers.add_parser("resume")
    resume_subparsers = resume_parser.add_subparsers(dest="resume_command", required=True)
    resume_pipeline = resume_subparsers.add_parser("pipeline")
    resume_pipeline.add_argument("--project-root", default="")
    resume_pipeline.add_argument("--session", required=True)
    resume_pipeline.add_argument("--output", choices=("jsonl", "human"), default="jsonl")
    resume_pipeline.add_argument("--event-log", default="")
    resume_pipeline.add_argument("--human-log", default="")
    resume_pipeline.add_argument("--proxy", nargs="?", const="auto", default="")
    resume_speedtest = resume_subparsers.add_parser("speedtest")
    resume_speedtest.add_argument("--project-root", default="")
    resume_speedtest.add_argument("--session", required=True)
    resume_speedtest.add_argument("--output", choices=("jsonl", "human"), default="jsonl")
    resume_speedtest.add_argument("--event-log", default="")
    resume_speedtest.add_argument("--human-log", default="")

    jobs_parser = subparsers.add_parser("jobs")
    jobs_parser.add_argument("--project-root", default="")
    jobs_subparsers = jobs_parser.add_subparsers(dest="jobs_command", required=True)
    jobs_list = jobs_subparsers.add_parser("list")
    jobs_list.add_argument("--project-root", default="")
    jobs_list.add_argument("--json", action="store_true")
    jobs_status = jobs_subparsers.add_parser("status")
    jobs_status.add_argument("job_id")
    jobs_status.add_argument("--project-root", default="")
    jobs_status.add_argument("--json", action="store_true")
    jobs_logs = jobs_subparsers.add_parser("logs")
    jobs_logs.add_argument("job_id")
    jobs_logs.add_argument("--project-root", default="")
    jobs_logs.add_argument("--format", choices=("human", "jsonl"), default="human")
    jobs_logs.add_argument("--tail", type=int, default=200)
    jobs_logs.add_argument("--follow", action="store_true")
    jobs_stop = jobs_subparsers.add_parser("stop")
    jobs_stop.add_argument("job_id")
    jobs_stop.add_argument("--project-root", default="")
    jobs_stop.add_argument("--timeout", type=float, default=4.0)
    jobs_resume = jobs_subparsers.add_parser("resume")
    jobs_resume.add_argument("job_id")
    jobs_resume.add_argument("--project-root", default="")
    jobs_resume.add_argument("--detach", action="store_true")
    jobs_resume.add_argument("--json", action="store_true")
    jobs_resume.add_argument("--output", choices=("jsonl", "human"), default="jsonl")
    jobs_retry = jobs_subparsers.add_parser("retry")
    jobs_retry.add_argument("--project-root", default="")
    jobs_retry.add_argument("--artifact-dir", required=True)
    jobs_retry.add_argument("--stage", required=True)
    jobs_retry.add_argument("--detach", action="store_true")
    jobs_retry.add_argument("--json", action="store_true")
    jobs_retry.add_argument("--output", choices=("jsonl", "human"), default="jsonl")

    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("--project-root", default="")
    status_parser.add_argument("--json", action="store_true")

    logs_parser = subparsers.add_parser("logs")
    logs_parser.add_argument("--project-root", default="")
    logs_parser.add_argument("--format", choices=("human", "jsonl"), default="human")
    logs_parser.add_argument("--tail", type=int, default=200)
    logs_parser.add_argument("--follow", action="store_true")

    stop_parser = subparsers.add_parser("stop")
    stop_parser.add_argument("--project-root", default="")
    stop_parser.add_argument("--timeout", type=float, default=4.0)

    return parser


def dispatch(args: argparse.Namespace) -> int:
    if args.command == "profile":
        project_root = _project_root(str(args.project_root))
        if args.profile_command == "show":
            return _print_json(backend.ensure_profile_json(project_root))
        if args.profile_command == "save":
            return _print_json(backend.save_profile_json(project_root, sys.stdin.read()))
        if args.profile_command == "summary":
            return _print_json(_profile_summary_json(project_root))

    if args.command == "artifacts":
        project_root = _project_root(str(args.project_root))
        if args.artifacts_command == "latest":
            return _print_json(backend.artifact_latest_json(project_root))
        if args.artifacts_command == "list":
            return _print_json(backend.artifact_list_json(project_root))
        if args.artifacts_command == "preview":
            return _print_json(artifact_preview.preview_artifact_json(Path(str(args.artifact_dir))))

    if args.command == "run":
        candidate = Path(str(args.project_root) or __file__)
        project_root = Path(str(args.project_root)).resolve() if args.project_root else resolve_repo_anchor(candidate)
        if args.detach:
            job = jobs.start_detached_run(
                project_root,
                resume_latest=bool(args.resume_latest),
                skip_deploy=bool(args.skip_deploy),
                skip_verify=bool(args.skip_verify),
                output_format=str(args.output),
                use_proxy=bool(args.proxy),
                proxy_url=_optional_proxy_url(str(args.proxy)),
            )
            payload = {"ok": True, **jobs.public_job_payload(job)}
            if args.json:
                print(doctor.render_json(payload))
            else:
                print(f"started job {job['job_id']} pid={job['pid']}")
            return 0
        options = {
            "skip_deploy": bool(args.skip_deploy),
            "skip_verify": bool(args.skip_verify),
            "output_format": str(args.output),
            "event_log_path": _optional_path(str(args.event_log)),
            "human_log_path": _optional_path(str(args.human_log)),
            "use_proxy": bool(args.proxy),
            "proxy_url": _optional_proxy_url(str(args.proxy)),
        }
        if args.resume_latest:
            return backend.run_pipeline_resume_latest(project_root, candidate.resolve(), **options)
        return backend.run_pipeline(project_root, candidate.resolve(), **options)

    if args.command == "doctor":
        project_root = _project_root(str(args.project_root))
        code, payload = doctor.run_doctor(
            project_root,
            deploy=bool(args.deploy),
            strict=bool(args.strict),
        )
        if args.output == "json":
            print(doctor.render_json(payload))
        else:
            print(doctor.render_human(payload))
        return code

    if args.command == "retry-stage":
        project_root = _project_root(str(args.project_root))
        return backend.retry_stage(
            project_root,
            artifact_dir=Path(str(args.artifact_dir)).resolve(),
            stage_name=str(args.stage),
            output_format=str(args.output),
            event_log_path=_optional_path(str(args.event_log)),
            human_log_path=_optional_path(str(args.human_log)),
        )

    if args.command == "resume":
        project_root = _project_root(str(args.project_root))
        options = {
            "session_dir": Path(str(args.session)).resolve(),
            "output_format": str(args.output),
            "event_log_path": _optional_path(str(args.event_log)),
            "human_log_path": _optional_path(str(args.human_log)),
        }
        if args.resume_command == "pipeline":
            options["use_proxy"] = bool(args.proxy)
            options["proxy_url"] = _optional_proxy_url(str(args.proxy))
            return backend.resume_pipeline(project_root, **options)
        if args.resume_command == "speedtest":
            return backend.resume_speedtest(project_root, **options)

    if args.command == "jobs":
        project_root = _project_root(str(args.project_root))
        if args.jobs_command == "list":
            payload = jobs.list_jobs(project_root)
            print(doctor.render_json(payload))
            return 0
        if args.jobs_command == "status":
            job = jobs.job_status(project_root, str(args.job_id))
            print(doctor.render_json(jobs.public_job_payload(job)))
            return 0
        if args.jobs_command == "logs":
            if args.follow:
                jobs.follow_log(
                    project_root,
                    str(args.job_id),
                    log_format=str(args.format),
                    tail=int(args.tail),
                )
                return 0
            print(
                jobs.tail_log(
                    project_root,
                    str(args.job_id),
                    log_format=str(args.format),
                    tail=int(args.tail),
                ),
                end="",
            )
            return 0
        if args.jobs_command == "stop":
            job = jobs.stop_job(project_root, str(args.job_id), timeout_seconds=float(args.timeout))
            print(doctor.render_json(jobs.public_job_payload(job)))
            return 0
        if args.jobs_command == "resume":
            source_job = jobs.load_job(project_root, str(args.job_id))
            try:
                session_dir = jobs.resolve_resume_session_dir(source_job)
            except RuntimeError:
                if str(source_job.get("kind", "")) != "run":
                    raise
                source_options = source_job.get("options") or {}
                skip_deploy = bool(source_options.get("skip_deploy", False))
                skip_verify = bool(source_options.get("skip_verify", False))
                if args.detach:
                    job = jobs.start_detached_run(
                        project_root,
                        resume_latest=True,
                        skip_deploy=skip_deploy,
                        skip_verify=skip_verify,
                        output_format=str(args.output),
                        source_job_id=str(args.job_id),
                    )
                    payload = {"ok": True, **jobs.public_job_payload(job)}
                    print(doctor.render_json(payload) if args.json else f"started job {job['job_id']} pid={job['pid']}")
                    return 0
                return backend.run_pipeline_resume_latest(
                    project_root,
                    project_root,
                    skip_deploy=skip_deploy,
                    skip_verify=skip_verify,
                    output_format=str(args.output),
                )
            if args.detach:
                job = jobs.start_detached_resume(
                    project_root,
                    source_job_id=str(args.job_id),
                    session_dir=session_dir,
                    output_format=str(args.output),
                )
                payload = {"ok": True, **jobs.public_job_payload(job)}
                print(doctor.render_json(payload) if args.json else f"started job {job['job_id']} pid={job['pid']}")
                return 0
            return backend.resume_pipeline(
                project_root,
                session_dir=session_dir,
                output_format=str(args.output),
            )
        if args.jobs_command == "retry":
            artifact_dir = Path(str(args.artifact_dir)).resolve()
            if args.detach:
                job = jobs.start_detached_retry(
                    project_root,
                    artifact_dir=artifact_dir,
                    stage_name=str(args.stage),
                    output_format=str(args.output),
                )
                payload = {"ok": True, **jobs.public_job_payload(job)}
                print(doctor.render_json(payload) if args.json else f"started job {job['job_id']} pid={job['pid']}")
                return 0
            return backend.retry_stage(
                project_root,
                artifact_dir=artifact_dir,
                stage_name=str(args.stage),
                output_format=str(args.output),
            )

    if args.command == "status":
        project_root = _project_root(str(args.project_root))
        job = jobs.job_status(project_root, jobs.latest_job_id(project_root))
        print(doctor.render_json(jobs.public_job_payload(job)))
        return 0

    if args.command == "logs":
        project_root = _project_root(str(args.project_root))
        if args.follow:
            jobs.follow_log(
                project_root,
                jobs.latest_job_id(project_root),
                log_format=str(args.format),
                tail=int(args.tail),
            )
            return 0
        print(
            jobs.tail_log(
                project_root,
                jobs.latest_job_id(project_root),
                log_format=str(args.format),
                tail=int(args.tail),
            ),
            end="",
        )
        return 0

    if args.command == "stop":
        project_root = _project_root(str(args.project_root))
        job = jobs.stop_job(project_root, jobs.single_active_job_id(project_root), timeout_seconds=float(args.timeout))
        print(doctor.render_json(jobs.public_job_payload(job)))
        return 0

    raise SystemExit(1)


def main(argv: list[str] | None = None) -> int:
    if argv is not None and argv == ["--version"]:
        print(f"autovpn {_package_version()}")
        return 0

    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return dispatch(args)
    except Exception as exc:
        print(f"autovpn: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
