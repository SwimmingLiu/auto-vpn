import sqlite3
from pathlib import Path

import pytest

from vpn_automation.config.models import create_default_profile
from vpn_automation.pipeline.availability import AvailabilityResult, ProviderCheckResult
from vpn_automation.pipeline.controller import PipelineController
from vpn_automation.pipeline.run_store import RunStore
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
    (template_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

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
    run_db = Path(summary.artifact_dir) / "run.db"

    assert summary.stage_status["verify"] == "success"
    assert (Path(summary.artifact_dir) / "vpn_node_raw.txt").exists()
    assert (Path(summary.artifact_dir) / "vpn_api.runtime.json").exists()
    assert (Path(summary.artifact_dir) / "pages_bundle" / "_worker.js").exists()
    assert run_db.exists()
    assert summary.source_counts["leiting"]["raw_links"] == 2

    with sqlite3.connect(run_db) as connection:
        raw_count = connection.execute("SELECT COUNT(*) FROM raw_links").fetchone()[0]
        speedtest_count = connection.execute("SELECT COUNT(*) FROM speedtest_results").fetchone()[0]
        availability_count = connection.execute("SELECT COUNT(*) FROM availability_results").fetchone()[0]
        final_count = connection.execute("SELECT COUNT(*) FROM final_links").fetchone()[0]

    assert raw_count == 2
    assert speedtest_count == 1
    assert availability_count == 3
    assert final_count == 1


def test_pipeline_controller_can_skip_deploy_and_verify(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"

    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

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
    template_root = project_root / "templates"

    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

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
    template_root = project_root / "templates"

    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

    profile = create_default_profile(project_root)
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

    controller = build_controller(
        project_root,
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


def test_pipeline_controller_resume_continues_extract_from_saved_iteration(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    artifact_dir = project_root / "artifacts" / "20260423-030303"
    template_root.mkdir(parents=True)
    artifact_dir.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.sources = {
        "leiting": profile.sources["leiting"],
    }
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"
    profile.sources["leiting"].max_iterations = 5
    vmess_seed = "vmess://eyJhZGQiOiIxLjEuMS4xIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNCIsIm5ldCI6IndzIiwicGF0aCI6IlwvZm9vdGVycyIsInBvcnQiOjQ0MywicHMiOjQzMSwidGxzIjoidGxzIiwidHlwZSI6ImR0bHMiLCJ2IjoiMiJ9"
    vmess_resumed = "vmess://eyJhZGQiOiIyLjIuMi4yIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNSIsIm5ldCI6IndzIiwicGF0aCI6IlwvYmFyIiwicG9ydCI6NDQzLCJwcyI6NDMyLCJ0bHMiOiJ0bHMiLCJ0eXBlIjoiZHRscyIsInYiOiIyIn0="

    run_store = RunStore(artifact_dir / "run.db")
    run_store.initialize(artifact_dir=str(artifact_dir))
    run_store.record_stage_event("doctor", "success")
    run_store.record_stage_event("extract", "running")
    run_store.record_source_progress(
        source_name="leiting",
        iteration=3,
        max_iterations=5,
        new_links=0,
        raw_links=1,
        successful_iterations=3,
        failed_iterations=0,
    )
    run_store.record_raw_link("leiting", vmess_seed)

    calls: list[int] = []

    def extractor(source_name, source, progress_callback=None, progress_state_callback=None, raw_link_callback=None, attempt_callback=None):
        calls.append(source.resume_from_iteration)
        if raw_link_callback:
            raw_link_callback(source_name, vmess_resumed)
        if progress_state_callback:
            progress_state_callback(
                source_name=source_name,
                iteration=4,
                max_iterations=5,
                new_links=1,
                raw_links=2,
                successful_iterations=1,
                failed_iterations=0,
            )
        return [vmess_resumed]

    controller = build_controller(
        project_root,
        extractor=extractor,
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120),
            SpeedTestResult(link=links[1], reachable=True, average_download_mb_s=2.5, latency_ms=80),
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

    resumed = controller.run(profile, resume_from=artifact_dir)

    assert calls == [4]
    assert resumed.counts["raw_links"] == 2


def test_pipeline_controller_fails_fast_when_no_links_are_extracted(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    profile.sources = {
        "leiting": profile.sources["leiting"],
    }
    profile.sources["leiting"].url = "https://example.com/api"
    profile.sources["leiting"].key = "abcdabcdabcdabcd"

    controller = build_controller(
        project_root,
        extractor=lambda source_name, source, progress_callback=None: [],
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    with pytest.raises(RuntimeError, match="No links extracted"):
        controller.run(profile)


def test_pipeline_controller_fails_fast_when_no_links_pass_speedtest(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

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
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=False, average_download_mb_s=0.0, latency_ms=0, error="timeout")
        ],
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )

    with pytest.raises(RuntimeError, match="No links passed speed test"):
        controller.run(profile)


def test_pipeline_controller_fails_fast_when_no_links_pass_availability(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")

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
