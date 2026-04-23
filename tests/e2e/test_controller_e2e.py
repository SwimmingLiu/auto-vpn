import sqlite3
from pathlib import Path

from vpn_automation.config.models import create_default_profile
from vpn_automation.pipeline.availability import AvailabilityResult, ProviderCheckResult
from vpn_automation.pipeline.controller import PipelineController
from vpn_automation.pipeline.speedtest import SpeedTestResult


def build_controller(project_root: Path, **kwargs) -> PipelineController:
    return PipelineController(
        runtime_root_resolver=lambda _candidate: project_root,
        artifacts_root_resolver=lambda root: root / "artifacts",
        template_path_resolver=lambda root: root / "templates" / "vmess_node.js",
        **kwargs,
    )


def test_pipeline_controller_runs_end_to_end_with_fake_services(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"

    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `old`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.sources = {
        "leiting": profile.sources["leiting"],
    }
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"

    vmess = "vmess://eyJhZGQiOiIxLjEuMS4xIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNCIsIm5ldCI6IndzIiwicGF0aCI6IlwvZm9vdGVycyIsInBvcnQiOjQ0MywicHMiOjQzMSwidGxzIjoidGxzIiwidHlwZSI6ImR0bHMiLCJ2IjoiMiJ9"
    vmess_2 = "vmess://eyJhZGQiOiIyLjIuMi4yIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNSIsIm5ldCI6IndzIiwicGF0aCI6IlwvYmFyIiwicG9ydCI6NDQzLCJwcyI6NDMyLCJ0bHMiOiJ0bHMiLCJ0eXBlIjoiZHRscyIsInYiOiIyIn0="

    controller = build_controller(
        project_root,
        extractor=lambda source_name, source, progress_callback=None: [vmess, vmess_2],
        speedtester=lambda links, config, xray_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120)
        ],
        availability_checker=lambda results, config, xray_path="", progress_callback=None: [
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
    run_db = Path(summary.artifact_dir) / "run.db"

    assert summary.stage_status["verify"] == "success"
    assert (Path(summary.artifact_dir) / "vpn_node_raw.txt").exists()
    assert (Path(summary.artifact_dir) / "vpn_api.runtime.json").exists()
    assert (Path(summary.artifact_dir) / "pages_bundle" / "_worker.js").exists()
    assert run_db.exists()

    with sqlite3.connect(run_db) as connection:
        raw_count = connection.execute("SELECT COUNT(*) FROM raw_links").fetchone()[0]
        speedtest_count = connection.execute("SELECT COUNT(*) FROM speedtest_results").fetchone()[0]
        availability_count = connection.execute("SELECT COUNT(*) FROM availability_results").fetchone()[0]
        final_count = connection.execute("SELECT COUNT(*) FROM final_links").fetchone()[0]

    assert raw_count == 2
    assert speedtest_count == 1
    assert availability_count == 3
    assert final_count == 1


def test_pipeline_controller_filters_links_when_any_provider_fails(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"

    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `old`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.sources = {
        "leiting": profile.sources["leiting"],
    }
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"

    vmess = "vmess://eyJhZGQiOiIxLjEuMS4xIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNCIsIm5ldCI6IndzIiwicGF0aCI6IlwvZm9vdGVycyIsInBvcnQiOjQ0MywicHMiOjQzMSwidGxzIjoidGxzIiwidHlwZSI6ImR0bHMiLCJ2IjoiMiJ9"

    controller = build_controller(
        project_root,
        extractor=lambda source_name, source, progress_callback=None: [vmess],
        speedtester=lambda links, config, xray_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120)
        ],
        availability_checker=lambda results, config, xray_path="", progress_callback=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={
                    "gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok"),
                    "chatgpt": ProviderCheckResult(provider="chatgpt", passed=False, reason="negative_phrase"),
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

    assert summary.counts["speedtest_links"] == 1
    assert summary.counts["availability_links"] == 0
