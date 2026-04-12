from pathlib import Path

from vpn_automation.config.models import create_default_profile
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
        speedtester=lambda links, config, xray_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120)
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
