import json
import threading
import time
from pathlib import Path

import pytest

from vpn_automation.config.models import create_default_profile
from vpn_automation.pipeline.availability import AvailabilityResult, ProviderCheckResult
from vpn_automation.pipeline.controller import PipelineController
from vpn_automation.pipeline.speedtest import SpeedTestResult


def test_pipeline_controller_exposes_named_stages() -> None:
    controller = PipelineController()
    assert controller.stage_names()[0] == "doctor"
    assert "deploy" in controller.stage_names()


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


def test_pipeline_controller_persists_failed_stage_status_to_report(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    catch_root = tmp_path / "vpn-catch-nodes" / "config"
    edge_root = tmp_path / "cloudflarevpn" / "edgetunnel"

    catch_root.mkdir(parents=True)
    edge_root.mkdir(parents=True)
    (catch_root / "vpn_api.json").write_text("{}", encoding="utf-8")
    (edge_root / "vmess_node.js").write_text("const MainData = `old`;", encoding="utf-8")

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

    artifact_dir = next((project_root / "artifacts").iterdir())
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
    (edge_root / "vmess_node.js").write_text("const MainData = `old`;", encoding="utf-8")

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
