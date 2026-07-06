import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from vpn_automation.config.store import resolve_profile_path
from vpn_automation.pipeline.run_store import RunStore
from vpn_automation.redaction import redact_text


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def jobs_root(project_root: Path) -> Path:
    return resolve_profile_path(project_root).parent / "jobs"


def index_path(project_root: Path) -> Path:
    return jobs_root(project_root) / "index.json"


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def new_job_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:6]}"


def load_index(project_root: Path) -> dict:
    path = index_path(project_root)
    if not path.exists():
        return {"schema_version": 1, "latest_job_id": "", "jobs": []}
    return read_json(path)


def update_index(project_root: Path, job: dict) -> None:
    index = load_index(project_root)
    jobs = [item for item in index.get("jobs", []) if item.get("job_id") != job["job_id"]]
    jobs.append(
        {
            "job_id": job["job_id"],
            "status": job["status"],
            "kind": job["kind"],
            "created_at": job["created_at"],
            "job_file": job["job_file"],
        }
    )
    index["schema_version"] = 1
    index["latest_job_id"] = job["job_id"]
    index["jobs"] = jobs
    atomic_write_json(index_path(project_root), index)


def write_job(project_root: Path, job: dict) -> dict:
    job["updated_at"] = now_iso()
    atomic_write_json(Path(job["job_file"]), job)
    update_index(project_root, job)
    return job


def create_job(
    project_root: Path,
    *,
    kind: str,
    command: list[str],
    pid: int,
    options: dict,
    retry: dict | None = None,
) -> dict:
    root = jobs_root(project_root)
    job_id = new_job_id()
    job_dir = root / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    created_at = now_iso()
    job = {
        "schema_version": 1,
        "job_id": job_id,
        "kind": kind,
        "status": "running",
        "pid": int(pid),
        "pgid": int(pid),
        "created_at": created_at,
        "started_at": created_at,
        "finished_at": "",
        "updated_at": created_at,
        "exit_code": None,
        "signal": "",
        "project_root": str(project_root),
        "command": command,
        "event_log": str(job_dir / "events.jsonl"),
        "human_log": str(job_dir / "human.log"),
        "stdout_log": str(job_dir / "stdout.log"),
        "stderr_log": str(job_dir / "stderr.log"),
        "artifact_dir": "",
        "session_dir": str(job_dir),
        "resume_from": "",
        "retry": retry or {"source_artifact_dir": "", "stage": ""},
        "options": options,
        "stop_requested_at": "",
        "last_event_at": "",
        "last_error": "",
        "job_file": str(job_dir / "job.json"),
    }
    for log_name in ("event_log", "human_log", "stdout_log", "stderr_log"):
        Path(job[log_name]).touch()
    return write_job(project_root, job)


def load_job(project_root: Path, job_id: str) -> dict:
    path = jobs_root(project_root) / job_id / "job.json"
    if not path.exists():
        raise FileNotFoundError(f"job not found: {job_id}")
    return read_json(path)


def latest_job_id(project_root: Path) -> str:
    index = load_index(project_root)
    job_id = str(index.get("latest_job_id", ""))
    if not job_id:
        raise FileNotFoundError("no jobs found")
    return job_id


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_matches_job(pid: int, command: list[str]) -> bool:
    cmdline_path = Path("/proc") / str(pid) / "cmdline"
    if not cmdline_path.exists():
        return True
    try:
        cmdline = cmdline_path.read_bytes().replace(b"\x00", b" ").decode("utf-8", errors="ignore")
    except OSError:
        return False
    expected_markers = ["vpn_automation.backend"]
    if command:
        expected_markers.append(Path(str(command[0])).name)
    return any(marker and marker in cmdline for marker in expected_markers)


def _last_json_events(path: Path) -> list[dict]:
    if not path.exists():
        return []
    events: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def reconcile_job(project_root: Path, job: dict) -> dict:
    events = _last_json_events(Path(job["event_log"]))
    for event in events:
        job["last_event_at"] = now_iso()
        if event.get("type") == "run_started" and event.get("artifact_dir"):
            job["artifact_dir"] = str(event.get("artifact_dir"))
        if event.get("type") == "summary":
            job["artifact_dir"] = str(event.get("artifact_dir") or job.get("artifact_dir", ""))
            run_status = str(event.get("run_status") or "")
            if run_status in {"success", "failed", "stopped"}:
                job["status"] = run_status
                job["finished_at"] = job.get("finished_at") or now_iso()
                job["exit_code"] = 0 if run_status == "success" else 1
            if event.get("error"):
                job["last_error"] = str(event.get("error"))
        if event.get("type") == "run_failed":
            job["status"] = "failed"
            job["last_error"] = redact_text(str(event.get("error", "run failed")))
            job["finished_at"] = job.get("finished_at") or now_iso()
            job["exit_code"] = 1

    if job.get("status") in {"running", "stopping"}:
        report_status = _reconcile_from_pipeline_report(job)
        if report_status:
            job.update(report_status)
        else:
            store_status = _reconcile_from_run_db(job)
            if store_status:
                job.update(store_status)

    if job.get("status") in {"running", "stopping"} and not process_alive(int(job.get("pid") or 0)):
        if job.get("status") == "stopping":
            job["status"] = "stopped"
        elif not events:
            job["status"] = "failed"
            job["last_error"] = "process exited without summary"
        elif job.get("status") == "running":
            job["status"] = "failed"
            job["last_error"] = job.get("last_error") or "process exited without terminal status"
        job["finished_at"] = job.get("finished_at") or now_iso()
        if job.get("exit_code") is None:
            job["exit_code"] = 1

    return write_job(project_root, job)


def _reconcile_from_pipeline_report(job: dict) -> dict | None:
    artifact_dir = str(job.get("artifact_dir") or "")
    if not artifact_dir:
        return None
    report_path = Path(artifact_dir) / "pipeline_report.json"
    if not report_path.exists():
        return None
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    run_status = str(report.get("run_status") or "")
    if run_status not in {"success", "failed", "stopped"}:
        return None
    return {
        "status": run_status,
        "finished_at": job.get("finished_at") or now_iso(),
        "exit_code": 0 if run_status == "success" else 1,
        "last_error": redact_text(str(report.get("error", job.get("last_error", "")) or "")),
    }


def _reconcile_from_run_db(job: dict) -> dict | None:
    artifact_dir = str(job.get("artifact_dir") or "")
    if not artifact_dir:
        return None
    run_db = Path(artifact_dir) / "run.db"
    if not run_db.exists():
        return None
    try:
        run_status = RunStore(run_db).fetch_run_status()
    except Exception:
        return None
    if run_status not in {"success", "failed", "stopped"}:
        return None
    return {
        "status": run_status,
        "finished_at": job.get("finished_at") or now_iso(),
        "exit_code": 0 if run_status == "success" else 1,
    }


def job_status(project_root: Path, job_id: str) -> dict:
    return reconcile_job(project_root, load_job(project_root, job_id))


def list_jobs(project_root: Path) -> dict:
    index = load_index(project_root)
    items = []
    for item in index.get("jobs", []):
        try:
            job = job_status(project_root, item["job_id"])
            items.append(
                {
                    "job_id": job["job_id"],
                    "status": job["status"],
                    "kind": job["kind"],
                    "created_at": job["created_at"],
                    "job_file": job["job_file"],
                }
            )
        except FileNotFoundError:
            continue
    index["jobs"] = items
    atomic_write_json(index_path(project_root), index)
    return {"ok": True, "jobs": items, "latest_job_id": index.get("latest_job_id", "")}


def active_job_ids(project_root: Path) -> list[str]:
    active: list[str] = []
    for item in load_index(project_root).get("jobs", []):
        try:
            job = job_status(project_root, item["job_id"])
        except FileNotFoundError:
            continue
        if job.get("status") in {"running", "stopping"} and process_alive(int(job.get("pid") or 0)):
            active.append(str(job["job_id"]))
    return active


def single_active_job_id(project_root: Path) -> str:
    active = active_job_ids(project_root)
    if len(active) > 1:
        raise RuntimeError(f"multiple active jobs: {', '.join(active)}")
    if not active:
        raise RuntimeError("no active jobs")
    return active[0]


def resolve_resume_session_dir(job: dict) -> Path:
    candidates = [
        str(job.get("resume_from") or ""),
        str((job.get("options") or {}).get("session_dir") or ""),
        str(job.get("session_dir") or ""),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate).resolve()
        if (path / "session.json").exists():
            return path
    raise RuntimeError("cannot resume job without session.json")


def build_backend_run_command(
    *,
    project_root: Path,
    event_log: Path,
    human_log: Path,
    resume_latest: bool,
    skip_deploy: bool,
    skip_verify: bool,
    output_format: str,
    use_proxy: bool = False,
    proxy_url: str | None = None,
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "vpn_automation.backend",
        "run",
        "--project-root",
        str(project_root),
        "--output",
        output_format,
        "--event-log",
        str(event_log),
        "--human-log",
        str(human_log),
    ]
    if resume_latest:
        command.append("--resume-latest")
    if skip_deploy:
        command.append("--skip-deploy")
    if skip_verify:
        command.append("--skip-verify")
    if use_proxy:
        command.append("--proxy")
        if proxy_url:
            command.append(proxy_url)
    return command


def start_detached_run(
    project_root: Path,
    *,
    resume_latest: bool = False,
    skip_deploy: bool = False,
    skip_verify: bool = False,
    output_format: str = "jsonl",
    source_job_id: str = "",
    use_proxy: bool = False,
    proxy_url: str | None = None,
) -> dict:
    root = jobs_root(project_root)
    job_id = new_job_id()
    job_dir = root / job_id
    event_log = job_dir / "events.jsonl"
    human_log = job_dir / "human.log"
    command = build_backend_run_command(
        project_root=project_root,
        event_log=event_log,
        human_log=human_log,
        resume_latest=resume_latest,
        skip_deploy=skip_deploy,
        skip_verify=skip_verify,
        output_format=output_format,
        use_proxy=use_proxy,
        proxy_url=proxy_url,
    )
    return _start_detached_backend_job(
        project_root,
        job_id=job_id,
        kind="run",
        command=command,
        options={
            "source_job_id": source_job_id,
            "resume_latest": resume_latest,
            "skip_deploy": skip_deploy,
            "skip_verify": skip_verify,
            "output_format": output_format,
            "use_proxy": use_proxy,
            "proxy_url": proxy_url or "",
        },
    )


def _start_detached_backend_job(
    project_root: Path,
    *,
    job_id: str,
    kind: str,
    command: list[str],
    options: dict,
    retry: dict | None = None,
) -> dict:
    root = jobs_root(project_root)
    job_dir = root / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    event_log = job_dir / "events.jsonl"
    human_log = job_dir / "human.log"
    stdout_log = job_dir / "stdout.log"
    stderr_log = job_dir / "stderr.log"
    with stdout_log.open("a", encoding="utf-8") as stdout_handle, stderr_log.open("a", encoding="utf-8") as stderr_handle:
        child = subprocess.Popen(
            command,
            cwd=str(project_root),
            stdin=subprocess.DEVNULL,
            stdout=stdout_handle,
            stderr=stderr_handle,
            start_new_session=True,
        )

    created_at = now_iso()
    job = {
        "schema_version": 1,
        "job_id": job_id,
        "kind": kind,
        "status": "running",
        "pid": int(child.pid),
        "pgid": int(child.pid),
        "created_at": created_at,
        "started_at": created_at,
        "finished_at": "",
        "updated_at": created_at,
        "exit_code": None,
        "signal": "",
        "project_root": str(project_root),
        "command": command,
        "event_log": str(event_log),
        "human_log": str(human_log),
        "stdout_log": str(stdout_log),
        "stderr_log": str(stderr_log),
        "artifact_dir": "",
        "session_dir": str(job_dir),
        "resume_from": "",
        "retry": retry or {"source_artifact_dir": "", "stage": ""},
        "options": options,
        "stop_requested_at": "",
        "last_event_at": "",
        "last_error": "",
        "job_file": str(job_dir / "job.json"),
    }
    event_log.touch()
    human_log.touch()
    return write_job(project_root, job)


def start_detached_resume(
    project_root: Path,
    *,
    source_job_id: str,
    session_dir: Path,
    output_format: str = "jsonl",
    use_proxy: bool = False,
    proxy_url: str | None = None,
) -> dict:
    job_id = new_job_id()
    job_dir = jobs_root(project_root) / job_id
    command = [
        sys.executable,
        "-m",
        "vpn_automation.backend",
        "resume-pipeline",
        "--project-root",
        str(project_root),
        "--session",
        str(session_dir),
        "--output",
        output_format,
        "--event-log",
        str(job_dir / "events.jsonl"),
        "--human-log",
        str(job_dir / "human.log"),
    ]
    if use_proxy:
        command.append("--proxy")
        if proxy_url:
            command.append(proxy_url)
    job = _start_detached_backend_job(
        project_root,
        job_id=job_id,
        kind="resume",
        command=command,
        options={
            "source_job_id": source_job_id,
            "session_dir": str(session_dir),
            "output_format": output_format,
            "use_proxy": use_proxy,
            "proxy_url": proxy_url or "",
        },
    )
    job["resume_from"] = str(session_dir)
    return write_job(project_root, job)


def start_detached_retry(
    project_root: Path,
    *,
    artifact_dir: Path,
    stage_name: str,
    output_format: str = "jsonl",
) -> dict:
    job_id = new_job_id()
    job_dir = jobs_root(project_root) / job_id
    retry = {"source_artifact_dir": str(artifact_dir), "stage": stage_name}
    command = [
        sys.executable,
        "-m",
        "vpn_automation.backend",
        "retry-stage",
        "--project-root",
        str(project_root),
        "--artifact-dir",
        str(artifact_dir),
        "--stage",
        stage_name,
        "--output",
        output_format,
        "--event-log",
        str(job_dir / "events.jsonl"),
        "--human-log",
        str(job_dir / "human.log"),
    ]
    return _start_detached_backend_job(
        project_root,
        job_id=job_id,
        kind="retry",
        command=command,
        options={"artifact_dir": str(artifact_dir), "stage": stage_name, "output_format": output_format},
        retry=retry,
    )


def tail_log(project_root: Path, job_id: str, *, log_format: str = "human", tail: int = 200) -> str:
    job = load_job(project_root, job_id)
    path = Path(job["event_log"] if log_format == "jsonl" else job["human_log"])
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8").splitlines()
    if tail > 0:
        lines = lines[-tail:]
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


def follow_log(
    project_root: Path,
    job_id: str,
    *,
    log_format: str = "human",
    tail: int = 200,
    poll_interval: float = 1.0,
) -> None:
    job = load_job(project_root, job_id)
    path = Path(job["event_log"] if log_format == "jsonl" else job["human_log"])
    printed = tail_log(project_root, job_id, log_format=log_format, tail=tail)
    if printed:
        print(printed, end="", flush=True)
    offset = path.stat().st_size if path.exists() else 0
    while True:
        current = job_status(project_root, job_id)
        if path.exists():
            with path.open("r", encoding="utf-8") as handle:
                handle.seek(offset)
                chunk = handle.read()
                offset = handle.tell()
            if chunk:
                print(chunk, end="", flush=True)
        if current.get("status") not in {"running", "stopping"}:
            break
        time.sleep(poll_interval)


def stop_job(project_root: Path, job_id: str, *, timeout_seconds: float = 4.0) -> dict:
    job = load_job(project_root, job_id)
    pid = int(job.get("pgid") or job.get("pid") or 0)
    job["status"] = "stopping"
    job["stop_requested_at"] = now_iso()
    write_job(project_root, job)
    if pid > 0 and process_alive(pid):
        if not process_matches_job(pid, list(job.get("command") or [])):
            raise RuntimeError(f"refusing to stop pid {pid}: command does not match AutoVPN job")
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.time() + timeout_seconds
        while time.time() < deadline and process_alive(pid):
            time.sleep(0.1)
        if process_alive(pid):
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    job["status"] = "stopped"
    job["finished_at"] = now_iso()
    job["exit_code"] = 1
    job["signal"] = "SIGTERM"
    return write_job(project_root, job)


def public_job_payload(job: dict) -> dict:
    payload = {
        key: job.get(key)
        for key in (
            "job_id",
            "kind",
            "status",
            "pid",
            "pgid",
            "created_at",
            "started_at",
            "finished_at",
            "exit_code",
            "signal",
            "project_root",
            "event_log",
            "human_log",
            "stdout_log",
            "stderr_log",
            "artifact_dir",
            "session_dir",
            "options",
            "retry",
            "stop_requested_at",
            "last_event_at",
            "last_error",
            "job_file",
        )
    }
    if payload.get("last_error"):
        payload["last_error"] = redact_text(str(payload["last_error"]))
    return payload
