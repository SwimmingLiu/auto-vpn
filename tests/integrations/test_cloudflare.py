from pathlib import Path

import requests

from vpn_automation.config.models import DeployConfig, WorkerBuildConfig
from vpn_automation.integrations.cloudflare import (
    CloudflareClient,
    build_pages_deploy_command,
    build_secret_url,
    deploy_pages_bundle,
    resolve_deploy_proxy_url,
)
from vpn_automation.pipeline.package import build_pages_bundle as build_pages_bundle_files
from vpn_automation.pipeline.worker_build import build_worker_artifacts


def test_build_pages_deploy_command_contains_project_name() -> None:
    command = build_pages_deploy_command(Path("/tmp/pages_bundle"), "sub-nodes")
    assert command[:4] == ["npx", "wrangler", "pages", "deploy"]
    assert "--project-name" in command
    assert "sub-nodes" in command
    assert "--branch" in command
    assert "main" in command


def test_build_secret_url_uses_pages_project_url_and_query() -> None:
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937",
        pages_project_url="https://sub-nodes.pages.dev",
        secret_query="serect_key=swimmingliu",
    )

    assert build_secret_url(deploy) == "https://sub-nodes.pages.dev/?serect_key=swimmingliu"


def test_build_pages_bundle_writes_modules_and_manifest(tmp_path) -> None:
    config = WorkerBuildConfig()
    rendered = Path("/Users/swimmingliu/data/VPN/vpn-subscription-automation/templates/vmess_node.js").read_text(
        encoding="utf-8"
    ).replace("__MAIN_DATA__", "payload")
    artifacts = build_worker_artifacts(rendered, config, "serect_key=swimmingliu")

    bundle_dir = build_pages_bundle_files("obfuscated", tmp_path / "pages_bundle", artifacts, config)

    assert (bundle_dir / "_worker.js").read_text(encoding="utf-8") == "obfuscated"
    assert (bundle_dir / "modules" / "guard.js").exists()
    assert (bundle_dir / "modules" / "payload.js").exists()
    assert (bundle_dir / "manifest.json").exists()


def test_verify_url_falls_back_to_curl_on_ssl_error(monkeypatch) -> None:
    client = CloudflareClient(api_token="token", account_id="account")

    def raise_ssl(*_args, **_kwargs):
        raise requests.exceptions.SSLError("ssl eof")

    monkeypatch.setattr(client.session, "get", raise_ssl)
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.run_command",
        lambda command, cwd=None, env=None: type(
            "Result",
            (),
            {"returncode": 0, "stdout": "ok", "stderr": ""},
        )(),
    )

    assert client.verify_url("https://sub-nodes.pages.dev/?serect_key=swimmingliu") is True


def test_deploy_pages_bundle_retries_direct_once_after_network_error(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260427-081718" / "pages_bundle"
    bundle_dir.mkdir(parents=True)
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937",
    )

    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr("vpn_automation.integrations.cloudflare.load_runtime_env", lambda _candidate: {})

    calls: list[dict[str, object]] = []
    results = iter(
        [
            type("Result", (), {"returncode": 1, "stdout": "", "stderr": "fetch failed\nUND_ERR_SOCKET"})(),
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
        ]
    )

    def fake_run(command, cwd=None, env=None):
        calls.append({"command": command, "cwd": cwd, "env": env or {}})
        return next(results)

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.run_command", fake_run)

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["returncode"] == 0
    assert result["project_name"] == "sub-nodes"
    assert result["bundle_dir"] == str(bundle_dir)
    assert result["worker_entry"] == str(bundle_dir / "_worker.js")
    assert result["module_manifest_path"] == str(bundle_dir / "manifest.json")
    assert len(calls) == 2
    assert "HTTP_PROXY" not in calls[0]["env"]
    assert "HTTP_PROXY" not in calls[1]["env"]


def test_deploy_pages_bundle_retries_with_proxy_after_network_error(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260427-081718" / "pages_bundle"
    bundle_dir.mkdir(parents=True)
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937",
    )

    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.load_runtime_env",
        lambda _candidate: {"VPN_AUTOMATION_DEPLOY_PROXY": "http://127.0.0.1:8080"},
    )

    calls: list[dict[str, object]] = []
    results = iter(
        [
            type("Result", (), {"returncode": 1, "stdout": "", "stderr": "fetch failed\nUND_ERR_SOCKET"})(),
            type("Result", (), {"returncode": 1, "stdout": "", "stderr": "fetch failed\nUND_ERR_SOCKET"})(),
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
        ]
    )

    def fake_run(command, cwd=None, env=None):
        calls.append({"command": command, "cwd": cwd, "env": env or {}})
        return next(results)

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.run_command", fake_run)

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["returncode"] == 0
    assert len(calls) == 3
    assert "HTTP_PROXY" not in calls[0]["env"]
    assert "HTTP_PROXY" not in calls[1]["env"]
    assert calls[2]["env"]["HTTP_PROXY"] == "http://127.0.0.1:8080"
    assert calls[2]["env"]["HTTPS_PROXY"] == "http://127.0.0.1:8080"
    assert calls[2]["env"]["ALL_PROXY"] == "http://127.0.0.1:8080"


def test_resolve_deploy_proxy_url_honors_explicit_off_override(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260427-081718" / "pages_bundle"
    bundle_dir.mkdir(parents=True)

    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:8080")
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.load_runtime_env",
        lambda _candidate: {"VPN_AUTOMATION_DEPLOY_PROXY": "off"},
    )

    assert resolve_deploy_proxy_url(bundle_dir) == ""
