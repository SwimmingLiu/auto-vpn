import io
import json
from pathlib import Path

from vpn_automation import cli


def test_cli_version_prints_package_version(capsys) -> None:
    code = cli.main(["--version"])

    captured = capsys.readouterr()
    assert code == 0
    assert captured.out.strip() == "autovpn 1.3.0"


def test_profile_show_maps_to_backend_profile_json(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    called = {}

    def fake_profile(root: Path) -> str:
        called["root"] = root
        return json.dumps({"ok": True, "paths": {"project_root": str(root)}})

    monkeypatch.setattr(cli.backend, "ensure_profile_json", fake_profile)

    code = cli.main(["profile", "show", "--project-root", str(project_root)])

    captured = capsys.readouterr()
    assert code == 0
    assert called == {"root": project_root.resolve()}
    assert json.loads(captured.out)["paths"]["project_root"] == str(project_root.resolve())


def test_profile_save_reads_stdin_and_maps_to_backend_save(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    profile_payload = json.dumps({"sources": {"leiting": {"key": "demo"}}})
    called = {}

    def fake_save(root: Path, payload: str) -> str:
        called["root"] = root
        called["payload"] = payload
        return json.dumps({"ok": True})

    monkeypatch.setattr(cli.backend, "save_profile_json", fake_save)
    monkeypatch.setattr("sys.stdin", io.StringIO(profile_payload))

    code = cli.main(["profile", "save", "--project-root", str(project_root)])

    captured = capsys.readouterr()
    assert code == 0
    assert called == {"root": project_root.resolve(), "payload": profile_payload}
    assert json.loads(captured.out) == {"ok": True}


def test_profile_summary_redacts_secret_values(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    monkeypatch.setattr(
        cli.backend,
        "ensure_profile_json",
        lambda root: json.dumps(
            {
                "sources": {
                    "leiting": {
                        "enabled": True,
                        "url": "https://source.example/api?token=SOURCE-SECRET",
                        "key": "KEY-SECRET",
                    }
                },
                "deploy": {
                    "project_name": "sub-nodes",
                    "cloudflare_api_token": "CF-SECRET",
                    "subscription_url": "https://sub.example/sub?token=SUB-SECRET",
                    "verify_subscription_url": "https://verify.example/sub?token=VERIFY-SECRET",
                    "account_id": "ACCOUNT-SECRET",
                },
                "paths": {"project_root": str(root)},
            }
        ),
    )

    code = cli.main(["profile", "summary", "--project-root", str(project_root), "--json"])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    serialized = json.dumps(payload, ensure_ascii=False)
    assert code == 0
    assert payload["sources"]["leiting"]["key"] == "set"
    assert payload["sources"]["leiting"]["url"] == "set"
    assert payload["deploy"]["cloudflare_api_token"] == "set"
    assert "KEY-SECRET" not in serialized
    assert "SOURCE-SECRET" not in serialized
    assert "CF-SECRET" not in serialized
    assert "SUB-SECRET" not in serialized
    assert "VERIFY-SECRET" not in serialized
    assert "ACCOUNT-SECRET" not in serialized


def test_artifacts_latest_preserves_empty_backend_response(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"

    monkeypatch.setattr(
        cli.backend,
        "artifact_latest_json",
        lambda root: json.dumps({"ok": False, "artifact_dir": ""}),
    )

    code = cli.main(["artifacts", "latest", "--project-root", str(project_root)])

    captured = capsys.readouterr()
    assert code == 0
    assert json.loads(captured.out) == {"ok": False, "artifact_dir": ""}


def test_artifacts_list_prints_backend_json(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"

    monkeypatch.setattr(
        cli.backend,
        "artifact_list_json",
        lambda root: json.dumps({"ok": True, "items": [{"artifact_name": "20260423-010101"}]}),
    )

    code = cli.main(["artifacts", "list", "--project-root", str(project_root)])

    captured = capsys.readouterr()
    assert code == 0
    assert json.loads(captured.out)["items"][0]["artifact_name"] == "20260423-010101"


def test_run_maps_options_to_backend_run(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    event_log = tmp_path / "events.jsonl"
    human_log = tmp_path / "human.log"
    called = {}

    def fake_run(root: Path, runtime_candidate: Path, **kwargs) -> int:
        called["root"] = root
        called["runtime_candidate"] = runtime_candidate
        called["kwargs"] = kwargs
        return 7

    monkeypatch.setattr(cli.backend, "run_pipeline", fake_run)

    code = cli.main(
        [
            "run",
            "--project-root",
            str(project_root),
            "--skip-deploy",
            "--skip-verify",
            "--output",
            "human",
            "--event-log",
            str(event_log),
            "--human-log",
            str(human_log),
        ]
    )

    assert code == 7
    assert called["root"] == project_root.resolve()
    assert called["runtime_candidate"] == project_root.resolve()
    assert called["kwargs"] == {
        "skip_deploy": True,
        "skip_verify": True,
        "output_format": "human",
        "event_log_path": event_log.resolve(),
        "human_log_path": human_log.resolve(),
    }


def test_run_resume_latest_maps_to_backend_resume_latest(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    called = {"run": 0, "resume": 0}

    def fake_run(*args, **kwargs) -> int:
        called["run"] += 1
        return 1

    def fake_resume(root: Path, runtime_candidate: Path, **kwargs) -> int:
        called["resume"] += 1
        called["root"] = root
        called["runtime_candidate"] = runtime_candidate
        called["kwargs"] = kwargs
        return 0

    monkeypatch.setattr(cli.backend, "run_pipeline", fake_run)
    monkeypatch.setattr(cli.backend, "run_pipeline_resume_latest", fake_resume)

    code = cli.main(["run", "--project-root", str(project_root), "--resume-latest"])

    assert code == 0
    assert called["run"] == 0
    assert called["resume"] == 1
    assert called["root"] == project_root.resolve()
    assert called["runtime_candidate"] == project_root.resolve()


def test_retry_stage_passes_artifact_path_and_stage(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = project_root / "artifacts" / "20260423-010101"
    event_log = tmp_path / "events.jsonl"
    called = {}

    def fake_retry(root: Path, **kwargs) -> int:
        called["root"] = root
        called["kwargs"] = kwargs
        return 0

    monkeypatch.setattr(cli.backend, "retry_stage", fake_retry)

    code = cli.main(
        [
            "retry-stage",
            "--project-root",
            str(project_root),
            "--artifact-dir",
            str(artifact_dir),
            "--stage",
            "deploy",
            "--event-log",
            str(event_log),
        ]
    )

    assert code == 0
    assert called["root"] == project_root.resolve()
    assert called["kwargs"] == {
        "artifact_dir": artifact_dir.resolve(),
        "stage_name": "deploy",
        "output_format": "jsonl",
        "event_log_path": event_log.resolve(),
        "human_log_path": None,
    }


def test_resume_pipeline_maps_session_to_backend(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    session_dir = tmp_path / "session"
    called = {}

    def fake_resume(root: Path, **kwargs) -> int:
        called["root"] = root
        called["kwargs"] = kwargs
        return 0

    monkeypatch.setattr(cli.backend, "resume_pipeline", fake_resume)

    code = cli.main(["resume", "pipeline", "--project-root", str(project_root), "--session", str(session_dir)])

    assert code == 0
    assert called["root"] == project_root.resolve()
    assert called["kwargs"]["session_dir"] == session_dir.resolve()
    assert called["kwargs"]["output_format"] == "jsonl"


def test_resume_speedtest_maps_session_to_backend(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    session_dir = tmp_path / "session"
    called = {}

    def fake_resume(root: Path, **kwargs) -> int:
        called["root"] = root
        called["kwargs"] = kwargs
        return 0

    monkeypatch.setattr(cli.backend, "resume_speedtest", fake_resume)

    code = cli.main(["resume", "speedtest", "--project-root", str(project_root), "--session", str(session_dir)])

    assert code == 0
    assert called["root"] == project_root.resolve()
    assert called["kwargs"]["session_dir"] == session_dir.resolve()


def test_backend_exception_returns_exit_one_and_prints_diagnostic(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"

    def fail(root: Path) -> str:
        raise RuntimeError("profile exploded")

    monkeypatch.setattr(cli.backend, "ensure_profile_json", fail)

    code = cli.main(["profile", "show", "--project-root", str(project_root)])

    captured = capsys.readouterr()
    assert code == 1
    assert captured.out == ""
    assert "autovpn: RuntimeError: profile exploded" in captured.err
