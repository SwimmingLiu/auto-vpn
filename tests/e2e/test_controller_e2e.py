from pathlib import Path

import pytest

from vpn_automation.config.models import create_default_profile
from vpn_automation.pipeline.availability import AvailabilityResult, ProviderCheckResult
from vpn_automation.pipeline.controller import PipelineController
from vpn_automation.pipeline.speedtest import SpeedTestResult


def test_pipeline_controller_runs_end_to_end_with_fake_services(tmp_path: Path) -> None:
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

    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None: [vmess, vmess],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120)
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
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        deployer=lambda bundle_dir, deploy_config, api_token: {"returncode": 0, "stdout": "ok", "stderr": ""},
        verifier=lambda deploy_config, api_token: {"secret_ok": True, "subscription_ok": True},
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    summary = controller.run(profile)

    assert summary.stage_status["verify"] == "success"
    assert (Path(summary.artifact_dir) / "vpn_node_raw.txt").exists()
    assert (Path(summary.artifact_dir) / "vpn_api.runtime.json").exists()
    assert (Path(summary.artifact_dir) / "pages_bundle" / "_worker.js").exists()
    assert summary.source_counts["leiting"]["raw_links"] == 2


def test_pipeline_controller_can_skip_deploy_and_verify(tmp_path: Path) -> None:
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

    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None: [vmess],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120)
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
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    summary = controller.run(profile, skip_deploy=True, skip_verify=True)

    assert summary.stage_status["obfuscate"] == "success"
    assert summary.stage_status["deploy"] == "skipped"
    assert summary.stage_status["verify"] == "skipped"


def test_pipeline_controller_filters_links_when_any_provider_fails(tmp_path: Path) -> None:
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
    vmess_2 = "vmess://eyJhZGQiOiIyLjIuMi4yIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNSIsIm5ldCI6IndzIiwicGF0aCI6IlwvYmFyIiwicG9ydCI6NDQzLCJwcyI6NDMyLCJ0bHMiOiJ0bHMiLCJ0eXBlIjoiZHRscyIsInYiOiIyIn0="

    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None: [vmess, vmess_2],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120),
            SpeedTestResult(link=links[1], reachable=True, average_download_mb_s=2.8, latency_ms=90),
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={
                    "gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok"),
                    "chatgpt": ProviderCheckResult(provider="chatgpt", passed=False, reason="negative_phrase"),
                    "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
                },
            ),
            AvailabilityResult(
                speed_result=results[1],
                provider_results={
                    "gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok"),
                    "chatgpt": ProviderCheckResult(provider="chatgpt", passed=True, reason="ok"),
                    "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
                },
            ),
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        deployer=lambda bundle_dir, deploy_config, api_token: {"returncode": 0, "stdout": "ok", "stderr": ""},
        verifier=lambda deploy_config, api_token: {"secret_ok": True, "subscription_ok": True},
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    summary = controller.run(profile)

    assert summary.counts["speedtest_links"] == 2
    assert summary.counts["availability_links"] == 1


def test_pipeline_controller_continues_when_one_source_extractor_fails(tmp_path: Path) -> None:
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
        "heidong": profile.sources["heidong"],
    }
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"
    profile.sources["heidong"].url = "https://example.com/api"
    profile.sources["heidong"].key = "abcdabcdabcdabcd"

    vmess = "vmess://eyJhZGQiOiIxLjEuMS4xIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNCIsIm5ldCI6IndzIiwicGF0aCI6IlwvZm9vdGVycyIsInBvcnQiOjQ0MywicHMiOjQzMSwidGxzIjoidGxzIiwidHlwZSI6ImR0bHMiLCJ2IjoiMiJ9"

    def extractor(source_name, source, progress_callback=None):
        if source_name == "heidong":
            raise RuntimeError("ssl eof")
        return [vmess]

    controller = PipelineController(
        extractor=extractor,
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120)
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
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        deployer=lambda bundle_dir, deploy_config, api_token: {"returncode": 0, "stdout": "ok", "stderr": ""},
        verifier=lambda deploy_config, api_token: {"secret_ok": True, "subscription_ok": True},
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    summary = controller.run(profile)

    assert summary.stage_status["verify"] == "success"
    assert summary.counts["raw_links"] == 1
    assert summary.source_counts["leiting"]["raw_links"] == 1
    assert summary.source_counts["heidong"]["raw_links"] == 0


def test_pipeline_controller_fails_fast_when_no_links_are_extracted(tmp_path: Path) -> None:
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

    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None: [],
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    with pytest.raises(RuntimeError, match="No links extracted"):
        controller.run(profile)


def test_pipeline_controller_fails_fast_when_no_links_pass_speedtest(tmp_path: Path) -> None:
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

    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None: [vmess],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=False, average_download_mb_s=0.0, latency_ms=0, error="timeout")
        ],
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    with pytest.raises(RuntimeError, match="No links passed speed test"):
        controller.run(profile)


def test_pipeline_controller_fails_fast_when_no_links_pass_availability(tmp_path: Path) -> None:
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

    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None: [vmess],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.0, latency_ms=10)
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={
                    "gemini": ProviderCheckResult(provider="gemini", passed=False, reason="blocked"),
                    "chatgpt": ProviderCheckResult(provider="chatgpt", passed=True, reason="ok"),
                    "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
                },
            )
        ],
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    with pytest.raises(RuntimeError, match="No links passed availability"):
        controller.run(profile)
