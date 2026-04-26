import json
from pathlib import Path
from types import SimpleNamespace

from vpn_automation.backend import (
    artifact_latest_json,
    build_event,
    ensure_profile_json,
    resume_pipeline,
    run_pipeline,
    run_pipeline_resume_latest,
    save_profile_json,
)
from vpn_automation.config.models import AppProfile, DeployConfig, SourceConfig, SpeedTestConfig
from vpn_automation.config.store import ProfileStore
from vpn_automation.pipeline.run_store import RunStore


def test_build_event_emits_json_line() -> None:
    line = build_event("log", {"message": "hello"})
    payload = json.loads(line)
    assert payload["type"] == "log"
    assert payload["message"] == "hello"


def test_ensure_profile_json_bootstraps_missing_profile(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    profile_json = ensure_profile_json(project_root)
    payload = json.loads(profile_json)
    assert payload["deploy"]["project_name"] == "vmessnodes"
    assert "workspace" not in payload


def test_save_profile_json_persists_toml_backed_changes(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    payload = json.loads(ensure_profile_json(project_root))
    payload["sources"]["leiting"]["url"] = "https://example.com/api"
    payload["sources"]["leiting"]["key"] = "abcdabcdabcdabcd"

    saved_json = save_profile_json(project_root, json.dumps(payload, ensure_ascii=False))

    stored = (project_root / "state" / "profile.toml").read_text(encoding="utf-8")
    assert 'url = "https://example.com/api"' in stored
    assert 'key = "abcdabcdabcdabcd"' in stored
    assert json.loads(saved_json)["sources"]["leiting"]["url"] == "https://example.com/api"


def test_ensure_profile_json_prefers_env_profile_path(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    profile_path = tmp_path / "runtime" / "profile.toml"
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile = AppProfile(
        sources={"leiting": SourceConfig(url="https://env.example", key="env-key", enabled=True)},
        speed_test=SpeedTestConfig(
            min_download_mb_s=1.0,
            timeout_seconds=20,
            concurrency=3,
            urls=[],
        ),
        deploy=DeployConfig(
            project_name="env-profile",
            subscription_url="https://env.example/sub",
        ),
    )
    ProfileStore(profile_path).save(profile)
    monkeypatch.setenv("VPN_AUTOMATION_PROFILE_PATH", str(profile_path))

    profile_json = ensure_profile_json(project_root)
    payload = json.loads(profile_json)

    assert payload["deploy"]["project_name"] == "env-profile"
    assert payload["sources"]["leiting"]["url"] == "https://env.example"


def test_find_resume_run_db_prefers_latest_incomplete_artifact(tmp_path: Path) -> None:
    from vpn_automation.backend import find_resume_run_db

    project_root = tmp_path / "vpn-subscription-automation"
    artifacts_root = project_root / "artifacts"
    first_dir = artifacts_root / "20260423-010101"
    second_dir = artifacts_root / "20260423-020202"
    first_dir.mkdir(parents=True)
    second_dir.mkdir(parents=True)

    first = RunStore(first_dir / "run.db")
    first.initialize(artifact_dir=str(first_dir))
    first.record_stage_event("verify", "success")

    second = RunStore(second_dir / "run.db")
    second.initialize(artifact_dir=str(second_dir))
    second.record_stage_event("extract", "running")

    resolved = find_resume_run_db(project_root)

    assert resolved == second_dir / "run.db"


def test_artifact_latest_json_returns_latest_reported_artifact(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifacts_root = project_root / "artifacts"
    first_dir = artifacts_root / "20260423-010101"
    latest_dir = artifacts_root / "20260423-020202"
    first_dir.mkdir(parents=True)
    latest_dir.mkdir(parents=True)
    (latest_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(latest_dir),
                "run_status": "success",
                "stage_status": {"availability": "success"},
                "counts": {"availability_links": 2},
                "source_counts": {"leiting": {"raw_links": 3}},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    payload = json.loads(artifact_latest_json(project_root))

    assert payload["ok"] is True
    assert payload["artifact_dir"] == str(latest_dir)
    assert payload["counts"]["availability_links"] == 2
    assert payload["source_counts"]["leiting"]["raw_links"] == 3


def test_artifact_latest_json_returns_empty_when_no_artifact_exists(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"

    payload = json.loads(artifact_latest_json(project_root))

    assert payload == {"ok": False, "artifact_dir": ""}


def test_run_pipeline_can_write_event_log_and_human_output(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    event_log = tmp_path / "events.jsonl"
    human_log = tmp_path / "human.log"

    class FakeStore:
        def __init__(self, path: Path) -> None:
            self.path = path

        def load_or_create(self, project_root: Path):
            return SimpleNamespace()

    class FakeController:
        def run(self, profile, **kwargs):
            kwargs["log_callback"]("[extract] request ok")
            kwargs["stage_callback"]("extract", "success")
            return SimpleNamespace(
                artifact_dir=str(project_root / "artifacts" / "20260423-010101"),
                stage_status={"extract": "success"},
                counts={"raw_links": 1},
                source_counts={"leiting": {"raw_links": 1}},
                deployment={},
                run_status="success",
                error="",
            )

    monkeypatch.setattr("vpn_automation.backend.ProfileStore", FakeStore)
    monkeypatch.setattr("vpn_automation.backend.PipelineController", FakeController)

    code = run_pipeline(
        project_root,
        skip_deploy=True,
        skip_verify=True,
        output_format="human",
        event_log_path=event_log,
        human_log_path=human_log,
    )

    captured = capsys.readouterr()
    assert code == 0
    assert "[extract] request ok" in captured.out
    assert "extract=success" in captured.out
    payloads = [json.loads(line) for line in event_log.read_text(encoding="utf-8").splitlines()]
    assert [payload["type"] for payload in payloads] == ["log", "stage", "summary"]
    assert "raw_links=1" in human_log.read_text(encoding="utf-8")


def test_run_pipeline_persists_structured_stage_events(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    event_log = tmp_path / "events.jsonl"

    class FakeStore:
        def __init__(self, path: Path) -> None:
            self.path = path

        def load_or_create(self, project_root: Path):
            return SimpleNamespace()

    class FakeController:
        def run(self, profile, **kwargs):
            kwargs["event_callback"](
                "extract_request_result",
                {"source_name": "leiting", "success": True, "iteration": 1},
            )
            return SimpleNamespace(
                artifact_dir=str(project_root / "artifacts" / "20260423-010101"),
                stage_status={"extract": "success"},
                counts={"raw_links": 1},
                source_counts={"leiting": {"raw_links": 1}},
                deployment={},
                run_status="success",
                error="",
            )

    monkeypatch.setattr("vpn_automation.backend.ProfileStore", FakeStore)
    monkeypatch.setattr("vpn_automation.backend.PipelineController", FakeController)

    code = run_pipeline(
        project_root,
        skip_deploy=True,
        skip_verify=True,
        output_format="human",
        event_log_path=event_log,
    )

    payloads = [json.loads(line) for line in event_log.read_text(encoding="utf-8").splitlines()]
    assert code == 0
    assert "extract_request_result" in [payload["type"] for payload in payloads]


def test_resume_pipeline_appends_summary_for_continued_stages(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    session_dir = tmp_path / "manual-runs" / "20260424-120000"
    session_dir.mkdir(parents=True)
    event_log = session_dir / "events.jsonl"
    human_log = session_dir / "human.log"
    artifact_dir = project_root / "artifacts" / "20260424-120000"
    artifact_dir.mkdir(parents=True)
    (session_dir / "session.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(artifact_dir),
                "event_log": str(event_log),
                "human_log": str(human_log),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    def fake_continue(session_dir_arg, *, project_root, log_callback=None, stage_callback=None, event_callback=None):
        assert session_dir_arg == session_dir
        log_callback("[availability] kept 2 links")
        stage_callback("availability", "success")
        return SimpleNamespace(
            artifact_dir=str(artifact_dir),
            stage_status={"availability": "success", "deploy": "success", "verify": "success"},
            counts={"availability_links": 2, "final_links": 2},
            source_counts={},
            deployment={"secret_ok": True, "subscription_ok": True},
            run_status="success",
            error="",
        )

    monkeypatch.setattr("vpn_automation.backend.continue_pipeline_session", fake_continue)

    code = resume_pipeline(
        project_root,
        session_dir=session_dir,
        output_format="human",
    )

    captured = capsys.readouterr()
    assert code == 0
    assert "[availability] kept 2 links" in captured.out
    payloads = [json.loads(line) for line in event_log.read_text(encoding="utf-8").splitlines()]
    assert [payload["type"] for payload in payloads] == ["log", "stage", "summary"]


def test_run_pipeline_resume_latest_uses_latest_run_db(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifacts_root = project_root / "artifacts"
    artifact_dir = artifacts_root / "20260423-020202"
    artifact_dir.mkdir(parents=True)
    store = RunStore(artifact_dir / "run.db")
    store.initialize(artifact_dir=str(artifact_dir))
    store.record_stage_event("extract", "running")

    class FakeStore:
        def __init__(self, path: Path) -> None:
            self.path = path

        def load_or_create(self, project_root: Path):
            return SimpleNamespace()

    class FakeController:
        def run(self, profile, **kwargs):
            assert kwargs["resume_from"] == artifact_dir
            return SimpleNamespace(
                artifact_dir=str(artifact_dir),
                stage_status={"extract": "success"},
                counts={"raw_links": 1},
                source_counts={},
                deployment={},
                run_status="success",
                error="",
            )

    monkeypatch.setattr("vpn_automation.backend.ProfileStore", FakeStore)
    monkeypatch.setattr("vpn_automation.backend.PipelineController", FakeController)

    code = run_pipeline_resume_latest(
        project_root,
        project_root,
        skip_deploy=True,
        skip_verify=True,
    )

    assert code == 0
