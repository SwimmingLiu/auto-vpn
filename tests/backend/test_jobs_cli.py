import json
import signal
from pathlib import Path
from types import SimpleNamespace

from vpn_automation import cli, jobs


def test_run_detach_creates_job_and_returns_json(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    popen_calls = []

    class FakePopen:
        pid = 12345

        def __init__(self, command, **kwargs) -> None:
            popen_calls.append((command, kwargs))

    monkeypatch.setattr(jobs.subprocess, "Popen", FakePopen)

    code = cli.main(
        [
            "run",
            "--project-root",
            str(project_root),
            "--skip-deploy",
            "--skip-verify",
            "--detach",
            "--json",
        ]
    )

    payload = json.loads(capsys.readouterr().out)
    job_file = Path(payload["job_file"])
    job_payload = json.loads(job_file.read_text(encoding="utf-8"))
    command, kwargs = popen_calls[0]
    assert code == 0
    assert payload["ok"] is True
    assert payload["status"] == "running"
    assert "--event-log" in command
    assert "--human-log" in command
    assert kwargs["cwd"] == str(project_root.resolve())
    assert kwargs["start_new_session"] is True
    assert job_payload["pid"] == 12345
    assert job_payload["options"]["skip_deploy"] is True
    assert job_payload["options"]["skip_verify"] is True


def test_jobs_status_reconciles_success_summary_event(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    job = jobs.create_job(
        project_root,
        kind="run",
        command=["python", "-m", "vpn_automation.backend", "run"],
        pid=12345,
        options={},
    )
    Path(job["event_log"]).write_text(
        json.dumps({"type": "summary", "run_status": "success", "artifact_dir": "/tmp/artifact"}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(jobs, "process_alive", lambda pid: False)

    code = cli.main(["jobs", "status", job["job_id"], "--project-root", str(project_root), "--json"])

    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload["status"] == "success"
    assert payload["artifact_dir"] == "/tmp/artifact"


def test_jobs_status_redacts_report_error_in_last_error(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = project_root / "artifacts" / "20260626-153012"
    artifact_dir.mkdir(parents=True)
    (artifact_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "run_status": "failed",
                "error": "deploy failed https://sub.example/sub?token=REPORT-SECRET serect_key=QUERY-SECRET",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    job = jobs.create_job(
        project_root,
        kind="run",
        command=["python", "-m", "vpn_automation.backend", "run"],
        pid=12345,
        options={},
    )
    payload = json.loads(Path(job["job_file"]).read_text(encoding="utf-8"))
    payload["artifact_dir"] = str(artifact_dir)
    Path(job["job_file"]).write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setattr(jobs, "process_alive", lambda pid: False)

    code = cli.main(["jobs", "status", job["job_id"], "--project-root", str(project_root), "--json"])

    status_payload = json.loads(capsys.readouterr().out)
    serialized = json.dumps(status_payload, ensure_ascii=False)
    assert code == 0
    assert status_payload["status"] == "failed"
    assert "REPORT-SECRET" not in serialized
    assert "QUERY-SECRET" not in serialized


def test_jobs_logs_tails_human_log(tmp_path: Path, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    job = jobs.create_job(
        project_root,
        kind="run",
        command=["python", "-m", "vpn_automation.backend", "run"],
        pid=12345,
        options={},
    )
    Path(job["human_log"]).write_text("one\ntwo\nthree\n", encoding="utf-8")

    code = cli.main(
        [
            "jobs",
            "logs",
            job["job_id"],
            "--project-root",
            str(project_root),
            "--format",
            "human",
            "--tail",
            "2",
        ]
    )

    assert code == 0
    assert capsys.readouterr().out == "two\nthree\n"


def test_jobs_logs_follow_completed_job_prints_tail_and_exits(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    job = jobs.create_job(
        project_root,
        kind="run",
        command=["python", "-m", "vpn_automation.backend", "run"],
        pid=12345,
        options={},
    )
    Path(job["human_log"]).write_text("one\ntwo\n", encoding="utf-8")
    Path(job["event_log"]).write_text(json.dumps({"type": "summary", "run_status": "success"}) + "\n", encoding="utf-8")
    monkeypatch.setattr(jobs, "process_alive", lambda pid: False)

    code = cli.main(
        [
            "jobs",
            "logs",
            job["job_id"],
            "--project-root",
            str(project_root),
            "--follow",
            "--tail",
            "1",
        ]
    )

    assert code == 0
    assert capsys.readouterr().out == "two\n"


def test_jobs_stop_sends_term_then_kill_to_process_group(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    job = jobs.create_job(
        project_root,
        kind="run",
        command=["python", "-m", "vpn_automation.backend", "run"],
        pid=12345,
        options={},
    )
    alive_states = iter([True, True, False])
    sent = []
    monkeypatch.setattr(jobs, "process_alive", lambda pid: next(alive_states))
    monkeypatch.setattr(jobs.os, "killpg", lambda pgid, sig: sent.append((pgid, sig)))
    monkeypatch.setattr(jobs.time, "sleep", lambda seconds: None)

    code = cli.main(["jobs", "stop", job["job_id"], "--project-root", str(project_root), "--timeout", "0"])

    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload["status"] == "stopped"
    assert sent == [(12345, signal.SIGTERM), (12345, signal.SIGKILL)]


def test_latest_status_alias_uses_latest_job(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    first = jobs.create_job(project_root, kind="run", command=["cmd"], pid=111, options={})
    latest = jobs.create_job(project_root, kind="run", command=["cmd"], pid=222, options={})
    monkeypatch.setattr(jobs, "process_alive", lambda pid: True)

    code = cli.main(["status", "--project-root", str(project_root), "--json"])

    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload["job_id"] == latest["job_id"]
    assert payload["job_id"] != first["job_id"]
    assert payload["status"] == "running"


def test_jobs_resume_detach_uses_previous_session_dir(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    original = jobs.create_job(project_root, kind="run", command=["cmd"], pid=111, options={})
    Path(original["session_dir"], "session.json").write_text("{}", encoding="utf-8")
    popen_calls = []

    class FakePopen:
        pid = 333

        def __init__(self, command, **kwargs) -> None:
            popen_calls.append((command, kwargs))

    monkeypatch.setattr(jobs.subprocess, "Popen", FakePopen)

    code = cli.main(
        [
            "jobs",
            "resume",
            original["job_id"],
            "--project-root",
            str(project_root),
            "--detach",
            "--json",
        ]
    )

    payload = json.loads(capsys.readouterr().out)
    command, kwargs = popen_calls[0]
    assert code == 0
    assert payload["kind"] == "resume"
    assert payload["options"]["source_job_id"] == original["job_id"]
    assert "resume-pipeline" in command
    assert "--session" in command
    assert original["session_dir"] in command
    assert kwargs["start_new_session"] is True


def test_jobs_resume_fails_when_source_job_has_no_session_json(tmp_path: Path, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    original = jobs.create_job(project_root, kind="resume", command=["cmd"], pid=111, options={})

    code = cli.main(
        [
            "jobs",
            "resume",
            original["job_id"],
            "--project-root",
            str(project_root),
            "--detach",
            "--json",
        ]
    )

    captured = capsys.readouterr()
    assert code == 1
    assert captured.out == ""
    assert "cannot resume job without session.json" in captured.err


def test_jobs_resume_detach_without_session_uses_resume_latest_run(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    original = jobs.create_job(
        project_root,
        kind="run",
        command=["cmd"],
        pid=111,
        options={"skip_deploy": True, "skip_verify": True},
    )
    popen_calls = []

    class FakePopen:
        pid = 555

        def __init__(self, command, **kwargs) -> None:
            popen_calls.append((command, kwargs))

    monkeypatch.setattr(jobs.subprocess, "Popen", FakePopen)

    code = cli.main(
        [
            "jobs",
            "resume",
            original["job_id"],
            "--project-root",
            str(project_root),
            "--detach",
            "--json",
        ]
    )

    payload = json.loads(capsys.readouterr().out)
    command, kwargs = popen_calls[0]
    assert code == 0
    assert payload["kind"] == "run"
    assert payload["options"]["source_job_id"] == original["job_id"]
    assert payload["options"]["resume_latest"] is True
    assert payload["options"]["skip_deploy"] is True
    assert payload["options"]["skip_verify"] is True
    assert "run" in command
    assert "--resume-latest" in command
    assert "--skip-deploy" in command
    assert "--skip-verify" in command
    assert kwargs["start_new_session"] is True


def test_jobs_retry_detach_records_retry_context(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = project_root / "artifacts" / "20260626-153012"
    popen_calls = []

    class FakePopen:
        pid = 444

        def __init__(self, command, **kwargs) -> None:
            popen_calls.append((command, kwargs))

    monkeypatch.setattr(jobs.subprocess, "Popen", FakePopen)

    code = cli.main(
        [
            "jobs",
            "retry",
            "--project-root",
            str(project_root),
            "--artifact-dir",
            str(artifact_dir),
            "--stage",
            "deploy",
            "--detach",
            "--json",
        ]
    )

    payload = json.loads(capsys.readouterr().out)
    command, kwargs = popen_calls[0]
    assert code == 0
    assert payload["kind"] == "retry"
    assert payload["retry"] == {"source_artifact_dir": str(artifact_dir.resolve()), "stage": "deploy"}
    assert "retry-stage" in command
    assert "--artifact-dir" in command
    assert str(artifact_dir.resolve()) in command
    assert "--stage" in command
    assert "deploy" in command
    assert kwargs["start_new_session"] is True


def test_latest_stop_fails_when_multiple_jobs_are_active(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    jobs.create_job(project_root, kind="run", command=["cmd"], pid=111, options={})
    jobs.create_job(project_root, kind="run", command=["cmd"], pid=222, options={})
    monkeypatch.setattr(jobs, "process_alive", lambda pid: True)

    code = cli.main(["stop", "--project-root", str(project_root)])

    captured = capsys.readouterr()
    assert code == 1
    assert "multiple active jobs" in captured.err
