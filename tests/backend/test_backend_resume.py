import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from vpn_automation.backend_resume import _default_verify, retry_pipeline_from_stage
from vpn_automation.integrations.cloudflare import build_secret_url
from vpn_automation.pipeline.run_store import RunStore


def test_retry_pipeline_marks_stage_failed_in_report_when_retry_stage_raises(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    source_artifact_dir = project_root / "artifacts" / "20260427-081718"
    retry_artifact_dir = project_root / "artifacts" / "20260427-090000"
    template_dir = project_root / "templates"

    source_artifact_dir.mkdir(parents=True)
    retry_artifact_dir.mkdir(parents=True)
    template_dir.mkdir(parents=True)
    (project_root / "pyproject.toml").write_text("[project]\nname='test'\nversion='0.0.0'\n", encoding="utf-8")
    (template_dir / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")
    (source_artifact_dir / "vpn_node_emoji.txt").write_text("demo-link\n", encoding="utf-8")
    (source_artifact_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(source_artifact_dir),
                "run_status": "failed",
                "stage_status": {
                    "doctor": "success",
                    "extract": "success",
                    "dedupe": "success",
                    "speedtest": "success",
                    "availability": "success",
                    "postprocess": "success",
                    "render": "failed",
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    RunStore(source_artifact_dir / "run.db").initialize(artifact_dir=str(source_artifact_dir))

    monkeypatch.setattr(
        "vpn_automation.backend_resume._create_retry_artifact_dir",
        lambda project_root: retry_artifact_dir,
    )
    monkeypatch.setattr(
        "vpn_automation.pipeline.controller.replace_main_data",
        lambda template, links: (_ for _ in ()).throw(RuntimeError("render boom")),
    )

    with pytest.raises(RuntimeError, match="render boom"):
        retry_pipeline_from_stage(
            source_artifact_dir,
            stage_name="render",
            project_root=project_root,
        )

    report = json.loads((retry_artifact_dir / "pipeline_report.json").read_text(encoding="utf-8"))

    assert report["stage_status"]["render"] == "failed"
    assert report["run_status"] == "failed"
    assert report["error"] == "RuntimeError: render boom"


def test_backend_resume_default_verify_falls_back_to_subscription_url_when_verify_url_is_blank(monkeypatch) -> None:
    seen_urls: list[str] = []

    class FakeClient:
        def __init__(self, api_token: str, account_id: str) -> None:
            assert api_token == "token"
            assert account_id == "account-id"

        def verify_url(self, url: str, expected_fragment: str = "") -> bool:
            seen_urls.append(url)
            return True

    monkeypatch.setattr("vpn_automation.backend_resume.CloudflareClient", FakeClient)
    deploy = SimpleNamespace(
        account_id="account-id",
        secret_query="serect_key=swimmingliu",
        pages_project_url="https://sub-nodes.pages.dev",
        subscription_url="https://display.example/sub",
        verify_subscription_url="",
    )

    result = _default_verify(deploy, "token")

    assert result == {
        "pages_domain_ok": True,
        "secret_ok": True,
        "subscription_ok": True,
        "custom_domain_ok": False,
        "custom_domain_subscription_ok": False,
        "custom_domain_dns_ok": False,
    }
    assert seen_urls == [
        "https://sub-nodes.pages.dev",
        build_secret_url(deploy),
        "https://display.example/sub",
    ]


def test_retry_verify_stage_cleans_up_primary_and_share_blocked_projects(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    source_artifact_dir = project_root / "artifacts" / "20260507-141218"
    retry_artifact_dir = project_root / "artifacts" / "20260507-151000"
    source_artifact_dir.mkdir(parents=True)
    retry_artifact_dir.mkdir(parents=True)
    (project_root / "pyproject.toml").write_text("[project]\nname='test'\nversion='0.0.0'\n", encoding="utf-8")
    (source_artifact_dir / "_worker.js").write_text("obfuscated", encoding="utf-8")
    (source_artifact_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(source_artifact_dir),
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
                "deployment": {
                    "project_name": "sub-nodes-01",
                    "pages_project_url": "https://sub-nodes-01.pages.dev",
                    "cleanup_blocked_project": "sub-nodes",
                    "share_project_cleanup_blocked_project": "sub-links-share-03",
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    store = RunStore(source_artifact_dir / "run.db")
    store.initialize(artifact_dir=str(source_artifact_dir))
    retry_store = RunStore(retry_artifact_dir / "run.db")
    retry_store.initialize(artifact_dir=str(retry_artifact_dir))

    monkeypatch.setattr(
        "vpn_automation.backend_resume._create_retry_artifact_dir",
        lambda project_root: retry_artifact_dir,
    )
    monkeypatch.setattr(
        "vpn_automation.backend_resume.ProfileStore.load_or_create",
        lambda self, project_root: SimpleNamespace(
            deploy=SimpleNamespace(
                account_id="account-id",
                project_name="sub-nodes",
                pages_project_url="https://sub-nodes.pages.dev",
                secret_query="serect_key=swimmingliu",
                subscription_url="https://display.example/sub",
                verify_subscription_url="https://verify.example/sub",
                custom_domain="",
            ),
            workspace=SimpleNamespace(project_root=str(project_root)),
        ),
    )
    monkeypatch.setattr(
        "vpn_automation.backend_resume._build_artifact_retry_item",
        lambda artifact_dir: {
            "artifact_dir": str(artifact_dir),
            "artifact_name": artifact_dir.name,
            "retryable_stages": ["verify"],
            "stage_status": {"deploy": "success", "verify": "failed"},
        },
    )
    deleted: list[str] = []

    class FakeClient:
        def __init__(self, api_token: str = "", account_id: str = "", **kwargs) -> None:
            _ = (api_token, account_id, kwargs)

        def delete_pages_project(self, project_name: str) -> dict[str, bool]:
            deleted.append(project_name)
            return {"success": True}

    monkeypatch.setattr("vpn_automation.backend_resume.CloudflareClient", FakeClient)
    monkeypatch.setattr(
        "vpn_automation.backend_resume.resolve_cloudflare_credentials",
        lambda deploy, env, explicit_api_token="": SimpleNamespace(
            auth_mode="api_token",
            api_token="token",
            account_id="account-id",
            email="",
            global_api_key="",
        ),
    )
    monkeypatch.setattr(
        "vpn_automation.backend_resume._default_verify",
        lambda deploy, api_token: {
            "pages_domain_ok": True,
            "secret_ok": True,
            "subscription_ok": True,
            "custom_domain_ok": False,
            "custom_domain_subscription_ok": False,
            "custom_domain_dns_ok": False,
        },
    )

    summary = retry_pipeline_from_stage(
        source_artifact_dir,
        stage_name="verify",
        project_root=project_root,
    )

    assert summary.run_status == "success"
    assert deleted == ["sub-nodes", "sub-links-share-03"]


def test_retry_deploy_stage_persists_updated_deploy_names(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    source_artifact_dir = project_root / "artifacts" / "20260507-203610"
    retry_artifact_dir = project_root / "artifacts" / "20260507-211958"
    source_artifact_dir.mkdir(parents=True)
    retry_artifact_dir.mkdir(parents=True)
    (project_root / "pyproject.toml").write_text("[project]\nname='test'\nversion='0.0.0'\n", encoding="utf-8")
    (source_artifact_dir / "_worker.js").write_text("obfuscated", encoding="utf-8")
    (source_artifact_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(source_artifact_dir),
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
                    "deploy": "failed",
                },
                "deployment": {},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    RunStore(source_artifact_dir / "run.db").initialize(artifact_dir=str(source_artifact_dir))

    monkeypatch.setattr(
        "vpn_automation.backend_resume._create_retry_artifact_dir",
        lambda project_root: retry_artifact_dir,
    )
    monkeypatch.setattr(
        "vpn_automation.backend_resume._build_artifact_retry_item",
        lambda artifact_dir: {
            "artifact_dir": str(artifact_dir),
            "artifact_name": artifact_dir.name,
            "retryable_stages": ["deploy"],
            "stage_status": {"deploy": "failed"},
        },
    )

    from vpn_automation.config.models import AppProfile, DeployConfig, SourceConfig, SpeedTestConfig
    from vpn_automation.config.store import ProfileStore, resolve_profile_path

    store = ProfileStore(resolve_profile_path(project_root))
    profile = AppProfile(
        sources={"leiting": SourceConfig(url="https://example.com/api", key="demo", enabled=True)},
        speed_test=SpeedTestConfig(min_download_mb_s=1.0, timeout_seconds=20, concurrency=3, urls=[]),
        deploy=DeployConfig(project_name="sub-nodes", subscription_url="https://example.com/sub"),
    )
    store.save(profile)

    monkeypatch.setattr(
        "vpn_automation.backend_resume.resolve_cloudflare_credentials",
        lambda deploy, env, explicit_api_token="": SimpleNamespace(
            auth_mode="api_token",
            api_token="token",
            account_id="account-id",
            email="",
            global_api_key="",
        ),
    )
    monkeypatch.setattr(
        "vpn_automation.backend_resume.build_pages_bundle",
        lambda worker_source, bundle_dir: bundle_dir,
    )

    class FakeController:
        def __init__(self, **kwargs):
            self.env_loader = lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"}
            self.verifier = lambda deploy, token: {
                "pages_domain_ok": True,
                "secret_ok": True,
                "subscription_ok": True,
                "custom_domain_ok": False,
                "custom_domain_subscription_ok": False,
                "custom_domain_dns_ok": False,
            }
            self.obfuscator = lambda *_args, **_kwargs: None
            self.deployer = lambda bundle_dir, deploy, api_token: {
                "returncode": 0,
                "attempts": [{"mode": "direct", "returncode": 0}],
                "project_name": "sub-nodes-04",
                "pages_project_url": "https://sub-nodes-04.pages.dev",
                "share_project_name": "sub-links-share-05",
                "bundle_dir": str(bundle_dir),
                "worker_entry": str(bundle_dir / "_worker.js"),
                "module_manifest_path": str(bundle_dir / "manifest.json"),
            }

        def stage_names(self):
            return ["doctor", "extract", "dedupe", "speedtest", "availability", "postprocess", "render", "obfuscate", "deploy", "verify"]

        def _write_pipeline_report(self, artifact_dir, summary):
            return None

    monkeypatch.setattr("vpn_automation.backend_resume.PipelineController", FakeController)

    summary = retry_pipeline_from_stage(
        source_artifact_dir,
        stage_name="deploy",
        project_root=project_root,
    )

    saved = store.load()
    assert summary.run_status == "success"
    assert saved.deploy.project_name == "sub-nodes-04"
    assert saved.deploy.pages_project_url == "https://sub-nodes-04.pages.dev"
    assert saved.deploy.share_project_name == "sub-links-share-05"
