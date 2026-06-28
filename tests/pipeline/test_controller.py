import json
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from vpn_automation.config.models import create_default_profile
from vpn_automation.config.models import AvailabilityTargetConfig
from vpn_automation.integrations.cloudflare import build_secret_url
from vpn_automation.pipeline.availability import AvailabilityResult, ProviderCheckResult
from vpn_automation.pipeline.controller import PipelineController
from vpn_automation.pipeline.speedtest import SpeedTestResult
from vpn_automation.pipeline.vmess import generate_vmess_link, parse_vmess_link


VMESS_LINK = "vmess://eyJhZGQiOiIxLjEuMS4xIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNCIsIm5ldCI6IndzIiwicGF0aCI6IlwvZm9vdGVycyIsInBvcnQiOjQ0MywicHMiOiJVUyBub2RlIiwidGxzIjoidGxzIiwidHlwZSI6ImR0bHMiLCJ2IjoiMiJ9"


def _template_path() -> Path:
    return Path(__file__).resolve().parents[2] / "templates" / "vmess_node.js"


def test_pipeline_controller_exposes_named_stages() -> None:
    controller = PipelineController()
    assert controller.stage_names()[0] == "doctor"
    assert "deploy" in controller.stage_names()


def test_pipeline_controller_writes_transformed_worker_source(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text(_template_path().read_text(encoding="utf-8"), encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.sources = {"leiting": profile.sources["leiting"]}
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"
    profile.worker_build.variable_prefix = "edge"

    controller = PipelineController(
        runtime_root_resolver=lambda _candidate: project_root,
        artifacts_root_resolver=lambda root: root / "artifacts",
        template_path_resolver=lambda root: root / "templates" / "vmess_node.js",
        extractor=lambda source_name, source, progress_callback=None: [VMESS_LINK],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.5, latency_ms=50)
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None, targets=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={"gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok")},
            )
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text(
            input_path.read_text(encoding="utf-8"),
            encoding="utf-8",
        ),
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    summary = controller.run(profile, skip_deploy=True, skip_verify=True)
    artifact_dir = Path(summary.artifact_dir)

    assert (artifact_dir / "worker_transformed.js").exists()
    assert summary.counts["worker_modules"] == 4
    transformed_source = (artifact_dir / "worker_transformed.js").read_text(encoding="utf-8")
    assert "SUBSCRIPTION_PAYLOAD" in transformed_source
    assert "handleSubscriptionRequest" in transformed_source
    assert "// subscription worker: returns encoded payload on secret match, random bytes otherwise" in transformed_source
    assert "const edge_" in transformed_source


def test_pipeline_controller_logs_deploy_target_details(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text(_template_path().read_text(encoding="utf-8"), encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.sources = {"leiting": profile.sources["leiting"]}
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"

    logs: list[str] = []
    controller = PipelineController(
        runtime_root_resolver=lambda _candidate: project_root,
        artifacts_root_resolver=lambda root: root / "artifacts",
        template_path_resolver=lambda root: root / "templates" / "vmess_node.js",
        extractor=lambda source_name, source, progress_callback=None: [VMESS_LINK],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.5, latency_ms=50)
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None, targets=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={"gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok")},
            )
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text(
            input_path.read_text(encoding="utf-8"),
            encoding="utf-8",
        ),
        deployer=lambda bundle_dir, deploy_config, api_token: {
            "returncode": 0,
            "stdout": "ok",
            "stderr": "",
            "attempts": [{"mode": "direct", "returncode": 0}],
            "project_name": deploy_config.project_name,
            "pages_project_url": deploy_config.pages_project_url,
            "bundle_dir": str(bundle_dir),
            "worker_entry": str(bundle_dir / "_worker.js"),
            "module_manifest_path": str(bundle_dir / "manifest.json"),
        },
        verifier=lambda deploy_config, api_token: {"secret_ok": True, "subscription_ok": True},
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    controller.run(profile, log_callback=logs.append)

    assert any("[deploy] project=sub-nodes" in line for line in logs)
    assert any("url=https://sub-nodes.pages.dev" in line for line in logs)


def test_pipeline_controller_default_verify_prefers_verify_subscription_url(monkeypatch) -> None:
    seen_urls: list[str] = []

    class FakeClient:
        def __init__(self, api_token: str, account_id: str) -> None:
            assert api_token == "token"
            assert account_id == "account-id"

        def verify_url(self, url: str, expected_fragment: str = "") -> bool:
            seen_urls.append(url)
            return True

    monkeypatch.setattr("vpn_automation.pipeline.controller.CloudflareClient", FakeClient)
    deploy = SimpleNamespace(
        account_id="account-id",
        secret_query="serect_key=swimmingliu",
        pages_project_url="https://sub-nodes.pages.dev",
        subscription_url="https://display.example/sub",
        verify_subscription_url="https://verify.example/sub",
    )

    result = PipelineController()._default_verify(deploy, "token")

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
        "https://verify.example/sub",
    ]


def test_pipeline_controller_cleanup_deletes_primary_and_share_blocked_projects(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text(_template_path().read_text(encoding="utf-8"), encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.sources = {"leiting": profile.sources["leiting"]}
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"
    deleted: list[str] = []

    controller = PipelineController(
        runtime_root_resolver=lambda _candidate: project_root,
        artifacts_root_resolver=lambda root: root / "artifacts",
        template_path_resolver=lambda root: root / "templates" / "vmess_node.js",
        extractor=lambda source_name, source, progress_callback=None: [VMESS_LINK],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.5, latency_ms=50)
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None, targets=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={"gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok")},
            )
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text(
            input_path.read_text(encoding="utf-8"),
            encoding="utf-8",
        ),
        deployer=lambda bundle_dir, deploy_config, api_token: {
            "returncode": 0,
            "stdout": "ok",
            "stderr": "",
            "attempts": [{"mode": "fallback-direct", "returncode": 0}],
            "cleanup_blocked_project": "sub-nodes",
            "share_project_cleanup_blocked_project": "sub-links-share-03",
            "project_name": "sub-nodes-01",
            "pages_project_url": "https://sub-nodes-01.pages.dev",
            "share_project_name": "sub-links-share-04",
            "share_project_sync_ok": True,
            "bundle_dir": str(bundle_dir),
            "worker_entry": str(bundle_dir / "_worker.js"),
            "module_manifest_path": str(bundle_dir / "manifest.json"),
        },
        verifier=lambda deploy_config, api_token: {
            "pages_domain_ok": True,
            "secret_ok": True,
            "subscription_ok": True,
            "custom_domain_ok": False,
            "custom_domain_subscription_ok": False,
            "custom_domain_dns_ok": False,
        },
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    class FakeClient:
        def __init__(self, api_token: str, account_id: str = "") -> None:
            _ = (api_token, account_id)

        def delete_pages_project(self, project_name: str) -> dict[str, bool]:
            deleted.append(project_name)
            return {"success": True}

    import vpn_automation.pipeline.controller as controller_module
    controller_module.CloudflareClient = FakeClient

    summary = controller.run(profile)

    assert summary.stage_status["verify"] == "success"
    assert deleted == ["sub-nodes", "sub-links-share-03"]


def test_pipeline_controller_records_cleanup_response_details(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text(_template_path().read_text(encoding="utf-8"), encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.sources = {"leiting": profile.sources["leiting"]}
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"

    controller = PipelineController(
        runtime_root_resolver=lambda _candidate: project_root,
        artifacts_root_resolver=lambda root: root / "artifacts",
        template_path_resolver=lambda root: root / "templates" / "vmess_node.js",
        extractor=lambda source_name, source, progress_callback=None: [VMESS_LINK],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.5, latency_ms=50)
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None, targets=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={"gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok")},
            )
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text(
            input_path.read_text(encoding="utf-8"),
            encoding="utf-8",
        ),
        deployer=lambda bundle_dir, deploy_config, api_token: {
            "returncode": 0,
            "stdout": "ok",
            "stderr": "",
            "attempts": [{"mode": "fallback-direct", "returncode": 0}],
            "cleanup_blocked_project": "sub-nodes",
            "share_project_cleanup_blocked_project": "sub-links-share-03",
            "project_name": "sub-nodes-01",
            "pages_project_url": "https://sub-nodes-01.pages.dev",
            "share_project_name": "sub-links-share-04",
            "share_project_sync_ok": True,
            "bundle_dir": str(bundle_dir),
            "worker_entry": str(bundle_dir / "_worker.js"),
            "module_manifest_path": str(bundle_dir / "manifest.json"),
        },
        verifier=lambda deploy_config, api_token: {
            "pages_domain_ok": True,
            "secret_ok": True,
            "subscription_ok": True,
            "custom_domain_ok": False,
            "custom_domain_subscription_ok": False,
            "custom_domain_dns_ok": False,
        },
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    class FakeClient:
        def __init__(self, api_token: str, account_id: str = "") -> None:
            _ = (api_token, account_id)

        def delete_pages_project(self, project_name: str) -> dict[str, bool]:
            if project_name == "sub-links-share-03":
                import requests

                response = requests.Response()
                response.status_code = 400
                response._content = b'{"errors":[{"message":"custom domain still attached"}]}'
                raise requests.HTTPError("400 Client Error", response=response)
            return {"success": True}

    import vpn_automation.pipeline.controller as controller_module
    controller_module.CloudflareClient = FakeClient

    summary = controller.run(profile)

    assert summary.stage_status["verify"] == "success"
    assert summary.deployment["cleanup_deleted"] is True
    assert any("custom domain still attached" in item for item in summary.deployment["cleanup_errors"])


def test_run_extract_executes_enabled_sources_in_parallel(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = project_root / "artifacts" / "run"
    artifact_dir.mkdir(parents=True)

    profile = create_default_profile(project_root)
    profile.sources = {
        "leiting": profile.sources["leiting"],
        "heidong": profile.sources["heidong"],
    }
    for source in profile.sources.values():
        source.url = "https://example.com/api"
        source.key = "abcdabcdabcdabcd"

    lock = threading.Lock()
    first_started = threading.Event()
    overlap_seen = threading.Event()
    active = {"count": 0}

    def extractor(source_name: str, source, progress_callback=None):
        with lock:
            active["count"] += 1
            if active["count"] >= 2:
                overlap_seen.set()

        if source_name == "leiting":
            first_started.set()
            overlap_seen.wait(timeout=0.3)
        else:
            first_started.wait(timeout=0.3)
            if active["count"] >= 2:
                overlap_seen.set()

        time.sleep(0.05)

        with lock:
            active["count"] -= 1

        return [f"vmess://{source_name}"]

    controller = PipelineController(extractor=extractor)

    raw_links = controller._run_extract(profile, artifact_dir, lambda _message: None)

    assert overlap_seen.is_set()
    assert set(raw_links) == {"vmess://leiting", "vmess://heidong"}


def test_pipeline_controller_persists_failed_stage_status_to_report(tmp_path: Path, isolated_runtime_root: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    catch_root = tmp_path / "vpn-catch-nodes" / "config"
    edge_root = tmp_path / "cloudflarevpn" / "edgetunnel"

    catch_root.mkdir(parents=True)
    edge_root.mkdir(parents=True)
    (catch_root / "vpn_api.json").write_text("{}", encoding="utf-8")
    (edge_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.workspace.vpn_catch_nodes_root = str(tmp_path / "vpn-catch-nodes")
    profile.workspace.edgetunnel_root = str(edge_root)
    profile.workspace.artifacts_root = str(project_root / "artifacts")
    profile.workspace.state_root = str(project_root / "state")
    profile.workspace.env_file = str(project_root / ".env")
    profile.sources = {
        "leiting": profile.sources["leiting"],
    }
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"

    vmess = "vmess://eyJhZGQiOiIxLjEuMS4xIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNCIsIm5ldCI6IndzIiwicGF0aCI6IlwvZm9vdGVycyIsInBvcnQiOjQ0MywicHMiOjQzMSwidGxzIjoidGxzIiwidHlwZSI6ImR0bHMiLCJ2IjoiMiJ9"

    def explode(_input_path: Path, _output_path: Path) -> None:
        raise RuntimeError("obfuscate boom")

    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None: [vmess],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.5, latency_ms=50)
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={
                    "gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok"),
                    "chatgpt": ProviderCheckResult(provider="chatgpt", passed=True, reason="ok"),
                    "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
                },
            )
        ],
        country_lookup=lambda host: "US",
        obfuscator=explode,
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    with pytest.raises(RuntimeError, match="obfuscate boom"):
        controller.run(profile, skip_deploy=True, skip_verify=True)

    artifact_dir = next((isolated_runtime_root / "artifacts").iterdir())
    report = json.loads((artifact_dir / "pipeline_report.json").read_text(encoding="utf-8"))

    assert report["stage_status"]["render"] == "success"
    assert report["stage_status"]["obfuscate"] == "failed"


def test_pipeline_controller_forwards_structured_stage_events(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    catch_root = tmp_path / "vpn-catch-nodes" / "config"
    edge_root = tmp_path / "cloudflarevpn" / "edgetunnel"
    events: list[dict] = []

    catch_root.mkdir(parents=True)
    edge_root.mkdir(parents=True)
    (catch_root / "vpn_api.json").write_text("{}", encoding="utf-8")
    (edge_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.workspace.vpn_catch_nodes_root = str(tmp_path / "vpn-catch-nodes")
    profile.workspace.edgetunnel_root = str(edge_root)
    profile.workspace.artifacts_root = str(project_root / "artifacts")
    profile.workspace.state_root = str(project_root / "state")
    profile.workspace.env_file = str(project_root / ".env")
    profile.sources = {
        "leiting": profile.sources["leiting"],
    }
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"

    vmess = "vmess://eyJhZGQiOiIxLjEuMS4xIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNCIsIm5ldCI6IndzIiwicGF0aCI6IlwvZm9vdGVycyIsInBvcnQiOjQ0MywicHMiOjQzMSwidGxzIjoidGxzIiwidHlwZSI6ImR0bHMiLCJ2IjoiMiJ9"

    def extractor(source_name, source, progress_callback=None, event_callback=None):
        if event_callback:
            event_callback("extract_request_result", {"source_name": source_name, "success": True, "iteration": 1})
        return [vmess]

    def speedtester(links, config, runtime_path="", progress_callback=None, event_callback=None):
        if event_callback:
            event_callback("speedtest_selected", {"candidate_count": 1, "reachable_count": 1, "total_links": 1})
        return [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120)
        ]

    def availability_checker(results, config, runtime_path="", progress_callback=None, event_callback=None):
        if event_callback:
            event_callback("availability_link_result", {"link": results[0].link, "all_passed": True})
        return [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={
                    "gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok"),
                    "chatgpt": ProviderCheckResult(provider="chatgpt", passed=True, reason="ok"),
                    "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
                },
            )
        ]

    controller = PipelineController(
        extractor=extractor,
        speedtester=speedtester,
        availability_checker=availability_checker,
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    summary = controller.run(
        profile,
        skip_deploy=True,
        skip_verify=True,
        event_callback=lambda event_type, payload: events.append({"type": event_type, **payload}),
    )

    assert summary.stage_status["obfuscate"] == "success"
    assert "extract_request_result" in {event["type"] for event in events}
    assert "speedtest_selected" in {event["type"] for event in events}
    assert "availability_link_result" in {event["type"] for event in events}


def test_pipeline_streams_speedtest_before_extract_finishes(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    catch_root = tmp_path / "vpn-catch-nodes" / "config"
    edge_root = tmp_path / "cloudflarevpn" / "edgetunnel"
    catch_root.mkdir(parents=True)
    edge_root.mkdir(parents=True)
    (catch_root / "vpn_api.json").write_text("{}", encoding="utf-8")
    (edge_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.workspace.vpn_catch_nodes_root = str(tmp_path / "vpn-catch-nodes")
    profile.workspace.edgetunnel_root = str(edge_root)
    profile.workspace.artifacts_root = str(project_root / "artifacts")
    profile.sources = {"leiting": profile.sources["leiting"]}
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"

    speedtest_started = threading.Event()
    saw_speedtest_before_return = {"value": False}

    def extractor(source_name, source, progress_callback=None, raw_link_callback=None, **kwargs):
        assert raw_link_callback is not None
        raw_link_callback(source_name, VMESS_LINK)
        saw_speedtest_before_return["value"] = speedtest_started.wait(timeout=0.5)
        return [VMESS_LINK]

    def speedtester(links, config, runtime_path="", progress_callback=None, event_callback=None):
        speedtest_started.set()
        return [SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.5, latency_ms=50)]

    controller = PipelineController(
        extractor=extractor,
        speedtester=speedtester,
        availability_checker=lambda results, config, runtime_path="", progress_callback=None, event_callback=None, targets=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={"gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok")},
            )
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    summary = controller.run(profile, skip_deploy=True, skip_verify=True)

    assert saw_speedtest_before_return["value"] is True
    assert summary.stage_status["dedupe"] == "success"
    assert summary.counts["deduped_links"] == 1
    assert summary.source_counts["leiting"]["deduped_links"] == 1


def test_pipeline_reports_per_source_deduped_counts(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    edge_root = tmp_path / "cloudflarevpn" / "edgetunnel"
    edge_root.mkdir(parents=True)
    (edge_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.workspace.edgetunnel_root = str(edge_root)
    profile.sources = {
        "leiting": profile.sources["leiting"],
        "heidong": profile.sources["heidong"],
    }
    profile.sources["leiting"].url = "https://a.example/api"
    profile.sources["leiting"].key = "key-a"
    profile.sources["heidong"].url = "https://b.example/api"
    profile.sources["heidong"].key = "key-b"

    payload = parse_vmess_link(VMESS_LINK)
    alternate_payload = {**payload, "add": "2.2.2.2", "ps": "US node 2"}
    alternate_link = generate_vmess_link(alternate_payload)

    def extractor(source_name, source, progress_callback=None, **kwargs):
        if source_name == "leiting":
            return [VMESS_LINK]
        return [VMESS_LINK, alternate_link]

    controller = PipelineController(
        extractor=extractor,
        speedtester=lambda links, config, runtime_path="", progress_callback=None, event_callback=None: [
            SpeedTestResult(link=link, reachable=True, average_download_mb_s=2.5, latency_ms=50)
            for link in links
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None, event_callback=None, targets=None: [
            AvailabilityResult(
                speed_result=result,
                provider_results={"gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok")},
            )
            for result in results
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    summary = controller.run(profile, skip_deploy=True, skip_verify=True)

    assert summary.counts["deduped_links"] == 2
    assert summary.source_counts["leiting"]["deduped_links"] == 1
    assert summary.source_counts["heidong"]["deduped_links"] == 1


def test_pipeline_prunes_old_artifacts_after_new_run(tmp_path: Path, isolated_runtime_root: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifacts_root = isolated_runtime_root / "artifacts"
    old_first = artifacts_root / "20260420-010101"
    old_second = artifacts_root / "20260421-010101"
    edge_root = tmp_path / "cloudflarevpn" / "edgetunnel"
    old_first.mkdir(parents=True)
    old_second.mkdir(parents=True)
    edge_root.mkdir(parents=True)
    (old_first / "keep.txt").write_text("old", encoding="utf-8")
    (old_second / "keep.txt").write_text("old", encoding="utf-8")
    (edge_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")
    os.utime(old_second, (4102444800, 4102444800))

    profile = create_default_profile(project_root)
    profile.workspace.edgetunnel_root = str(edge_root)
    profile.workspace.artifacts_root = str(artifacts_root)
    profile.sources = {"leiting": profile.sources["leiting"]}
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"

    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None, raw_link_callback=None, **kwargs: [VMESS_LINK],
        speedtester=lambda links, config, runtime_path="", progress_callback=None, event_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.5, latency_ms=50)
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None, event_callback=None, targets=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={"gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok")},
            )
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
        now_factory=lambda: __import__("datetime").datetime(2026, 4, 26, 12, 0, 0),
    )

    summary = controller.run(profile, skip_deploy=True, skip_verify=True)

    assert sorted(path.name for path in artifacts_root.iterdir()) == [Path(summary.artifact_dir).name]


def test_pipeline_passes_profile_availability_targets(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    edge_root = tmp_path / "cloudflarevpn" / "edgetunnel"
    edge_root.mkdir(parents=True)
    (edge_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.workspace.edgetunnel_root = str(edge_root)
    profile.workspace.artifacts_root = str(project_root / "artifacts")
    profile.sources = {"leiting": profile.sources["leiting"]}
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"
    profile.availability_targets = {
        "gemini": AvailabilityTargetConfig(url="https://gemini.example/", enabled=False),
        "tmailor": AvailabilityTargetConfig(
            url="https://tmailor.example/",
            enabled=True,
            allowed_hosts=["tmailor.example"],
            negative_phrases=[],
        ),
    }
    captured_targets: list[str] = []

    def availability_checker(results, config, runtime_path="", progress_callback=None, event_callback=None, targets=None):
        captured_targets.extend(target.name for target in targets)
        return [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={"tmailor": ProviderCheckResult(provider="tmailor", passed=True, reason="ok")},
            )
        ]

    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None, raw_link_callback=None, **kwargs: [VMESS_LINK],
        speedtester=lambda links, config, runtime_path="", progress_callback=None, event_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.5, latency_ms=50)
        ],
        availability_checker=availability_checker,
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    controller.run(profile, skip_deploy=True, skip_verify=True)

    assert captured_targets == ["tmailor"]
