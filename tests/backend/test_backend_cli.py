import json
from pathlib import Path
from types import SimpleNamespace

from vpn_automation.backend import (
    artifact_list_json,
    artifact_latest_json,
    build_event,
    ensure_profile_json,
    resume_pipeline,
    retry_stage,
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
    assert payload["deploy"]["project_name"] == "sub-nodes"
    assert payload["paths"]["project_root"] == str(project_root)
    assert payload["paths"]["artifacts_root"] == str(project_root / "artifacts")
    assert payload["workspace"] == payload["paths"]


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


def test_save_profile_payload_persists_updated_deploy_project_names(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    payload = json.loads(ensure_profile_json(project_root))
    payload["deploy"]["project_name"] = "sub-nodes-04"
    payload["deploy"]["pages_project_url"] = "https://sub-nodes-04.pages.dev"
    payload["deploy"]["share_project_name"] = "sub-links-share-05"

    saved_json = save_profile_json(project_root, json.dumps(payload, ensure_ascii=False))

    stored = (project_root / "state" / "profile.toml").read_text(encoding="utf-8")
    assert 'project_name = "sub-nodes-04"' in stored
    assert 'pages_project_url = "https://sub-nodes-04.pages.dev"' in stored
    assert 'share_project_name = "sub-links-share-05"' in stored
    assert json.loads(saved_json)["deploy"]["share_project_name"] == "sub-links-share-05"


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


def test_artifact_latest_json_uses_runtime_artifacts_override(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    runtime_artifacts_root = tmp_path / "Application Support" / "vpn-subscription-automation" / "artifacts"
    latest_dir = runtime_artifacts_root / "20260528-150000"
    latest_dir.mkdir(parents=True)
    (latest_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(latest_dir),
                "run_status": "failed",
                "stage_status": {"doctor": "failed"},
                "error": "RuntimeError: Cloudflare API token is missing",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("VPN_AUTOMATION_ARTIFACTS_ROOT", str(runtime_artifacts_root))

    payload = json.loads(artifact_latest_json(project_root))

    assert payload["ok"] is True
    assert payload["artifact_dir"] == str(latest_dir)
    assert payload["error"] == "RuntimeError: Cloudflare API token is missing"


def test_artifact_latest_json_returns_empty_when_no_artifact_exists(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"

    payload = json.loads(artifact_latest_json(project_root))

    assert payload == {"ok": False, "artifact_dir": ""}


def test_artifact_list_json_reports_retryable_stages_and_retry_context(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = project_root / "artifacts" / "20260427-081718"
    artifact_dir.mkdir(parents=True)
    vmess_link = "vmess://demo"
    (artifact_dir / "vpn_node_deduped.txt").write_text(f"{vmess_link}\n", encoding="utf-8")
    (artifact_dir / "vpn_node_speedtest.txt").write_text(f"{vmess_link}\n", encoding="utf-8")
    (artifact_dir / "vpn_node_availability.txt").write_text(f"{vmess_link}\n", encoding="utf-8")
    (artifact_dir / "vpn_node_emoji.txt").write_text("US demo\n", encoding="utf-8")
    (artifact_dir / "vmess_node.js").write_text("rendered", encoding="utf-8")
    (artifact_dir / "_worker.js").write_text("obfuscated", encoding="utf-8")
    (artifact_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(artifact_dir),
                "run_status": "failed",
                "stage_status": {
                    "doctor": "success",
                    "extract": "success",
                    "dedupe": "success",
                    "speedtest": "success",
                    "availability": "success",
                    "postprocess": "success",
                    "render": "success",
                    "obfuscate": "success",
                    "deploy": "success",
                    "verify": "failed",
                },
                "counts": {"final_links": 1},
                "retry_context": {
                    "source_artifact_dir": "/tmp/source-run",
                    "source_artifact_name": "20260426-000000",
                    "start_stage": "deploy",
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    store = RunStore(artifact_dir / "run.db")
    store.initialize(artifact_dir=str(artifact_dir))
    store.record_speedtest_result(
        link=vmess_link,
        reachable=True,
        latency_ms=20,
        average_download_mb_s=5.0,
    )

    payload = json.loads(artifact_list_json(project_root))

    assert payload["ok"] is True
    assert payload["items"][0]["artifact_dir"] == str(artifact_dir)
    assert payload["items"][0]["retryable_stages"] == [
        "speedtest",
        "availability",
        "postprocess",
        "render",
        "obfuscate",
        "deploy",
        "verify",
    ]
    assert payload["items"][0]["retry_context"]["start_stage"] == "deploy"


def test_artifact_list_json_filters_non_run_directories(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifacts_root = project_root / "artifacts"
    artifact_dir = artifacts_root / "20260427-081718"
    screenshots_dir = artifacts_root / "screenshots"
    artifact_dir.mkdir(parents=True)
    screenshots_dir.mkdir(parents=True)
    (artifact_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(artifact_dir),
                "run_status": "success",
                "stage_status": {"deploy": "success"},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (screenshots_dir / "runs-current.png").write_text("mock png", encoding="utf-8")

    payload = json.loads(artifact_list_json(project_root))

    assert payload["ok"] is True
    assert [item["artifact_name"] for item in payload["items"]] == ["20260427-081718"]


def test_retry_stage_emits_summary_for_retry_run(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = project_root / "artifacts" / "20260427-081718"
    artifact_dir.mkdir(parents=True)

    def fake_retry(artifact_dir_arg, *, stage_name, project_root, log_callback=None, stage_callback=None, event_callback=None):
        assert artifact_dir_arg == artifact_dir
        assert stage_name == "deploy"
        log_callback("[deploy] retry started")
        stage_callback("deploy", "success")
        return SimpleNamespace(
            artifact_dir=str(project_root / "artifacts" / "20260427-090000"),
            stage_status={"deploy": "success", "verify": "success"},
            counts={"final_links": 2},
            source_counts={},
            deployment={"secret_ok": True, "subscription_ok": True},
            retry_context={"source_artifact_dir": str(artifact_dir), "start_stage": "deploy"},
            run_status="success",
            error="",
        )

    monkeypatch.setattr("vpn_automation.backend.retry_pipeline_from_stage", fake_retry)

    code = retry_stage(
        project_root,
        artifact_dir=artifact_dir,
        stage_name="deploy",
        output_format="human",
    )

    captured = capsys.readouterr()
    assert code == 0
    assert "[deploy] retry started" in captured.out
    assert "final_links=2" in captured.out


def test_retry_stage_does_not_overwrite_profile_saved_by_retry_runner(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = project_root / "artifacts" / "20260507-141218"
    artifact_dir.mkdir(parents=True)
    store = ProfileStore(project_root / "state" / "profile.toml")
    store.save(
        AppProfile(
            sources={"leiting": SourceConfig(url="https://example.com/api", key="demo", enabled=True)},
            speed_test=SpeedTestConfig(min_download_mb_s=1.0, timeout_seconds=20, concurrency=3, urls=[]),
            deploy=DeployConfig(project_name="sub-nodes-04", subscription_url="https://example.com/sub"),
        )
    )

    def fake_retry(artifact_dir_arg, *, stage_name, project_root, log_callback=None, stage_callback=None, event_callback=None):
        assert artifact_dir_arg == artifact_dir
        assert stage_name == "deploy"
        updated = store.load()
        updated.deploy.project_name = "sub-nodes-04"
        updated.deploy.pages_project_url = "https://sub-nodes-04.pages.dev"
        updated.deploy.share_project_name = "sub-links-share-05"
        store.save(updated)
        return SimpleNamespace(
            artifact_dir=str(project_root / "artifacts" / "20260507-215128"),
            stage_status={"deploy": "success", "verify": "success"},
            counts={"final_links": 2},
            source_counts={},
            deployment={
                "project_name": "sub-nodes-04",
                "pages_project_url": "https://sub-nodes-04.pages.dev",
                "share_project_name": "sub-links-share-05",
            },
            retry_context={"source_artifact_dir": str(artifact_dir), "start_stage": "deploy"},
            run_status="success",
            error="",
        )

    monkeypatch.setattr("vpn_automation.backend.retry_pipeline_from_stage", fake_retry)

    code = retry_stage(
        project_root,
        artifact_dir=artifact_dir,
        stage_name="deploy",
        output_format="human",
    )

    saved = store.load()
    assert code == 0
    assert saved.deploy.project_name == "sub-nodes-04"
    assert saved.deploy.pages_project_url == "https://sub-nodes-04.pages.dev"
    assert saved.deploy.share_project_name == "sub-links-share-05"


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


def test_run_pipeline_emits_log_and_summary_when_configuration_fails(
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
            raise RuntimeError("Cloudflare API token is missing")

    monkeypatch.setattr("vpn_automation.backend.ProfileStore", FakeStore)
    monkeypatch.setattr("vpn_automation.backend.PipelineController", FakeController)

    code = run_pipeline(
        project_root,
        skip_deploy=False,
        skip_verify=False,
        output_format="jsonl",
        event_log_path=event_log,
    )

    payloads = [json.loads(line) for line in event_log.read_text(encoding="utf-8").splitlines()]
    assert code == 1
    assert payloads[0] == {
        "type": "log",
        "message": "[doctor] configuration failed: RuntimeError: Cloudflare API token is missing",
    }
    assert payloads[1]["type"] == "summary"
    assert payloads[1]["run_status"] == "failed"
    assert payloads[1]["stage_status"]["doctor"] == "failed"
    assert payloads[1]["error"] == "RuntimeError: Cloudflare API token is missing"
    assert payloads[2] == {
        "type": "run_failed",
        "error": "RuntimeError: Cloudflare API token is missing",
    }


def test_run_pipeline_persists_updated_deploy_names_after_success(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    store = ProfileStore(project_root / "state" / "profile.toml")
    profile = AppProfile(
        sources={"leiting": SourceConfig(url="https://example.com/api", key="demo", enabled=True)},
        speed_test=SpeedTestConfig(min_download_mb_s=1.0, timeout_seconds=20, concurrency=3, urls=[]),
        deploy=DeployConfig(project_name="sub-nodes", subscription_url="https://example.com/sub"),
    )
    store.save(profile)

    class FakeController:
        def run(self, profile, **kwargs):
            profile.deploy.project_name = "sub-nodes-04"
            profile.deploy.pages_project_url = "https://sub-nodes-04.pages.dev"
            profile.deploy.share_project_name = "sub-links-share-05"
            return SimpleNamespace(
                artifact_dir=str(project_root / "artifacts" / "20260507-203610"),
                stage_status={"deploy": "success", "verify": "success"},
                counts={"final_links": 2},
                source_counts={},
                deployment={
                    "project_name": "sub-nodes-04",
                    "pages_project_url": "https://sub-nodes-04.pages.dev",
                    "share_project_name": "sub-links-share-05",
                },
                run_status="success",
                error="",
            )

    monkeypatch.setattr("vpn_automation.backend.PipelineController", FakeController)

    code = run_pipeline(
        project_root,
        skip_deploy=False,
        skip_verify=False,
        output_format="human",
    )

    saved = store.load()
    assert code == 0
    assert saved.deploy.project_name == "sub-nodes-04"
    assert saved.deploy.pages_project_url == "https://sub-nodes-04.pages.dev"
    assert saved.deploy.share_project_name == "sub-links-share-05"


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


def test_resume_pipeline_does_not_overwrite_profile_saved_by_resume_runner(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    session_dir = tmp_path / "manual-runs" / "20260424-120000"
    artifact_dir = project_root / "artifacts" / "20260424-120000"
    session_dir.mkdir(parents=True)
    artifact_dir.mkdir(parents=True)
    (session_dir / "session.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(artifact_dir),
                "event_log": str(session_dir / "events.jsonl"),
                "human_log": str(session_dir / "human.log"),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    store = ProfileStore(project_root / "state" / "profile.toml")
    store.save(
        AppProfile(
            sources={"leiting": SourceConfig(url="https://example.com/api", key="demo", enabled=True)},
            speed_test=SpeedTestConfig(min_download_mb_s=1.0, timeout_seconds=20, concurrency=3, urls=[]),
            deploy=DeployConfig(project_name="sub-nodes-04", subscription_url="https://example.com/sub"),
        )
    )

    def fake_continue(session_dir_arg, *, project_root, log_callback=None, stage_callback=None, event_callback=None):
        assert session_dir_arg == session_dir
        updated = store.load()
        updated.deploy.project_name = "sub-nodes-04"
        updated.deploy.pages_project_url = "https://sub-nodes-04.pages.dev"
        updated.deploy.share_project_name = "sub-links-share-05"
        store.save(updated)
        return SimpleNamespace(
            artifact_dir=str(artifact_dir),
            stage_status={"deploy": "success", "verify": "success"},
            counts={"final_links": 2},
            source_counts={},
            deployment={
                "project_name": "sub-nodes-04",
                "pages_project_url": "https://sub-nodes-04.pages.dev",
                "share_project_name": "sub-links-share-05",
            },
            run_status="success",
            error="",
        )

    monkeypatch.setattr("vpn_automation.backend.continue_pipeline_session", fake_continue)

    code = resume_pipeline(
        project_root,
        session_dir=session_dir,
        output_format="human",
    )

    saved = store.load()
    assert code == 0
    assert saved.deploy.project_name == "sub-nodes-04"
    assert saved.deploy.pages_project_url == "https://sub-nodes-04.pages.dev"
    assert saved.deploy.share_project_name == "sub-links-share-05"


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
