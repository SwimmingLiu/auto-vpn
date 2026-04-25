import json
from pathlib import Path
from types import SimpleNamespace

from vpn_automation.config.models import WorkspaceConfig
from vpn_automation.backend import build_event, ensure_profile_json, resume_pipeline, run_pipeline, save_profile_json


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
    assert payload["workspace"]["project_root"] == str(project_root)


def test_save_profile_json_persists_profile_via_store(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    captured: dict[str, object] = {}

    class FakeStore:
        def __init__(self, path: Path) -> None:
            self.path = path

        def load_or_create(self, project_root: Path):
            return SimpleNamespace(
                workspace=WorkspaceConfig(
                    project_root=str(project_root),
                    workspace_root="",
                    vpn_catch_nodes_root="",
                    edgetunnel_root="",
                    artifacts_root="",
                    state_root="",
                    env_file="",
                    build_root="",
                )
            )

        def save(self, profile) -> None:
            captured["profile"] = profile

    monkeypatch.setattr("vpn_automation.backend.ProfileStore", FakeStore)

    payload = save_profile_json(
        project_root,
        json.dumps(
            {
                "sources": {"leiting": {"url": "https://a.example", "key": "k1", "enabled": True}},
                "speed_test": {
                    "min_download_mb_s": 1.0,
                    "timeout_seconds": 20,
                    "concurrency": 2,
                    "urls": ["https://example.com/file"],
                    "probe_url": "http://www.gstatic.com/generate_204",
                    "max_download_bytes": 1000,
                    "startup_wait_seconds": 1.0,
                    "max_download_candidates": 0,
                },
                "deploy": {
                    "project_name": "vmessnodes",
                    "subscription_url": "https://example.com/sub",
                },
                "filters": {"excluded_country_codes": ["CN"], "per_country_limit": {}},
            },
            ensure_ascii=False,
        ),
    )

    saved = captured["profile"]
    assert saved.workspace.project_root == str(project_root)
    assert json.loads(payload)["sources"]["leiting"]["url"] == "https://a.example"


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
    assert event_log.exists()
    payloads = [json.loads(line) for line in event_log.read_text(encoding="utf-8").splitlines()]
    assert [payload["type"] for payload in payloads] == ["log", "stage", "summary"]
    assert human_log.exists()
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
            kwargs["event_callback"]("extract_request_result", {"source_name": "leiting", "success": True, "iteration": 1})
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
